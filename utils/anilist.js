/* Shared AniList access.
 *
 * AniList is the best source of "what this anime actually is": original/romaji/English/native titles, a
 * real description, artwork, genres, score, the total episode count and the MAL id. TMDB has this for
 * live action and only partly for anime, which is why the anime provider used to be the only thing that
 * could name a show properly.
 *
 * Design rules, all deliberate:
 *   - Metadata must NEVER block or fail playback. Every function degrades to null rather than throwing,
 *     and callers read a null as "no extra info", not as an error.
 *   - Aggressive caching: AniList is a free public API and we ask it about the same title repeatedly
 *     (once per stream request, per provider, plus warm-ups for the next episodes).
 *   - Single-flight, so N concurrent requests for one title cause ONE network call.
 */

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const TIMEOUT_MS = Number(process.env.ANILIST_TIMEOUT_MS) || 8000;
const TTL_OK = 6 * 60 * 60 * 1000;      // a match barely changes; hold it for hours
const TTL_NULL = 30 * 60 * 1000;        // remember "no match", but retry sooner than a hit

// Capped: keyed by title, so browsing a large catalogue grew this forever.
const { BoundedTtlCache } = require('./boundedCache');
const cache = new BoundedTtlCache(2000);      // cacheKey -> { data, ts }
const inflight = new Map();   // cacheKey -> Promise

const MEDIA_FIELDS = `
  id idMal
  title { romaji english native }
  description(asHtml: false)
  synonyms
  averageScore
  genres
  episodes
  format status season seasonYear
  duration
  startDate { year month day }
  endDate { year month day }
  coverImage { extraLarge large color }
  bannerImage
  isAdult
  studios(isMain: true) { nodes { name } }
`;

function fresh(entry) { return entry && (Date.now() - entry.ts) < (entry.data ? TTL_OK : TTL_NULL); }

function shape(m) {
  if (!m) return null;
  const t = m.title || {};
  return {
    id: m.id,
    idMal: m.idMal,
    idAniList: m.id,
    titles: { romaji: t.romaji || null, english: t.english || null, native: t.native || null },
    // What a UI should show first: the original title beats an English dub title when they differ.
    displayTitle: t.romaji || t.english || t.native || null,
    description: m.description || null,
    synonyms: m.synonyms || [],
    score: m.averageScore ?? null,
    genres: m.genres || [],
    episodes: m.episodes ?? null,
    format: m.format || null,
    status: m.status || null,
    season: m.season || null,
    seasonYear: m.seasonYear ?? null,
    duration: m.duration ?? null,
    coverImage: (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || null,
    coverColor: (m.coverImage && m.coverImage.color) || null,
    bannerImage: m.bannerImage || null,
    isAdult: !!m.isAdult,
    studios: ((m.studios && m.studios.nodes) || []).map(s => s.name).filter(Boolean),
    startDate: m.startDate || null,
    endDate: m.endDate || null
  };
}


// AniList rate-limits (429/5xx) under bursts. One quick retry is worth it; a hard failure is not.
async function gql(query, variables, attempt = 0) {
  try {
    const res = await fetch(ANILIST_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors && json.errors.length) throw new Error('AniList ' + (json.errors[0].message || 'error'));
    return json.data;
  } catch (err) {
    if (attempt < 1 && err.name !== 'TimeoutError') {
      await new Promise(r => setTimeout(r, 300));
      return gql(query, variables, attempt + 1);
    }
    throw err;
  }
}

// A title key that two sites can actually be compared on: accents and macrons removed (so TMDB's
// "Naruto Shippūden" and AniList's "NARUTO: Shippuuden" are comparable), case and punctuation dropped, and
// non-Latin scripts kept because the native title is often the only spelling that matches.
function normalizeTitle(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, ' ')
    .trim();
}

// Levenshtein, iterative with one row. Titles are short so this is cheap.
function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Word-level match, tolerant of the romanisation differences the two sites are full of: "shippuden" vs
// "shippuuden" is one edit apart and is the same word.
function tokensMatch(a, b) {
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;
  const d = editDistance(a, b);
  if (d <= 1) return 0.9;
  if (d <= 2 && Math.min(a.length, b.length) >= 6) return 0.7;
  return 0;
}

