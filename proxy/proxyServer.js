// Lightweight proxy/m3u8/segment/subtitle rewriting layer. thanks to https://github.com/cinepro-org/ for the original code.
// Adapted from external project (user supplied) to fit CommonJS style and existing config system.
// Provides conditional route registration via enableProxy flag.

const cors = require('cors');
const nodeFetch = require('node-fetch');
const { Readable } = require('stream');
const http = require('http');
const https = require('https');
const { baseUrlFromRequest } = require('../utils/publicUrl');
const { dispatcherFor, isAnixo, anixoFetch } = require('../utils/anixoAgent');

// One shared, bounded connection pool per upstream scheme.
//
// Why this matters with more than one user: node-fetch used a fresh socket per request with keep-alive
// effectively off, so N simultaneous viewers meant N concurrent sockets AND N full TLS handshakes. Past a
// few dozen that is where a server starts failing its own users -- upstream hosts rate-limit the burst, local
// ephemeral ports and file descriptors run out, and requests queue behind each other until they time out.
// That presents as "the site got glitchy with a few people watching".
//
// The caps are generous for a household/small server but bounded, and maxSockets queues rather than refusing,
// so a spike degrades into waiting instead of errors. `timeout` stops a dead upstream from holding a socket
// forever. DISABLE_KEEPALIVE=true restores the old per-request behaviour.
const KEEPALIVE = process.env.DISABLE_KEEPALIVE !== 'true';
const MAX_SOCKETS = Number(process.env.PROXY_MAX_SOCKETS) || 64;
// Short on purpose. Some origins (googleusercontent above all) close idle connections after a
// few seconds — sometimes the FIN is lost on this network, leaving a half-dead socket the pool
// still believes is alive. The next request that reuses it gets no response at all until the
// header timeout kills it: measured as a 16s time-to-first-byte where a fresh socket answered
// in ~1.3s. Reaping free sockets at 5s shrinks that poisoned window from ~15s to ~nothing;
// reuse for back-to-back segment requests (the case keep-alive exists for) still works.
const FREE_SOCKET_TIMEOUT_MS = 5000;
// NOTE: deliberately NO `timeout` on the agents. An http.Agent's `timeout` only *emits* a
// 'timeout' event; with nothing listening the request hangs indefinitely instead of failing.
// Deadlines live per-request in `upstreamFetch` below, where they can actually abort.
const agentOptions = { keepAlive: KEEPALIVE, maxSockets: MAX_SOCKETS, maxFreeSockets: 16, freeSocketTimeout: FREE_SOCKET_TIMEOUT_MS };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);
// node-fetch reads the agent per-request, so it is threaded through explicitly at each call site.
const agentFor = url => (String(url).startsWith('http://') ? httpAgent : httpsAgent);
// Last-resort agent for the player-facing retry: brand-new socket per request, so a wedged
// pooled connection can never be the reason the retry fails too.
const freshAgentFor = url => (String(url).startsWith('http://')
    ? new http.Agent({ keepAlive: false })
    : new https.Agent({ keepAlive: false }));

// Upstream fetch hygiene. All three guards exist because a single hung or leaked upstream
// request used to freeze video playback indefinitely (mpv waits on the proxy; the proxy waited
// on an upstream socket that would never answer):
//
//   1. Client aborts are fatal to the upstream request. mpv aborts constantly -- seeks, stall
//      recovery, row switches, quitting the app. Before this, an abort left the upstream
//      download running with its socket checked out of the pool forever; leaked far enough and
//      new requests to that origin stalled behind the wedged state until a server restart.
//   2. The header phase gets a hard deadline. A hung upstream (or a half-dead keep-alive
//      socket being reused) becomes an error in seconds instead of a forever-spinner.
//   3. The deadline clears the moment headers arrive, so long-running video streams are never
//      killed by it; mid-stream stalls are handled separately by the body-idle watchdog below.
const UPSTREAM_HEADER_TIMEOUT_MS = 15000;
// The player-facing routes try twice with different budgets. Attempt 1 usually lands on a
// pooled socket and must fail fast — this network loses the FIN on origin-closed idle
// connections, and a blackholed reuse would otherwise park the player for the full header
// deadline (measured: 16s where a fresh socket answered in ~1.3s). Attempt 2 runs on a
// fresh, non-pooled socket and gets the full budget.
const UPSTREAM_FAST_RETRY_MS = 5000;
const UPSTREAM_RETRY_TIMEOUT_MS = 10000;
// Best-effort accelerators (HEAD size preflight, 0-0 probe, tail warm-up) get a short leash:
// a healthy origin answers headers in ~1s, and stacking full-length deadlines on a dead host
// made the total failure time four phases long. These only make startup snappier -- if they
// time out, the main fetch still runs.
const UPSTREAM_ACCEL_TIMEOUT_MS = 6000;
// How long the upstream may go silent mid-stream before we cut the client. Cutting is a guaranteed
// fatal for native HLS (iPad/Safari): it does not resume a killed segment, it stops the show. So the
// leash is long enough to ride out a throttling origin, and configurable for hosts that stall harder.
const UPSTREAM_BODY_IDLE_TIMEOUT_MS = Number(process.env.PROXY_BODY_IDLE_TIMEOUT_MS) || 45000;

