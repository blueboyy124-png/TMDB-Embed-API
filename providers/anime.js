const axios = require('axios');
const { getDetails } = require('../utils/tmdb');
const anilist = require('../utils/anilist');
const episodeNumbering = require('../utils/episodeNumbering');

/*
 * Anime provider.
 *
 * What this file does (all of it is metadata, no site is contacted for video):
 *   - turns TMDB "season N, episode M" into the absolute episode number anime sites use
 *   - finds the matching AniList entry (id, MAL id, episode count)
 *   - asks the registered SOURCES for real media links, throws away anything that is not
 *     a playable stream, and labels what is left honestly (real quality, year, episode)
 *
 * What it does NOT do: invent links. A player page (an embed URL) is an HTML document, not a video,
 * and the browser player cannot use it. If no source returns a real .m3u8/.mp4, this provider returns [].
 *
 * Sources registered at the bottom of this file. None of them is behind Cloudflare:
 *   - vidsrc  : reads the server-side rendered server list and resolves each server. Good coverage on the
 *               seasons it indexes, and several verified mirrors per episode.
 *   - anixo   : the broadest one. Reached in three plain requests and returns 1080p HLS, which is what
 *               covers the long-runner and later-season episodes vidsrc does not carry.
 *   - 2embed  : four-hop chain ending in a packed script. Currently 404s for most titles; kept as a
 *               third independent host in case it recovers.
 *
 * The sources run concurrently and stack, so a title usually ends up with several mirrors. Both real
 * sources cache briefly, because their upstream lists flap between backends and a working episode should
 * not randomly come back empty.
 *
 * To add a source, push a function into SOURCES (or call registerAnimeSource from another file):
 *   async ({ title, altTitles, year, season, episode, abs, movie, anilist }) => [
 *     { url: 'https://.../master.m3u8', quality: '1080p', label: 'MySource', headers: { Referer: '...' } }
 *   ]
 * `season`/`episode` are what was asked for (either TMDB numbering, or season 1 + absolute number when the
 * client is in absolute mode). `abs` is the absolute number, or null when it cannot be worked out reliably.
 */

const SOURCES = [];
function registerAnimeSource(fn) { if (typeof fn === 'function') SOURCES.push(fn); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MEDIA = /\.(m3u8|mp4|mkv|webm)(\?|#|$)/i;
let warned = false;

// TMDB splits long anime into one season per saga; anime sources count 1..N straight through.
// The arithmetic lives in utils/episodeNumbering.js so the stream lookup and the metadata endpoint cannot
// drift apart; see that file for the two numbering schemes this has to cope with.
// Returns null when TMDB lacks an episode count for an earlier season, because a guess would play the wrong
// episode -- for an anime lookups that is worse than returning no streams.
function absoluteEpisode(details, season, episode) {
    const seasonNo = Number(season) || 1;
    const epNo = Number(episode) || 1;
    // Nothing precedes season 1, so its absolute number is trivially the episode number -- true even when
    // TMDB gives us no season list at all.
    if (seasonNo <= 1) return epNo;
    const counts = episodeNumbering.countsFromSeasons(details && details.seasons);
    const offset = episodeNumbering.absoluteOffset(counts, seasonNo);
    if (offset == null) return null;
    return offset + epNo;
}

// ---- Source 1: vidsrc.buzz ----------------------------------------------------------------------
// No Cloudflare here, and the player page carries its server list server-side rendered, so this is
// reliable. Three things are done here that a single lookup would miss:
//   1. the SSR list is only a first page (ssr.more === true), so the sources endpoint is polled
//      with &pf=1 to collect further servers. Each poll returns a different slice, which is how a
//      title ends up with several independent mirrors instead of one.
//   2. every server is resolved and then verified with isRealStream(), so captcha gates and dead
//      hosts are dropped rather than handed to the player.
//   3. empty results are retried, because the server list is served from more than one backend and
//      a given episode intermittently comes back with no servers at all.
const VIDSRC = 'https://vidsrc.buzz';
const VIDSRC_POLLS = 3;      // how many slices of the server list to collect (each poll is a different slice)
const VIDSRC_SERVERS = 6;    // how many of those to resolve (each costs one request, plus one more if it fails)
const VIDSRC_TRIES = 2;      // a single upstream can 502 while its siblings are fine
const VIDSRC_PLAY_TIMEOUT = 4000;  // a dead upstream stalls for ~8s; do not spend that on every server
const VIDSRC_CONCURRENCY = 3;      // the host throttles badly past this and starts failing everything

// Small fixed-width queue: a whole burst of requests at once makes vidsrc stall and then 502, which is
// far worse than doing a couple at a time. Results keep input order.
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
        }
    });
    await Promise.all(workers);
    return out;
}