// How well a candidate title matches a query, 0..1.
//
// This is an F-score over words: `recall` is how much of the queried title the candidate covers, `precision`
// is how much of the candidate the query accounts for. Both are needed. Recall alone rates "The Office"
// against the anime "Survival in the Office" as a perfect match, because every queried word is present;
// precision is what notices that the candidate is mostly something else. A plain substring shortcut is
// deliberately not used for the same reason -- it scored "Friends" against "Sex Friends" at 0.9.
function titleScore(query, candidate) {
  const q = normalizeTitle(query), c = normalizeTitle(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  const qt = q.split(' ').filter(Boolean), ct = c.split(' ').filter(Boolean);
  if (!qt.length || !ct.length) return 0;

  let matched = 0;
  for (const t of qt) {
    let best = 0;
    for (const u of ct) best = Math.max(best, tokensMatch(t, u));
    matched += best;
  }
  if (matched <= 0) return 0;

  const recall = matched / qt.length;
  const precision = matched / ct.length;
  return (2 * recall * precision) / (recall + precision);
}

// Score a search result against every spelling we know the show by. The format and year terms matter as
// much as the title: a series lookup that lands on a film is wrong even when the names look close, which is
// exactly how "Naruto Shippūden" used to resolve to "NARUTO: Blood Prison".
// Returns the title similarity separately from the total, because the caller gates on the TITLE: a bonus
// for being a TV show must never be enough on its own, or any anime would match a live-action comedy.
function scoreCandidate(m, queries, year, prefer) {
  const names = [
    m.title && m.title.romaji, m.title && m.title.english, m.title && m.title.native,
    ...(m.synonyms || [])
  ].filter(Boolean);
  let best = 0;
  for (const q of queries) for (const n of names) best = Math.max(best, titleScore(q, n));

  let score = best * 10;
  const isSeries = m.format === 'TV' || m.format === 'ONA' || m.format === 'OVA' || m.format === 'TV_SHORT';
  if (prefer === 'series') score += isSeries ? 3 : (m.format === 'MOVIE' ? -5 : 0);
  if (prefer === 'movie') score += m.format === 'MOVIE' ? 3 : (isSeries ? -2 : 0);

  const y = m.startDate && m.startDate.year;
  if (year && y) {
    const diff = Math.abs(y - Number(year));
    if (diff === 0) score += 2;
    else if (diff <= 1) score += 1;
    else if (diff > 8) score -= 1;   // a same-named remake is a different show
  }
  return { total: score, title: best, media: m };
}

// The bar for a TMDB entry that does not look like anime at all: the titles have to line up almost exactly,
// because a loose match against an anime-only database is far more likely to be a coincidence than a hit.
const EXACT_TITLE_MATCH = 0.9;

// A candidate must match MORE than this much of the queried title before format or year can rescue it.
// The F-score in titleScore means this is already strict about extra words; the value mostly decides how
// many words of a multi-word title have to line up. Callers that know no anime can be involved pass a
// higher `minTitle` -- see getForTmdb, which requires a near-exact match for live action.
const MIN_TITLE_MATCH = 0.5;

// Match a TMDB entry to AniList.
//
// Every spelling is searched and all the results are scored TOGETHER. That is the fix for a real bug:
// returning the first spelling that answered anything made "Naruto Shippūden" (TMDB's name, with a macron)
// resolve to the film "NARUTO: Blood Prison", because that fuzzy-matches first and the correct TV entry
// (id 1735, 500 episodes) only appears for the native title "ナルト 疾風伝". Scoring across all candidates
// lets the right entry win on format, title and year instead of on search order.
// A best score below the floor means nothing plausible was found; returning that would attach a stranger's
// title, artwork and episode count to the show.
async function findByTitles(titles, year, opts = {}) {
  // Spellings that normalise to the same key are the same search: "Hunter x Hunter" and "HUNTER×HUNTER"
  // cost one request between them, not two.
  const byKey = new Map();
  for (const t of (titles || [])) {
    if (!t) continue;
    const k = normalizeTitle(t);
    if (k && !byKey.has(k)) byKey.set(k, t);
  }
  const variants = [...byKey.entries()].slice(0, 3).map(e => e[1]);
  if (!variants.length) return null;

  const query = `query($q:String){Page(perPage:8){media(search:$q,type:ANIME,sort:SEARCH_MATCH){${MEDIA_FIELDS}}}}`;
  const batches = await Promise.all(variants.map(async q => {
    try {
      const data = await gql(query, { q });
      return (data && data.Page && data.Page.media) || [];
    } catch { return []; }   // a spelling that fails contributes nothing; the others still count
  }));

  const seen = new Set();
  const pool = [];
  for (const batch of batches) {
    for (const m of batch) {
      if (m && m.id && !seen.has(m.id)) { seen.add(m.id); pool.push(m); }
    }
  }
  if (!pool.length) return null;

  const minTitle = Number.isFinite(opts.minTitle) ? opts.minTitle : MIN_TITLE_MATCH;
  let best = null, bestScore = -Infinity;
  for (const m of pool) {
    const s = scoreCandidate(m, variants, year, opts.prefer);
    // The title gate comes first: a strong format/year fit is worthless if the names are unrelated.
    if (!(s.title > minTitle)) continue;
    if (s.total > bestScore) { bestScore = s.total; best = m; }
  }
  if (!best || bestScore < 3) return null;
  return shape(best);
}

async function findByImdb(imdbId) {
  try {
    const data = await gql(`query($id:String){Media(search:$id,type:ANIME){${MEDIA_FIELDS}}}`, { id: imdbId });
    const m = (data && data.Page && data.Page.media && data.Page.media[0]) || null;
    return m ? shape(m) : null;
  } catch { return null; }
}

async function getMediaById(id) {
  const key = `id:${id}`;
  const hit = cache.get(key);
  if (fresh(hit)) return hit.data;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const data = await gql(`query($id:Int){Media(id:$id,type:ANIME){${MEDIA_FIELDS}}}`, { id });
      return shape(data && data.Media);
    } catch { return null; }
  })().then(v => { cache.set(key, { data: v, ts: Date.now() }); inflight.delete(key); return v; });
  inflight.set(key, p);
  return p;
}