// Transport through global fetch (undici) rather than node-fetch. node-fetch rides Node's
// http/https stack, whose TLS fingerprint some upstreams (anixo/VidCloud) answer with a blanket
// 403 -- the identical request over undici is served normally. The undici Response is adapted to
// the node-fetch shape the call sites already use: ok/status/headers and text()/json()/arrayBuffer(),
// plus a Node Readable `body` (undici hands back a web ReadableStream) so .pipe()/.on()/.destroy()
// keep working unchanged.
async function undiciCompatFetch(url, opts) {
    // anixo ties its tokens to the client IP: it must ride the one kept-alive native socket (see utils/anixoAgent.js).
    if (isAnixo(url)) return anixoFetch(url, opts);
    const dispatcher = dispatcherFor(url);
    const resp = await fetch(url, dispatcher ? { ...opts, dispatcher } : opts);
    let nodeBody;
    return {
        ok: resp.ok,
        status: resp.status,
        statusText: resp.statusText,
        url: resp.url,
        headers: resp.headers,
        text: () => resp.text(),
        json: () => resp.json(),
        arrayBuffer: () => resp.arrayBuffer(),
        get body() {
            if (nodeBody === undefined) nodeBody = resp.body ? Readable.fromWeb(resp.body) : null;
            return nodeBody;
        },
    };
}

function upstreamFetch(url, opts = {}, { res = null, timeoutMs = UPSTREAM_HEADER_TIMEOUT_MS, agent = null } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('upstream header timeout')), timeoutMs);
    let detach = () => {};
    if (res) {
        // Client went away (abort, seek, quit): take the upstream down with it.
        const onClose = () => ac.abort(new Error('client closed'));
        res.on('close', onClose);
        detach = () => res.removeListener('close', onClose);
    }
    const request = undiciCompatFetch(url, { ...opts, signal: ac.signal });
    return request.finally(() => { clearTimeout(timer); detach(); });
}

const CACHE_MAX_SIZE = 2000;
// A count cap alone lets N concurrent viewers hold thousands of multi-MB segments for two hours. Cap
// the cache by total bytes too, so memory has a hard ceiling no matter how many people are watching.
const CACHE_MAX_BYTES = (Number(process.env.PROXY_SEGMENT_CACHE_MB) > 0 ? Number(process.env.PROXY_SEGMENT_CACHE_MB) : 256) * 1024 * 1024;
const CACHE_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours
const segmentCache = new Map();
let segmentCacheBytes = 0;

function deleteCachedSegment(url) {
    const e = segmentCache.get(url);
    if (!e) return;
    segmentCacheBytes = Math.max(0, segmentCacheBytes - (e.data ? e.data.byteLength : 0));
    segmentCache.delete(url);
}

function evictSegmentCacheToBudget() {
    while (segmentCacheBytes > CACHE_MAX_BYTES && segmentCache.size) {
        const oldest = segmentCache.keys().next().value;
        if (oldest === undefined) break;
        deleteCachedSegment(oldest);
    }
}

// Segment prefetch, bounded.
//
// A variant playlist lists every segment in the episode -- measured at 354 for One Piece S21E1. Serving it
// used to fire ALL of them at once (Promise.all over the whole list), and that saturated the upstream: the
// player's own request for the FIRST segment then queued behind 353 strangers and took 11.4s, where the same
// request on an idle server took 43ms. That gap is the "3-8 seconds of spinner before video" symptom.
//
// So: a small worker pool, a short head-only window (the start is all a player needs to begin), and a hard
// rule that a real request always wins the upstream. Background prefetch is a bonus, never a competitor.
const PREFETCH_CONCURRENCY = 2;   // deliberately small; these hosts throttle badly under load
const PREFETCH_HEAD_SEGMENTS = 4;  // only the first few segments matter for instant start
const prefetchQueue = [];
let prefetchActive = 0;
let realRequestsInFlight = 0;      // while > 0, prefetch workers stand down

// Track first open-ended (bytes=0-) range per target to clamp only once per TTL window
const openRangeClampMap = new Map();
const OPEN_RANGE_CLAMP_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Progressive open-ended growth tracking: keeps expanding bytes=0- served window.
const progressiveOpenMap = new Map(); // url -> { lastEnd, ts }
const PROGRESSIVE_OPEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PROGRESSIVE_OPEN_MAX = 2000;
// Tail prefetch cache: stores last N KB for quick tail range responses
const tailPrefetchMap = new Map(); // url -> { data: Buffer, start: number, end: number, size: number, ts: number }
const TAIL_PREFETCH_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TAIL_PREFETCH_MAX = 500;

function isCacheDisabled() {
    return process.env.DISABLE_CACHE === 'true';
}