// Caching resolved results is the single biggest reliability win here: the upstream list flaps between
// backends, so the same episode can answer with servers on one call and none on the next. Serving the
// last good answer for a short while keeps a working title from randomly returning nothing.
// Capped: keyed by anime id + episode, and this provider is asked about a lot of episodes; a per-episode
// entry that is never read again used to sit in the heap indefinitely.
const { BoundedTtlCache } = require('../utils/boundedCache');
const linkCache = new BoundedTtlCache(2000);
const LINK_TTL = 10 * 60 * 1000;
const NEG_TTL = 45 * 1000;   // an empty answer is usually a flap, not a real gap: re-check it soon

async function sourceVidsrc(ctx) {
    if (!ctx.tmdbId) return [];
    const path = ctx.movie ? `movie/${ctx.tmdbId}` : `tv/${ctx.tmdbId}/${ctx.season}/${ctx.episode}`;
    const ref = `${VIDSRC}/embed/${path}`;
    const apiHeaders = { Referer: ref, 'X-Requested-With': 'XMLHttpRequest' };

    const cacheKey = path;
    const hit = linkCache.get(cacheKey);
    if (hit && Date.now() - hit.t < (hit.v.length ? LINK_TTL : NEG_TTL)) return hit.v;

    let html = '';
    for (let attempt = 1; attempt <= 2 && !html; attempt++) {
        try { html = await getText(ref); } catch { await sleep(400 * attempt); }
    }
    if (!html) return hit ? hit.v : [];

    // The page embeds its own config as a JSON literal (Q = { ... }); read it rather than scraping ids out of URLs.
    const q = readConfig(html);
    if (!q) return hit ? hit.v : [];

    // Collect servers from the embedded first page plus extra polled slices, keeping order stable.
    const refs = new Map();
    const addServers = list => (list || []).forEach(s => { if (s?.ref && !refs.has(s.ref)) refs.set(s.ref, s.name || ''); });
    addServers(q.ssr?.servers);
    const qs = q.id != null ? `type=${q.type}&id=${encodeURIComponent(q.id)}&s=${q.s}&e=${q.e}&t=${encodeURIComponent(q.t ?? '')}` : null;
    if (qs) {
        const slices = await mapLimit(Array.from({ length: VIDSRC_POLLS - 1 }, (_, k) => k), VIDSRC_CONCURRENCY, async () => {
            try { return (await getJson(`${VIDSRC}/pl/api.php?a=sources&${qs}&pf=1`, apiHeaders))?.servers; }
            catch { return null; }   // an extra slice is optional, never fatal
        });
        slices.forEach(addServers);
    }

    // The upstream has no entry for some episodes (no servers at all, in any slice). That is a content gap
    // rather than a fetch failure, so remember it briefly and do not re-ask on every single call.
    if (!refs.size) {
        linkCache.set(cacheKey, { v: [], t: Date.now() });
        return [];
    }

    // Resolve the collected servers a few at a time: a dead one costs seconds, and firing every request at
    // once makes the host stall and 502 across the board.
    const resolved = await mapLimit([...refs].slice(0, VIDSRC_SERVERS), VIDSRC_CONCURRENCY, async ([sref, name]) => {
        let url = null;
        // A single upstream can sit at 502 while its siblings are fine, so give each server two goes.
        for (let attempt = 1; attempt <= VIDSRC_TRIES && !url; attempt++) {
            try {
                const play = await getJson(`${VIDSRC}/pl/api.php?a=play&ref=${encodeURIComponent(sref)}`, apiHeaders, VIDSRC_PLAY_TIMEOUT);
                url = typeof play?.url === 'string' ? play.url.replace(/\\\//g, '/') : null;
            } catch (e) {
                if (attempt === VIDSRC_TRIES && process.env.ANIME_DEBUG) console.log('[Anime] server still failing:', name, (e.message || '').slice(0, 50));
                if (attempt < VIDSRC_TRIES) await sleep(350);
            }
        }
        return { name, url };
    });

    const out = [];
    for (const { name, url } of resolved) {
        if (!url) continue;
        let full = url;
        if (full.startsWith('/')) full = VIDSRC + full;                    // real stream, relative to the host
        else if (/cap\.php/i.test(full)) continue;                          // captcha gate: not a video
        else if (!/\.m3u8(\?|#|$)/i.test(full)) continue;
        out.push({ url: full, quality: 'Auto', label: `VidSrc ${name}`.trim(), headers: { Referer: ref } });
    }

    // Only cache a real answer. A run of dead upstreams should be retried next time, not remembered.
    if (out.length) linkCache.set(cacheKey, { v: out, t: Date.now() });
    else if (hit) linkCache.set(cacheKey, { v: hit.v, t: Date.now() });   // refresh the last good answer
    return out.length ? out : (hit ? hit.v : []);
}

// ---- Source 2: anixo.buzz -----------------------------------------------------------------------
// This is the broadest source here, and the one that covers the episodes vidsrc does not carry.
// It takes three plain requests, no Cloudflare and no captcha anywhere:
//   1. GET /embed/ani/{anilistId}/{episode}/{track}  -> player page carrying a short-lived ticket
//   2. GET /api/stream/resolve?... sent with that     -> { streamUrl, server, fallbackStreams[] }
//      ticket as an x-embed-ticket header
//   3. GET streamUrl                                  -> a real HLS master (#EXTM3U, 1080p + 360p)
// The ticket is minted per request and is time limited, so step 1 is repeated per lookup rather than cached.
const ANIXO = 'https://anixo.buzz';
const ANIXO_SERVERS = [1, 2, 3, 4];   // each is a different CDN, so more of them is more redundancy
const ANIXO_TRACKS = ['sub', 'dub'];
// anixo 2, not more. Measured over four runs of the same 8 (track, server) pairs:
//   serial (limit 1): ~6.0-7.3s, 16/16 links   -- what this replaced
//   limit 2         : ~2.7-3.2s, 16/16 links   <- what this uses
//   limit 4         : ~1.1-1.6s,  7-11 links   -- anixo answers HTTP 429 and drops mirrors
// A faster source that returns half the mirrors is a worse outcome, so this is deliberately not pushed higher.
const ANIXO_CONCURRENCY = 2;

async function sourceAnixo(ctx) {
    // This source is episode based. A movie has no episode to ask for, so say so instead of returning nothing quietly.
    if (ctx.movie || !ctx.anilist?.id) return [];
    // Anime sites number flat, so ask for the absolute episode where we have one. ctx.abs is deliberately
    // left null when it cannot be worked out from TMDB, in which case fall back to the number asked for.
    const ep = ctx.abs || ctx.episode;
    if (!ep) return [];

    const cacheKey = `anixo:${ctx.anilist.id}:${ep}`;
    const hit = linkCache.get(cacheKey);
    if (hit && Date.now() - hit.t < (hit.v.length ? LINK_TTL : NEG_TTL)) return hit.v;

    const out = [];
    const seen = new Set();
    // ★ INTEGRATION NOTE F — anixo's embed ticket is SINGLE USE.
    // Verified: calling /api/stream/resolve twice with the same ticket gives 200 then 403.
    // So each (track, server) pair needs its OWN freshly minted ticket from a fresh page load.
    // Reusing one ticket silently limits you to a single server, which looks like it works
    // (you still get its fallbackStreams) but gives no real redundancy.
    const freshTicket = async track => {
        try {
            const page = await getText(`${ANIXO}/embed/ani/${ctx.anilist.id}/${ep}/${track}`);
            return page.match(/const ticket\s*=\s*"([^"]+)"/)?.[1] || null;
        } catch (e) {
            if (process.env.ANIME_DEBUG) console.log('[Anime] anixo page failed:', e.message.slice(0, 50));
            return null;
        }
    };

    // Phase 1, one ticket per track. A track with no ticket has no stream at any server, so this is the cheap
    // way to answer "is this episode here at all": two requests, and a title anixo does not index (which is
    // common -- e.g. Attack on Titan S2) costs those two instead of the whole sweep below.
    const probes = await mapLimit(ANIXO_TRACKS, ANIXO_CONCURRENCY, async track => ({ track, ticket: await freshTicket(track) }));
    // Phase 2, the live tracks only. This used to be `for track { for server { page; resolve } }`, i.e. sixteen
    // round trips one after another, and it was the slowest thing in the entire API (13-27s for one episode
    // while every other source sat idle). The pairs are independent -- each mints its own ticket -- so they run
    // a few at a time instead. The phase-1 ticket for a track is not wasted: it serves that track's first
    // server, since a ticket is only consumed by the resolve call that uses it.
    const pairs = [];
    for (const { track, ticket } of probes) {
        if (!ticket) continue;   // no ticket for this track: no stream for this episode, do not hammer it
        ANIXO_SERVERS.forEach((server, i) => pairs.push({ track, server, ticket: i === 0 ? ticket : null }));
    }
    const perPair = await mapLimit(pairs, ANIXO_CONCURRENCY, async ({ track, server, ticket }) => {
        const t = ticket || await freshTicket(track);
        if (!t) return [];
        try {
            const q = `anilistId=${ctx.anilist.id}&episode=${ep}&track=${track}&server=${server}`
                + (ctx.anilist.idMal ? `&malId=${ctx.anilist.idMal}` : '');
            const data = await getJson(`${ANIXO}/api/stream/resolve?${q}`, { Referer: `${ANIXO}/`, 'x-embed-ticket': t });
            if (!data?.streamUrl) return [];
            const label = `AniXo ${data.server || 'S' + server} ${track}`.trim();
            // The primary and its fallbacks are independent mirrors, so offer all of them.
            // `track` is declared rather than left for someone to parse back out of `label`: it is the audio
            // track (sub = Japanese original, dub = English) and utils/streamMeta.js turns it into a language.
            // These mirrors are byte-identical apart from the ticket, so they are not de-duplicated by URL.
            return [data.streamUrl, ...(data.fallbackStreams || [])]
                .filter(Boolean)
                .map(url => ({ url, quality: 'Auto', label, track, headers: { Referer: `${ANIXO}/` } }));
        } catch { return []; }   // that server is dead, the others still answer
    });

    // Flattened in the order the pairs were listed (mapLimit keeps input order), so the mirror list does not
    // shuffle between calls the way completion order would.
    for (const links of perPair) {
        for (const l of links || []) {
            if (seen.has(l.url)) continue;
            seen.add(l.url);
            out.push(l);
        }
    }

    if (out.length) linkCache.set(cacheKey, { v: out, t: Date.now() });
    else if (hit) linkCache.set(cacheKey, { v: hit.v, t: Date.now() });   // refresh the last good answer
    return out.length ? out : (hit ? hit.v : []);
}

// ---- Source 3: 2embed -> 2vcdn ------------------------------------------------------------------
// Kept because it is a second independent host, but its player currently 404s for most titles and its
// CDN refused us earlier, so in practice this source returns nothing. It costs one request.
const TWO_EMBED = 'https://www.2embed.skin';
async function source2embed(ctx) {
    if (!ctx.tmdbId) return [];
    const path = ctx.movie ? `movie/${ctx.tmdbId}` : `tv/${ctx.tmdbId}?s=${ctx.season}&e=${ctx.episode}`;
    const page = await getText(`${TWO_EMBED}/${path}`);
    const embed = page.match(/<iframe[^>]*src="([^"]+)"/i)?.[1];
    if (!embed) return [];
    const embedHtml = await getText(embed.startsWith('http') ? embed : TWO_EMBED + embed, { Referer: `${TWO_EMBED}/` });
    const swish = embedHtml.match(/streamsrcs\.2embed\.cc\/swish\?id=([a-z0-9]+)/i)?.[1];
    if (!swish) return [];
    const swishHtml = await getText(`https://streamsrcs.2embed.cc/swish?id=${swish}`, { Referer: `${TWO_EMBED}/` });
    const inner = swishHtml.match(/id="framesrc"[\s\S]*?src="([^"]+)"/i)?.[1];
    if (!inner) return [];
    const player = await getText(`https://2vcdn.skin/e/${inner}`, { Referer: 'https://streamsrcs.2embed.cc/' });
    const js = unpackPacker(player);
    if (!js) return [];
    const q = player.match(/\b(2160p|1080p|720p|480p|360p)\b/i)?.[1] || 'Auto';
    const urls = [...new Set([...js.matchAll(/https?:\/\/[^"'\s\\<>\\]+\.m3u8[^"'\s\\<>\\]*/gi)].map(m => m[0]))];
    return urls.map(url => ({ url, quality: q, label: '2embed', headers: { Referer: 'https://2vcdn.skin/' } }));
}

// Delegates to the shared service (utils/anilist.js) so this provider and the /api/metadata endpoint agree
// on which AniList entry a title is, and so the lookup is cached and single-flighted across both. It also
// now gets the rich fields (titles, description, artwork) rather than just an id, which is what the
// metadata layer needs and what the sources below can use for better labels.
async function findAniList(titles, year, tmdbId, isTv) {
    if (tmdbId) {
        const viaId = await anilist.getForTmdb(isTv === false ? 'movie' : 'tv', tmdbId);
        if (viaId) return viaId;
    }
    // No TMDB id, or no match through it: fall back to matching on the title spellings.
    return anilist.findByTitles(titles, year, { prefer: isTv === false ? 'movie' : 'series' });
}

// ---- fetches shared by the sources below --------------------------------------------------------
// These hosts answer 403 to axios on the api.php calls even with identical headers, so use global
// fetch here; isRealStream() below still uses axios and is unaffected (it only ever sees media URLs).
// A dead upstream can hold a connection open for ~8s, so callers pass a shorter budget when a slow
// answer is not worth waiting for.
const TIMEOUT = 10000;
async function getText(url, headers = {}, timeout = TIMEOUT) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal, redirect: 'follow' });
        if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
        return await r.text();
    } finally { clearTimeout(timer); }
}
async function getJson(url, headers = {}, timeout = TIMEOUT) {
    const txt = await getText(url, headers, timeout);
    try { return JSON.parse(txt); } catch { throw new Error('not JSON'); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The player page inlines its config as a JSON literal ("Q = { ... };"). Parse it by brace matching so a
// nested object (ssr, servers, ...) does not truncate the value, instead of scanning for the first "};".
function readConfig(html) {
    const i = html.indexOf('Q = {');
    if (i === -1) return null;
    const start = i + 4;
    let depth = 0, inStr = false, esc = false;
    for (let j = start; j < html.length; j++) {
        const ch = html[j];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, j + 1)); } catch { return null; } } }
    }
    return null;
}