// Public: look up by TMDB id, reusing the title mapping already built for that title.
async function getForTmdb(type, tmdbId) {
  if (!tmdbId) return null;
  const key = `tmdb:${type}:${tmdbId}`;
  const hit = cache.get(key);
  if (fresh(hit)) return hit.data;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const { getDetails, getExternalIds } = require('./tmdb');
      const details = await getDetails(type, tmdbId);
      const titles = [details && (details.name || details.title), details && details.original_name, details && details.original_title];
      const year = details && String(details.first_air_date || details.release_date || '').slice(0, 4);

      // Is this even plausibly an anime? AniList is an anime-only database, so for anything else a title
      // match is a coincidence: searching it returns anime whose titles merely contain the queried words
      // ("The Office" hits "Survival in the Office"). TMDB is the only side that knows, so when it says
      // this is not animation and not Japanese, insist on a near-exact title before attaching an entry.
      const isAnimation = ((details && details.genres) || []).some(g => g && g.id === 16);
      const looksAnime = isAnimation || (details && details.original_language === 'ja');

      let media = await findByTitles(titles, year, {
        prefer: type === 'movie' ? 'movie' : 'series',
        minTitle: looksAnime ? MIN_TITLE_MATCH : EXACT_TITLE_MATCH
      });
      if (!media) {
        // Titles rarely line up across languages, so fall back to the IMDb id, which both sites share.
        const ext = await getExternalIds(type, tmdbId).catch(() => null);
        if (ext && ext.imdb_id) media = await findByImdb(ext.imdb_id);
      }
      return media;
    } catch { return null; }
  })().then(v => { cache.set(key, { data: v, ts: Date.now() }); inflight.delete(key); return v; });
  inflight.set(key, p);
  return p;
}

// AniList has no per-episode title table, so this is deliberately thin: it carries the series-level facts a
// client wants beside an episode. Actual episode names come from TMDB (utils/metadata.js), which has them.
// Present so the response shape stays stable for clients either way.
async function getEpisodeContext(media, season, episode) {
  if (!media) return null;
  return {
    anilistId: media.id,
    seriesTitle: media.displayTitle || null,
    seasonLabel: media.season ? String(media.season).toLowerCase() : null,
    seasonYear: media.seasonYear ?? null,
    episode: episode ?? null,
    totalEpisodes: media.episodes ?? null
  };
}

// Warm the cache without awaiting: used alongside a stream request so metadata is usually ready already.
function prefetch(type, tmdbId) { getForTmdb(type, tmdbId).catch(() => {}); }

function clear() { cache.clear(); inflight.clear(); }

module.exports = {
  getForTmdb, getMediaById, getEpisodeContext, findByTitles, prefetch, clear,
  // exported for tests
  _internal: { normalizeTitle, titleScore, scoreCandidate }
};