function cleanupCache() {
    const now = Date.now();
    for (const [url, entry] of segmentCache.entries()) {
        if (now - entry.timestamp > CACHE_EXPIRY_MS) deleteCachedSegment(url);
    }
    if (segmentCache.size > CACHE_MAX_SIZE) {
        const entries = Array.from(segmentCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = entries.slice(0, segmentCache.size - CACHE_MAX_SIZE);
        toRemove.forEach(([u]) => deleteCachedSegment(u));
    }
    evictSegmentCacheToBudget();
    return segmentCache.size;
}
setInterval(cleanupCache, 30 * 60 * 1000).unref();

function cleanupClampMap() {
    const now = Date.now();
    for (const [url, ts] of openRangeClampMap.entries()) {
        if (now - ts > OPEN_RANGE_CLAMP_TTL_MS) openRangeClampMap.delete(url);
    }
}
setInterval(cleanupClampMap, 10 * 60 * 1000).unref();

function cleanupTailPrefetch() {
    const now = Date.now();
    for (const [url, entry] of tailPrefetchMap.entries()) {
        if (now - entry.ts > TAIL_PREFETCH_TTL_MS) tailPrefetchMap.delete(url);
    }
    if (tailPrefetchMap.size > TAIL_PREFETCH_MAX) {
        const excess = tailPrefetchMap.size - TAIL_PREFETCH_MAX;
        let i = 0;
        for (const url of tailPrefetchMap.keys()) { if (i++ >= excess) break; tailPrefetchMap.delete(url); }
    }
}
setInterval(cleanupTailPrefetch, 15 * 60 * 1000).unref();

// progressiveOpenMap had no cleanup at all: every unique segment URL that asked for bytes=0- added an
// entry for the life of the process. Harmless for one viewer, a slow leak with several.
function cleanupProgressiveOpen() {
    const now = Date.now();
    for (const [url, entry] of progressiveOpenMap.entries()) {
        if (!entry || now - (entry.ts || 0) > PROGRESSIVE_OPEN_TTL_MS) progressiveOpenMap.delete(url);
    }
    if (progressiveOpenMap.size > PROGRESSIVE_OPEN_MAX) {
        const excess = progressiveOpenMap.size - PROGRESSIVE_OPEN_MAX;
        let i = 0;
        for (const url of progressiveOpenMap.keys()) { if (i++ >= excess) break; progressiveOpenMap.delete(url); }
    }
}
setInterval(cleanupProgressiveOpen, 15 * 60 * 1000).unref();

// Last-known-good playlists. Native HLS (iPad/Safari) re-reads the media playlist during playback --
// continuously when a playlist lacks #EXT-X-ENDLIST, which many providers omit. Before this, every
// reload re-hit upstream and any transient failure (timeout, 429, 5xx) was answered with a JSON body,
// which native HLS cannot parse: one blip and the show stopped mid-playback. We now keep the last
// rewritten playlist and serve it while upstream is briefly unavailable (stale-while-error).
const playlistCache = new Map(); // key -> { text, ts }
const PLAYLIST_FRESH_MS = 3000;             // serve from memory without touching upstream for this long
const PLAYLIST_STALE_MS = 10 * 60 * 1000;   // ...but keep the last good copy this long to survive an outage
const PLAYLIST_CACHE_MAX = 500;

function getFreshPlaylist(key) {
    const e = playlistCache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > PLAYLIST_FRESH_MS) return null;
    return e.text;
}
function getStalePlaylist(key) {
    const e = playlistCache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > PLAYLIST_STALE_MS) { playlistCache.delete(key); return null; }
    return e.text;
}
function putPlaylist(key, text) {
    if (playlistCache.size >= PLAYLIST_CACHE_MAX) {
        const oldest = playlistCache.keys().next().value;
        if (oldest !== undefined) playlistCache.delete(oldest);
    }
    playlistCache.set(key, { text, ts: Date.now() });
}
setInterval(() => {
    const now = Date.now();
    for (const [k, e] of playlistCache.entries()) {
        if (now - e.ts > PLAYLIST_STALE_MS) playlistCache.delete(k);
    }
}, 15 * 60 * 1000).unref();

function sendPlaylist(res, text) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(text);
}

function getCachedSegment(url) {
    if (isCacheDisabled()) return null;
    const e = segmentCache.get(url);
    if (!e) return null;
    if (Date.now() - e.timestamp > CACHE_EXPIRY_MS) { deleteCachedSegment(url); return null; }
    return e;
}

// Pull one prefetched segment. Skipped entirely while a real request is in flight, and paused between
// fetches, so background work can never be what delays the video the user actually asked for.
async function prefetchSegment(url, headers) {
    if (isCacheDisabled()) return;
    if (segmentCache.size >= CACHE_MAX_SIZE || segmentCacheBytes >= CACHE_MAX_BYTES) return;
    const existing = segmentCache.get(url);
    if (existing && Date.now() - existing.timestamp <= CACHE_EXPIRY_MS) return;
    try {
        if (prefetchSuppressed()) return;                     // a real request outranks us
        const resp = await upstreamFetch(url, { headers: { 'User-Agent': DEFAULT_UA, ...headers } });
        if (!resp.ok) return;
        const data = new Uint8Array(await resp.arrayBuffer());
        const responseHeaders = {};
        resp.headers.forEach((v, k) => responseHeaders[k] = v);
        if (segmentCache.has(url)) deleteCachedSegment(url);
        segmentCache.set(url, { data, headers: responseHeaders, timestamp: Date.now() });
        segmentCacheBytes += data.byteLength;
        evictSegmentCacheToBudget();
    } catch (_e) { /* ignore */ }
}

// Queue the head of a playlist for background warming. Anything past PREFETCH_HEAD_SEGMENTS is not queued:
// the player only needs the start to begin, and fetching the tail speculatively is what caused the stall.
function prefetchHead(segmentUrls, headers) {
    if (isCacheDisabled() || !segmentUrls.length) return;
    for (const url of segmentUrls.slice(0, PREFETCH_HEAD_SEGMENTS)) {
        if (prefetchQueue.includes(url)) continue;
        prefetchQueue.push(url);
        if (prefetchQueue.length > PREFETCH_HEAD_SEGMENTS * 4) prefetchQueue.shift();  // bound memory
    }
    drainPrefetchQueue(headers);
}

async function drainPrefetchQueue(headers) {
    while (prefetchActive < PREFETCH_CONCURRENCY && prefetchQueue.length) {
        if (prefetchSuppressed()) { await sleep(120); continue; }   // yield to the player
        const url = prefetchQueue.shift();
        prefetchActive++;
        prefetchSegment(url, headers)
            .catch(() => undefined)
            .then(() => { prefetchActive--; });
    }
}

// Marks the start and end of a genuine client request, so prefetch can stand down while one is open.
// Clamped at zero and paired with a staleness reset: if a 'close' were ever missed, a permanently positive
// count would silently disable prefetching for the life of the process, which is far worse than a stale
// prefetch. Correctness of playback must not depend on this counter staying exact.
let realRequestStartedAt = 0;
function beginRealRequest() { realRequestsInFlight++; realRequestStartedAt = Date.now(); }
function endRealRequest() {
  realRequestsInFlight = Math.max(0, realRequestsInFlight - 1);
  if (realRequestsInFlight === 0) realRequestStartedAt = 0;
}
function prefetchSuppressed() {
  // A request that has been "in flight" for minutes is a leak, not a slow client.
  if (realRequestsInFlight > 0 && realRequestStartedAt && Date.now() - realRequestStartedAt > 30 * 1000) {
    realRequestsInFlight = 0;
    realRequestStartedAt = 0;
  }
  return realRequestsInFlight > 0;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));