// 2embed keeps the real manifest inside a Dean Edwards packed <script>, so unpack it instead of
// guessing. Returns the plain source text, or null when the page shape changed.
function unpackPacker(html) {
    const scripts = [...String(html).matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    const packed = scripts.find(s => s.includes('eval(function(p,a,c,k'));
    if (!packed) return null;
    const m = packed.match(/'([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
    if (!m) return null;
    let out = m[1]; const a = +m[2], c = +m[3], k = m[4].split('|');
    for (let i = c - 1; i >= 0; i--) if (k[i]) out = out.replace(new RegExp('\\b' + i.toString(a) + '\\b', 'g'), k[i]);
    return out;
}

// A link is only worth returning if it really is a stream. HTML pages, JSON error bodies and dead links are dropped here.
// Some hosts serve HLS from an extensionless endpoint (vidsrc's /_stream?id=...), so those are probed as well and
// only kept when the body really is a manifest.
async function isRealStream(link) {
    if (!link || typeof link.url !== 'string' || !/^https?:\/\//i.test(link.url)) return false;
    const extensionless = !MEDIA.test(link.url);
    if (!extensionless && !/\.(m3u8|mp4|mkv|webm)(\?|#|$)/i.test(link.url)) return false;
    try {
        const headers = { 'User-Agent': UA, ...(link.headers || {}) };
        if (/\.m3u8(\?|#|$)/i.test(link.url) || extensionless) {
            const r = await axios.get(link.url, { headers, timeout: 7000, responseType: 'text', maxContentLength: 2e6, validateStatus: s => s === 200 });
            return typeof r.data === 'string' && r.data.trimStart().startsWith('#EXTM3U');
        }
        const r = await axios.get(link.url, { headers: { ...headers, Range: 'bytes=0-1' }, timeout: 7000, responseType: 'arraybuffer', validateStatus: s => s === 200 || s === 206 });
        const type = String(r.headers['content-type'] || '');
        return !/text\/html|json/i.test(type);
    } catch { return false; }
}

async function getAnimeStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    if (!SOURCES.length) {
        if (!warned) { warned = true; console.log('[Anime] no stream source registered, returning nothing (see the comment at the top of providers/anime.js)'); }
        return [];
    }
    const isTv = mediaType === 'tv' || mediaType === 'series' || mediaType === 'anime';
    const season = isTv ? (seasonNum || 1) : null, episode = isTv ? (episodeNum || 1) : null;

    let details = null;
    try { details = await getDetails(isTv ? 'tv' : 'movie', tmdbId); } catch (err) { console.warn(`[Anime] TMDB lookup failed: ${err.message}`); }
    if (!details) return [];
    const title = details.title || details.name || '';
    const altTitles = [...new Set([title, details.original_title, details.original_name].filter(Boolean))];
    const year = String(details.release_date || details.first_air_date || '').slice(0, 4);
    if (!title) return [];

    const abs = isTv ? absoluteEpisode(details, season, episode) : null;
    // Named `al` rather than `anilist` so it does not shadow the imported module.
    const al = await findAniList(altTitles, year, tmdbId, isTv);
    const ctx = { tmdbId, title, altTitles, year, season, episode, abs, movie: !isTv, anilist: al };
    if (isTv && abs === null) { console.log(`[Anime] cannot work out the absolute number for S${season}E${episode} of "${title}", skipping`); return []; }

    // Label with the anime's own title when we have it: TMDB's name for a long anime is often the English
    // dub title, and the sites these links come from are indexed under the original.
    const shownTitle = (al && al.displayTitle) || title;
    const altName = (al && al.titles && al.titles.english && al.titles.english !== shownTitle) ? al.titles.english : null;
    const shown = [shownTitle, altName].filter(Boolean).join(' / ');

    const found = [];
    // Per-source timing is reported on the summary line below: the sources run concurrently, so when this
    // provider is slow the useful question is always "which host", and that used to need guesswork.
    const perSource = [];
    await Promise.all(SOURCES.map(async src => {
        const t = Date.now();
        try { for (const l of (await src(ctx)) || []) found.push(l); }
        catch (err) { console.warn(`[Anime] a source failed: ${err.message}`); }
        perSource.push(`${src.name || 'source'}:${Date.now() - t}ms`);
    }));

    const seen = new Set(), unique = found.filter(l => l && l.url && !seen.has(l.url) && seen.add(l.url));
    // Verify with a bounded pool, and only as many links as can realistically matter.
    //
    // This was `Promise.all` over every link found, i.e. up to ~20 simultaneous upstream probes per call, and
    // it was the provider still working when the aggregate's soft deadline fired. Multiplied by concurrent
    // users that is hundreds of in-flight requests, which saturates the upstream and the event loop. Twelve
    // verified links is more than any player needs to choose from; the rest are simply left unverified. The
    // source-level linkCache is unaffected either way -- it caches what the sources found, before this step.
    const MAX_VERIFY = 12;
    const VERIFY_CONCURRENCY = 4;
    const toVerify = unique.slice(0, MAX_VERIFY);
    const verified = await mapLimit(toVerify, VERIFY_CONCURRENCY, async l => ((await isRealStream(l)) ? l : null));
    const good = verified.filter(Boolean);
    if (unique.length > MAX_VERIFY) {
      console.log(`[Anime] verified ${MAX_VERIFY}/${unique.length} links (bounded pool; ${unique.length - MAX_VERIFY} unchecked)`);
    }
    console.log(`[Anime] "${title}" ${isTv ? `S${season}E${episode} (abs ${abs})` : 'movie'}: ${good.length}/${unique.length} links are real streams (${perSource.join(' ')})`);

    const tag = isTv ? ` S${season}E${episode}` : '';
    return good.map(l => ({
        name: `Anime | ${l.label || 'Source'}`,
        title: `${l.quality || 'Auto'} | ${shown}${year ? ` (${year})` : ''}${tag}`,
        url: l.url,
        quality: l.quality || 'Auto',
        provider: 'anime',
        // Carried so a client can label the episode without a second lookup.
        anilistId: al ? al.id : undefined,
        anilistEpisode: isTv ? abs : undefined,
        // Audio track as the source reported it. Only anixo states one; vidsrc and 2embed do not, and this
        // stays undefined for them rather than defaulting to a guess. utils/streamMeta.js maps it to a
        // language. The title above is replaced with the real episode name downstream, once TMDB is asked.
        track: l.track || undefined,
        headers: l.headers || {}
    }));
}

// Sources register themselves at load time. Order matters only for the log; the loop above runs
// them concurrently, so one host being blocked never stops the others from returning.
registerAnimeSource(sourceVidsrc);
registerAnimeSource(sourceAnixo);
registerAnimeSource(source2embed);

module.exports = { getAnimeStreams, registerAnimeSource, absoluteEpisode, _clearAnimeCache: () => linkCache.clear() };