const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// One structured line per proxy failure/mid-stream cut, so a "it randomly stopped" report can be
// matched to a host/phase instead of guessed at. Never throws.
function safeHost(u) { try { return new URL(u).host; } catch { return '?'; } }
function logProxyFailure(route, info) {
    try {
        console.log(`[proxy-failure] ${JSON.stringify({ route, at: new Date().toISOString(), rssMB: Math.round(process.memoryUsage().rss / 1048576), ...info })}`);
    } catch (_e) { /* logging must never throw */ }
}

function inferContentType(upstreamCT, targetUrl) {
    const bad = !upstreamCT || /application\/octet-stream/i.test(upstreamCT) || /application\/(x-)?zip/i.test(upstreamCT);
    if (!bad) return upstreamCT;
    if (/\.mkv(\?|$)/i.test(targetUrl)) return 'video/x-matroska';
    if (/\.mp4(\?|$)/i.test(targetUrl)) return 'video/mp4';
    if (/\.m3u8(\?|$)/i.test(targetUrl)) return 'application/vnd.apple.mpegurl';
    if (/\.ts(\?|$)/i.test(targetUrl)) return 'video/mp2t';
    return 'application/octet-stream';
}

function extractOriginalUrl(proxyUrl) {
    try {
        const url = new URL(proxyUrl);
        if (url.pathname.includes('/proxy/')) {
            const m = url.pathname.match(/\/proxy\/(.+)$/);
            if (m) {
                let decoded = decodeURIComponent(m[1]);
                while (decoded.includes('%2F')) {
                    try { decoded = decodeURIComponent(decoded); } catch { break; }
                }
                if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
                // If it's just a path (like Vidlink /proxy/wiwii/...), keep the full original URL
                return proxyUrl;
            }
        }
        if (url.searchParams.has('url')) return decodeURIComponent(url.searchParams.get('url'));
        const patterns = [
            /\/api\/[^/]+\/proxy\?url=(.+)$/,
            /\/proxy\?.*url=([^&]+)/,
            /\/stream\/proxy\/(.+)$/,
            /\/p\/(.+)$/
        ];
        for (const p of patterns) {
            const m = proxyUrl.match(p); if (m) return decodeURIComponent(m[1]);
        }
        return proxyUrl;
    } catch { return proxyUrl; }
}

function rewriteM3u8(content, targetUrl, baseProxyUrl, headers) {
    const lines = content.split('\n');
    const out = []; const segmentUrls = [];
    // Hosts like anixo serve variants and segments from the same extensionless path
    // (/api/stream/m3u8?t=...), so the URL alone cannot say which it is. The line above it can: a URI on
    // the line right after #EXT-X-STREAM-INF is another playlist, anything else on a bare line is media.
    let afterVariantTag = false;
    for (const line of lines) {
        if (line.startsWith('#')) {
            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                afterVariantTag = true;
                out.push(line);
            } else if (line.startsWith('#EXT-X-KEY:')) {
                const regex = /https?:\/\/[^""\s]+/g; const keyUrl = regex.exec(line)?.[0];
                if (keyUrl) {
                    const proxyUrl = `${baseProxyUrl}/ts-proxy?url=${encodeURIComponent(keyUrl)}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
                    out.push(line.replace(keyUrl, proxyUrl));
                    if (!isCacheDisabled()) prefetchSegment(keyUrl, headers);
                } else out.push(line);
            } else if (line.startsWith('#EXT-X-MEDIA:') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
                const uriMatch = line.match(/URI="([^"]+)"/);
                if (uriMatch) {
                    try {
                        const mediaUrl = new URL(uriMatch[1], targetUrl).href;
                        const proxyUrl = `${baseProxyUrl}/m3u8-proxy?url=${encodeURIComponent(mediaUrl)}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
                        out.push(line.replace(uriMatch[1], proxyUrl));
                    } catch { out.push(line); }
                } else out.push(line);
            } else out.push(line);
        } else if (line.trim()) {
            try {
                const abs = new URL(line, targetUrl).href;
                // The old check demanded a dot before "m3u8", so extensionless playlist paths were left
                // unproxied and the browser fetched them without the Referer the host requires (403).
                if (afterVariantTag || /\.m3u8(\?|$)/i.test(abs)) {
                    out.push(`${baseProxyUrl}/m3u8-proxy?url=${encodeURIComponent(abs)}&headers=${encodeURIComponent(JSON.stringify(headers))}`);
                } else {
                    segmentUrls.push(abs);
                    out.push(`${baseProxyUrl}/ts-proxy?url=${encodeURIComponent(abs)}&headers=${encodeURIComponent(JSON.stringify(headers))}`);
                }
                afterVariantTag = false;
            } catch { out.push(line); }
        } else out.push(line);
    }
    if (segmentUrls.length && !isCacheDisabled()) {
        // Was: Promise.all(segmentUrls.map(prefetchSegment)) -- every segment in the episode (354 measured)
        // fired at once, and the player's own first-segment request queued behind all of them for ~11s.
        prefetchHead(segmentUrls, headers);
    }
    return out.join('\n');
}

function createProxyRoutes(app) {
    // m3u8 playlist proxy
    app.get('/m3u8-proxy', cors(), async (req, res) => {
        const targetUrl = req.query.url; if (!targetUrl) return res.status(400).json({ error: 'URL parameter required' });
        const debug = req.query.debug === '1';
        let headers = {};
        try { headers = JSON.parse(req.query.headers || '{}'); } catch {
            // Ignore URL parsing errors
        }
        // Segment URLs written back into the playlist must point at the public host this request
        // arrived on; see utils/publicUrl.js. Previously `${x-forwarded-proto}://${host}`.
        const baseProxyUrl = baseUrlFromRequest(req);
        const cacheKey = `${baseProxyUrl}\n${targetUrl}`;
        // Fast path: a burst of native-HLS playlist reloads is served from the last copy without
        // stampeding upstream, and that copy is what saves playback if upstream then blips.
        if (!isCacheDisabled()) {
            const fresh = getFreshPlaylist(cacheKey);
            if (fresh) { if (debug) console.log('[m3u8-proxy] fresh cache hit'); return sendPlaylist(res, fresh); }
        }
        try {
            let response;
            try {
                response = await upstreamFetch(targetUrl, { headers: { 'User-Agent': DEFAULT_UA, ...headers } }, { res, timeoutMs: UPSTREAM_FAST_RETRY_MS });
            } catch (firstErr) {
                if (res.destroyed || res.headersSent || res.writableEnded) throw firstErr;
                if (debug) console.log('[m3u8-proxy] upstream attempt failed, retrying fresh:', firstErr.message);
                response = await upstreamFetch(targetUrl, { headers: { 'User-Agent': DEFAULT_UA, ...headers } }, { res, agent: freshAgentFor(targetUrl), timeoutMs: UPSTREAM_RETRY_TIMEOUT_MS });
            }
            if (!response.ok) {
                // A playlist request must never receive JSON: native HLS treats a non-playlist body as
                // unplayable and stops. Serve the last good copy, else a plain-text retryable error.
                const stale = isCacheDisabled() ? null : getStalePlaylist(cacheKey);
                if (stale) {
                    logProxyFailure('m3u8-proxy', { host: safeHost(targetUrl), phase: 'upstream', status: response.status, served: 'stale' });
                    return sendPlaylist(res, stale);
                }
                logProxyFailure('m3u8-proxy', { host: safeHost(targetUrl), phase: 'upstream', status: response.status, served: 'error' });
                return res.status(502).type('text/plain').set('Retry-After', '2').send(`playlist upstream error ${response.status}`);
            }
            const text = await response.text();
            const rewritten = rewriteM3u8(text, targetUrl, baseProxyUrl, headers);
            if (!isCacheDisabled()) putPlaylist(cacheKey, rewritten);
            sendPlaylist(res, rewritten);
        } catch (e) {
            const stale = isCacheDisabled() ? null : getStalePlaylist(cacheKey);
            if (stale) {
                logProxyFailure('m3u8-proxy', { host: safeHost(targetUrl), phase: 'fetch', error: e.message, served: 'stale' });
                return sendPlaylist(res, stale);
            }
            logProxyFailure('m3u8-proxy', { host: safeHost(targetUrl), phase: 'fetch', error: e.message, served: 'error' });
            if (!res.headersSent) res.status(502).type('text/plain').set('Retry-After', '2').send('playlist proxy error');
            else try { res.destroy(); } catch (_e) { /* ignore */ }
        }
    });

    // ts / key segment proxy
    app.get('/ts-proxy', cors(), async (req, res) => {
        // A genuine player request. Prefetch workers stand down while any of these is open, so background
        // warming can never be the reason the video the user clicked is slow to start.
        beginRealRequest();
        res.on('close', endRealRequest);
        const targetUrl = req.query.url; if (!targetUrl) return res.status(400).json({ error: 'URL parameter required' });
        const debug = req.query.debug === '1';
        const noSynth = req.query.noSynth === '1';
        const force200 = req.query.force200 === '1';
        const clampOpen = req.query.clampOpen !== '0';
        const progressiveOpen = req.query.progressiveOpen !== '0';
        const tailPrefetchEnabled = req.query.tailPrefetch !== '0';
        let tailPrefetchKB = parseInt(req.query.tailPrefetchKB || '256', 10);
        if (isNaN(tailPrefetchKB) || tailPrefetchKB < 64) tailPrefetchKB = 256;
        if (tailPrefetchKB > 2048) tailPrefetchKB = 2048; // max 2MB tail window
        let openChunkKB = parseInt(req.query.openChunkKB || '4096', 10);
        if (isNaN(openChunkKB) || openChunkKB < 64) openChunkKB = 4096;
        if (openChunkKB > 16384) openChunkKB = 16384; // cap at 16MB
        let initChunkKB = parseInt(req.query.initChunkKB || '512', 10);
        if (isNaN(initChunkKB) || initChunkKB < 64) initChunkKB = 512;
        if (initChunkKB > 2048) initChunkKB = 2048; // hard cap 2MB
        let headers = {}; try { headers = JSON.parse(req.query.headers || '{}'); } catch {
            // Ignore URL parsing errors
        }
        // Pass through Range header for progressive playback / seeking
        const range = req.headers['range'];
        let appliedClamp = false;
        let effectiveRange = range;
        if (range) headers.Range = range;
        // Clamp first open-ended bytes=0- request to a bounded span (once per TTL) to avoid gigantic initial 206
        if (range && /^bytes=0-\s*$/i.test(range) && !force200) {
            const now = Date.now();
            // Progressive growth supersedes single-shot clamp if enabled
            if (progressiveOpen) {
                const prog = progressiveOpenMap.get(targetUrl) || { lastEnd: -1 };
                const prevEnd = prog.lastEnd;
                let nextEnd;
                if (prog.lastEnd < 0) {
                    nextEnd = openChunkKB * 1024 - 1;
                } else {
                    const increment = openChunkKB * 1024;
                    nextEnd = prog.lastEnd + increment;
                    const maxCap = 256 * 1024 * 1024 - 1; // 256MB
                    if (nextEnd > maxCap) nextEnd = maxCap;
                }
                const newRange = `bytes=0-${nextEnd}`;
                headers.Range = newRange;
                effectiveRange = newRange;
                prog.lastEnd = nextEnd;
                prog.ts = now;
                progressiveOpenMap.set(targetUrl, prog);
                appliedClamp = true; // reuse flag for logging
                if (debug) console.log('[ts-proxy] progressiveOpen expand', { prevEnd, nextEnd, increment: openChunkKB * 1024 });
            } else if (clampOpen) {
                const lastTs = openRangeClampMap.get(targetUrl);
                if (!lastTs || (now - lastTs) > OPEN_RANGE_CLAMP_TTL_MS) {
                    const clampBytes = openChunkKB * 1024;
                    const newRange = `bytes=0-${clampBytes - 1}`;
                    headers.Range = newRange;
                    effectiveRange = newRange;
                    openRangeClampMap.set(targetUrl, now);
                    appliedClamp = true;
                }
            }
        }
        if (debug) console.log('[ts-proxy] incoming', { url: targetUrl, range, effectiveRange, appliedClamp, clampOpen, progressiveOpen, openChunkKB, noSynth, initChunkKB, force200, tailPrefetchEnabled, tailPrefetchKB });
        if (!isCacheDisabled()) {
            const cached = getCachedSegment(targetUrl);
            if (cached) {
                const ct = inferContentType(cached.headers['content-type'], targetUrl);
                res.setHeader('Content-Type', ct);
                res.setHeader('Cache-Control', 'public, max-age=3600');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Accept-Ranges', 'bytes');
                if (debug) console.log('[ts-proxy] cache hit');
                return res.send(Buffer.from(cached.data));
            }
        }
        try {
            // If we have a tail prefetch entry and the client requests a tail range fully inside it, serve from memory early.
            if (effectiveRange && /^bytes=\d+-$/i.test(effectiveRange)) {
                const tailEntry = tailPrefetchMap.get(targetUrl);
                if (tailEntry) {
                    const m = effectiveRange.match(/bytes=(\d+)-/i);
                    if (m) {
                        const startReq = parseInt(m[1], 10);
                        if (!isNaN(startReq) && startReq >= tailEntry.start && startReq <= tailEntry.end) {
                            const offset = startReq - tailEntry.start;
                            const slice = tailEntry.data.subarray(offset);
                            const endByte = tailEntry.end;
                            res.status(206);
                            const ct = inferContentType(null, targetUrl);
                            res.setHeader('Content-Type', ct);
                            res.setHeader('Accept-Ranges', 'bytes');
                            res.setHeader('Content-Length', slice.length.toString());
                            res.setHeader('Content-Range', `bytes ${startReq}-${endByte}/${tailEntry.size}`);
                            res.setHeader('Cache-Control', 'public, max-age=3600');
                            res.setHeader('Access-Control-Allow-Origin', '*');
                            if (debug) console.log('[ts-proxy] tail serve hit', { startReq, cachedStart: tailEntry.start, cachedEnd: tailEntry.end, size: tailEntry.size });
                            return res.end(slice);
                        }
                    }
                }
            }

            // HEAD preflight (only when no explicit Range requested) to get size for synthesized partial response
            let contentLength = null;
            let upstreamAcceptRanges = null;
            if (!effectiveRange && !isAnixo(targetUrl)) {
                try {
                    const headResp = await upstreamFetch(targetUrl, { method: 'HEAD', headers: { 'User-Agent': DEFAULT_UA, ...headers } }, { res, timeoutMs: UPSTREAM_ACCEL_TIMEOUT_MS });
                    if (headResp.ok) {
                        contentLength = headResp.headers.get('content-length');
                        upstreamAcceptRanges = headResp.headers.get('accept-ranges');
                        if (debug) console.log('[ts-proxy] HEAD ok', { contentLength, upstreamAcceptRanges });
                    } else if (debug) {
                        console.log('[ts-proxy] HEAD status', headResp.status);
                    }
                } catch (_e) { if (debug) console.log('[ts-proxy] HEAD failed'); }
            }

            // Fallback probe: if still no size, attempt a 0-0 range request to derive total size from Content-Range
            if (!effectiveRange && !contentLength && !isAnixo(targetUrl)) {
                try {
                    const probeRange = 'bytes=0-0';
                    if (debug) console.log('[ts-proxy] probe range');
                    const probeResp = await upstreamFetch(targetUrl, { headers: { 'User-Agent': DEFAULT_UA, ...headers, 'Range': probeRange } }, { res, timeoutMs: UPSTREAM_ACCEL_TIMEOUT_MS });
                    if (probeResp.status === 206) {
                        const cr = probeResp.headers.get('content-range');
                        if (cr) {
                            const m = cr.match(/\/(\d+)$/); if (m) contentLength = m[1];
                        }
                        try { await probeResp.arrayBuffer(); } catch (readErr) {
                            if (debug) console.log('[ts-proxy] probe body read failed', readErr.message);
                        }
                        if (debug) console.log('[ts-proxy] probe success', { contentLength });
                    } else if (debug) {
                        console.log('[ts-proxy] probe status', probeResp.status);
                    }
                } catch (_e) { if (debug) console.log('[ts-proxy] probe failed'); }
            }
            if (debug && contentLength) console.log('[ts-proxy] size determined', contentLength);

            // Initiate tail prefetch asynchronously (once) when size known and feature enabled
            if (tailPrefetchEnabled && contentLength && !tailPrefetchMap.has(targetUrl)) {
                const total = parseInt(contentLength, 10);
                if (!isNaN(total) && total > 0) {
                    const tailBytes = Math.min(tailPrefetchKB * 1024, total);
                    const start = Math.max(0, total - tailBytes);
                    const tailRange = `bytes=${start}-`;
                    (async () => {
                        try {
                            if (debug) console.log('[ts-proxy] tail prefetch start', { tailRange });
                            const tr = await upstreamFetch(targetUrl, { headers: { 'User-Agent': DEFAULT_UA, ...headers, Range: tailRange } }, { timeoutMs: UPSTREAM_ACCEL_TIMEOUT_MS });
                            if (tr.status === 206) {
                                const buf = Buffer.from(await tr.arrayBuffer());
                                const cr = tr.headers.get('content-range');
                                if (cr) {
                                    const mm = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
                                    if (mm) {
                                        const s = parseInt(mm[1], 10); const e = parseInt(mm[2], 10); const sz = parseInt(mm[3], 10);
                                        if (!isNaN(s) && !isNaN(e) && !isNaN(sz)) {
                                            tailPrefetchMap.set(targetUrl, { data: buf, start: s, end: e, size: sz, ts: Date.now() });
                                            if (debug) console.log('[ts-proxy] tail prefetch success', { start: s, end: e, bytes: buf.length });
                                        }
                                    }
                                }
                            } else if (debug) {
                                console.log('[ts-proxy] tail prefetch status', tr.status);
                            }
                        } catch (e) { if (debug) console.log('[ts-proxy] tail prefetch error', e.message); }
                    })();
                }
            }

            // If no range requested but we now know size (HEAD or probe), synthesize an initial small range fetch to accelerate playback.
            if (!force200 && !effectiveRange && contentLength && !noSynth && req.query.progressiveOpen === '0') {
                const total = parseInt(contentLength, 10);
                const desired = initChunkKB * 1024;
                const chunkSize = Math.min(desired, Math.max(0, total - 1));
                const syntheticRange = `bytes=0-${chunkSize}`;
                const resp = await upstreamFetch(targetUrl, { headers: { 'User-Agent': DEFAULT_UA, ...headers, 'Range': syntheticRange } }, { res });
                if (resp.status === 206) {
                    if (debug) console.log('[ts-proxy] synthetic 206', syntheticRange);
                    const upstreamCT = inferContentType(resp.headers.get('content-type'), targetUrl);
                    res.status(206);
                    res.setHeader('Content-Type', upstreamCT);
                    res.setHeader('Accept-Ranges', upstreamAcceptRanges || 'bytes');
                    const contentRange = resp.headers.get('content-range');
                    if (contentRange) res.setHeader('Content-Range', contentRange);
                    const cl = resp.headers.get('content-length'); if (cl) res.setHeader('Content-Length', cl);
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    // Pipe first chunk then leave connection open? Simpler: end after chunk; player will request next range.
                    return resp.body.pipe(res);
                }
                // If server ignored range (e.g., returned 200), fall through to normal logic below.
            }

            const upstreamOptions = { headers: { 'User-Agent': DEFAULT_UA, ...headers } };
            // If client supplied a suffix range like bytes=0- we pass it; force200 strips Range
            if (force200 && headers.Range) delete headers.Range;
            // One retry on a brand-new connection. The first attempt uses the shared keep-alive
            // pool; if it dies (dead pooled socket, reset, header timeout), the client -- an
            // already-waiting video player -- gets a second attempt on a socket nothing else has
            // touched before we give up and return an error.
            let resp;
            try {
                resp = await upstreamFetch(targetUrl, upstreamOptions, { res, timeoutMs: UPSTREAM_FAST_RETRY_MS });
            } catch (firstErr) {
                if (res.destroyed || res.headersSent || res.writableEnded) throw firstErr;
                if (debug) console.log('[ts-proxy] upstream attempt failed, retrying fresh:', firstErr.message);
                resp = await upstreamFetch(targetUrl, upstreamOptions, { res, agent: freshAgentFor(targetUrl), timeoutMs: UPSTREAM_RETRY_TIMEOUT_MS });
            }
            if (!resp.ok && resp.status !== 206) {
                // One more attempt on a fresh socket for transient upstream statuses. Mid-show these
                // are the single biggest cause of a segment failing on a native-HLS client, which then
                // stops the whole show instead of retrying.
                const retryable = resp.status === 429 || resp.status === 500 || resp.status === 502 || resp.status === 503 || resp.status === 504;
                if (retryable && !res.destroyed && !res.headersSent && !res.writableEnded) {
                    if (debug) console.log('[ts-proxy] upstream error, retrying once more', resp.status);
                    try { resp.body && resp.body.destroy(); } catch (_e) { /* ignore */ }
                    await sleep(300);
                    try {
                        resp = await upstreamFetch(targetUrl, upstreamOptions, { res, agent: freshAgentFor(targetUrl), timeoutMs: UPSTREAM_RETRY_TIMEOUT_MS });
                    } catch (retryErr) {
                        if (debug) console.log('[ts-proxy] retry threw', retryErr.message);
                        resp = null;
                    }
                }
                if (!resp || (!resp.ok && resp.status !== 206)) {
                    const status = resp ? resp.status : 502;
                    logProxyFailure('ts-proxy', { host: safeHost(targetUrl), phase: 'upstream', status });
                    return res.status(status).type('text/plain').set('Retry-After', '2').send(`TS fetch failed: ${status}`);
                }
            }
            // Forward partial content status when range used
            if (effectiveRange && resp.status === 206 && !force200) { res.status(206); if (debug) console.log('[ts-proxy] forwarding 206', { appliedClamp }); }
            if (force200 && resp.status === 206) {
                // Some origins still return 206 even without Range; normalize to 200 for players expecting full stream
                if (debug) console.log('[ts-proxy] normalizing 206 -> 200 due to force200');
            }
            // Copy key streaming headers
            const upstreamCT = inferContentType(resp.headers.get('content-type'), targetUrl);
            res.setHeader('Content-Type', upstreamCT);
            let cl = resp.headers.get('content-length');
            const crHeader = resp.headers.get('content-range');
            if (!cl && crHeader) {
                // Try to derive length from range span
                const m = crHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
                if (m) {
                    const start = parseInt(m[1], 10); const end = parseInt(m[2], 10);
                    if (!isNaN(start) && !isNaN(end)) cl = (end - start + 1).toString();
                }
            }
            if (cl) res.setHeader('Content-Length', cl);
            const acceptRanges = resp.headers.get('accept-ranges');
            // Advertise seeking only when ranges actually work. If the client asked for a
            // Range and the upstream answered 200, it ignored the Range: claiming
            // `Accept-Ranges: bytes` there makes players (mpv especially) seek-spiral --
            // every seek restarts a full multi-GB download and playback wedges. Saying
            // nothing makes them stream progressively instead.
            if (resp.status === 206) {
                res.setHeader('Accept-Ranges', acceptRanges || 'bytes');
            } else if (!effectiveRange) {
                res.setHeader('Accept-Ranges', upstreamAcceptRanges || acceptRanges || 'bytes');
            }
            const contentRange = resp.headers.get('content-range'); if (contentRange && !force200) res.setHeader('Content-Range', contentRange);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Access-Control-Allow-Origin', '*');
            if (debug) console.log('[ts-proxy] streaming body', { status: resp.status, ct: upstreamCT, cl, contentRange: force200 ? undefined : contentRange });
            // Tie the upstream download to the client for the life of the stream, not just the
            // header phase. An abandoned stream (mpv seek, stall recovery, app quit) used to leave
            // the upstream fetch running with its socket checked out of the pool forever; leaked
            // far enough, new requests to that origin stalled behind the wreckage until a restart.
            let idleTimer = null;
            const bumpIdle = () => {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    if (debug) console.log('[ts-proxy] upstream idle mid-stream, cutting client');
                    logProxyFailure('ts-proxy', { host: safeHost(targetUrl), phase: 'body-idle', idleMs: UPSTREAM_BODY_IDLE_TIMEOUT_MS });
                    try { resp.body.destroy(); } catch (_e) { /* ignore */ }
                    res.destroy();
                }, UPSTREAM_BODY_IDLE_TIMEOUT_MS);
            };
            res.on('close', () => { if (idleTimer) clearTimeout(idleTimer); try { resp.body.destroy(); } catch (_e) { /* ignore */ } });
            resp.body.on('error', (err) => {
                if (debug) console.log('[ts-proxy] upstream body error', err.message);
                logProxyFailure('ts-proxy', { host: safeHost(targetUrl), phase: 'body', error: err.message });
                if (idleTimer) clearTimeout(idleTimer);
                try { res.destroy(); } catch (_e) { /* ignore */ }
            });
            resp.body.on('data', bumpIdle);
            bumpIdle();
            resp.body.pipe(res);
        } catch (e) {
            if (debug) console.log('[ts-proxy] exception', e.message);
            logProxyFailure('ts-proxy', { host: safeHost(targetUrl), phase: 'exception', error: e.message });
            if (!res.headersSent) res.status(502).type('text/plain').set('Retry-After', '2').send('segment proxy error');
            else try { res.destroy(); } catch (_e) { /* ignore */ }
        }
    });

    // subtitle proxy
    app.get('/sub-proxy', cors(), async (req, res) => {
        const targetUrl = req.query.url; if (!targetUrl) return res.status(400).json({ error: 'url parameter required' });
        let headers = {}; try { headers = JSON.parse(req.query.headers || '{}'); } catch {
            // Ignore URL parsing errors
        }
        try {
            const resp = await upstreamFetch(targetUrl, { headers: { 'User-Agent': DEFAULT_UA, ...headers } }, { res });
            if (!resp.ok) return res.status(resp.status).json({ error: `subtitle fetch failed: ${resp.status}` });
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Content-Type', resp.headers.get('content-type') || 'text/vtt');
            res.on('close', () => { try { resp.body.destroy(); } catch (_e) { /* ignore */ } });
            resp.body.on('error', () => { try { res.destroy(); } catch (_e) { /* ignore */ } });
            resp.body.pipe(res);
        } catch (e) {
            if (!res.headersSent) res.status(500).json({ error: e.message });
            else try { res.destroy(); } catch (_e) { /* ignore */ }
        }
    });
}

function processStreamsForProxy(streams, serverUrl) {
    if (!Array.isArray(streams)) return streams;
    return streams.map(s => {
        if (!s || !s.url || typeof s.url !== 'string') return s;
        const original = extractOriginalUrl(s.url);
        const headers = s.headers || {};
        const hParam = Object.keys(headers).length ? `&headers=${encodeURIComponent(JSON.stringify(headers))}` : '';
        let host = '';
        try {
            host = new URL(original).hostname.toLowerCase();
        } catch {
            // Ignore errors
        }
        // anixo is relayed like everything else: the server mints and uses its tokens over one socket
        // (utils/anixoAgent.js), so the player never contacts anixo itself.
        // Force specific hosts through ts-proxy (direct file style) even without extension
        if (host.includes('pixeldrain.') || host === 'video-downloads.googleusercontent.com') {
            return { ...s, url: `${serverUrl}/ts-proxy?url=${encodeURIComponent(original)}${hParam}` };
        }
        if (/\.(mp4|mkv)(\?|$)/i.test(original)) {
            return { ...s, url: `${serverUrl}/ts-proxy?url=${encodeURIComponent(original)}${hParam}` };
        }
        return { ...s, url: `${serverUrl}/m3u8-proxy?url=${encodeURIComponent(original)}${hParam}` };
    });
}

module.exports = { createProxyRoutes, processStreamsForProxy };