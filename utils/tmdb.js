const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const { getTmdbApiKey } = require('./tmdbKey');
const { BoundedTtlCache } = require('./boundedCache');

// Capped. A long-running server accumulates a key per title per season per episode endpoint that was ever
// asked for, and nothing ever removed an entry that was simply never read again.
const MAX_CACHE_ENTRIES = 2000;

const cache = {
  imdbByTmdb: new BoundedTtlCache(MAX_CACHE_ENTRIES),
  details: new BoundedTtlCache(MAX_CACHE_ENTRIES),
};
// key -> in-flight promise. The cache only helps the *second* request; a single aggregate fans out to a
// dozen providers at once and several of them look up the same title's details or IMDb id in the same
// instant, so without this they all miss the cache together and ask TMDB once each. Sharing the promise
// collapses that to one upstream call and takes the duplicated latency off every provider that was waiting.
const inflight = {
  imdbByTmdb: new Map(),
  details: new Map(),
};
const TTL_MS = 6 * 60 * 60 * 1000;

// Run `work` once per key: concurrent callers await the same promise, and it is dropped again on settle so a
// failed lookup is never remembered as if it had succeeded.
//
// Failures ARE remembered, briefly. That is the opposite of the obvious choice and it matters: this cache is
// read by ~14 providers at once, so if a failure were not recorded, one 429 or one dropped connection would be
// re-attempted independently by every provider in the same instant, and the retry storm would be what kept
// TMDB refusing us. A 30s negative entry turns "14 simultaneous retries" into "one retry, everyone else fails
// fast", which is what lets the upstream recover.
function once(bucket, key, work) {
  const pending = inflight[bucket].get(key);
  if (pending) return pending;
  const p = work().then(
    data => { cache[bucket].set(key, { data, ts: Date.now(), ok: true }); return data; },
    err => {
      cache[bucket].set(key, { data: null, ts: Date.now(), ok: false, error: err && err.message });
      throw err;
    }
  ).finally(() => inflight[bucket].delete(key));
  inflight[bucket].set(key, p);
  return p;
}

// True for a successful entry, or a remembered failure that has not aged out yet.
function usable(entry) {
  if (!entry) return false;
  const age = Date.now() - entry.ts;
  if (entry.ok === false) return age < FAILURE_TTL_MS;   // negative TTL
  return age < TTL_MS;                                    // positive TTL
}

// A rate-limited or briefly-broken TMDB must not become a self-inflicted outage.
//
// What used to happen: tmdbFetchJson throws on any non-OK status and NOTHING is cached. One aggregate request
// fans out to ~14 providers plus the metadata service, and they all ask TMDB about the same title at the same
// instant. If TMDB answers even one of them with 429 (or the network hiccups), every one of them immediately
// retried, so a single blip was amplified into 14 simultaneous retries -- which is what kept the limit active.
// Observed exactly this: "network timeout at api.themoviedb.org" from six providers on one request, and the
// whole endpoint degraded for everyone.
//
// Three defences:
//   1. negative cache   -- a failure is remembered briefly, so the other callers fail fast instead of
//                          re-hammering a service that has already refused us.
//   2. global cool-off  -- on 429 the whole process stops calling TMDB for a few seconds (honouring
//                          Retry-After when the header is present), so the limit window can actually expire.
//   3. one retry        -- after the cool-off, for the caller that triggered it, rather than giving up on a
//                          title that is perfectly available.
const FAILURE_TTL_MS = 30 * 1000;       // how long a known failure is remembered
const COOLOFF_DEFAULT_MS = 5000;
const COOLOFF_MAX_MS = 60000;
let tmdbCooloffUntil = 0;                // epoch ms; while in the future, no new TMDB calls are made

function cooloffRemaining() { return Math.max(0, tmdbCooloffUntil - Date.now()); }

// Parses Retry-After, which TMDB sends in seconds.
function cooloffFrom(res) {
  const header = res && res.headers && res.headers.get && res.headers.get('retry-after');
  let ms = COOLOFF_DEFAULT_MS;
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs > 0) ms = secs * 1000;
  }
  return Math.min(ms, COOLOFF_MAX_MS);
}

async function tmdbFetchJson(url) {
  const apiKey = getTmdbApiKey();
  if (!apiKey) throw new Error('TMDB_API_KEY missing');
  const sep = url.includes('?') ? '&' : '?';
  const full = `${url}${sep}api_key=${apiKey}`;

  // Respect an active cool-off instead of adding to the pile-up. Throwing here is caught and cached as a
  // failure by the caller, so this degrades to "no metadata" rather than a broken endpoint.
  if (cooloffRemaining() > 0) throw new Error(`TMDB rate limited, cooling down for ${cooloffRemaining()}ms`);

  const res = await fetch(full, { timeout: 15000 });
  if (!res.ok) {
    if (res.status === 429) {
      const wait = cooloffFrom(res);
      tmdbCooloffUntil = Date.now() + wait;
      console.warn(`[tmdb] 429 from TMDB; pausing all TMDB calls for ${wait}ms`);
      throw new Error(`TMDB rate limited (429), retry after ${wait}ms`);
    }
    throw new Error(`TMDB request failed ${res.status}`);
  }
  return res.json();
}
async function getExternalIds(type, tmdbId) {
  const key = `${type}:${tmdbId}`;
  const cached = cache.imdbByTmdb.get(key);
  if (usable(cached)) {
    if (cached.ok === false) throw new Error(cached.error || 'TMDB lookup failed recently');
    return cached.data;
  }
  return once('imdbByTmdb', key, () => tmdbFetchJson(`https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids`));
}
async function getDetails(type, tmdbId, appendPath) {
  const key = `${type}:${tmdbId}:details${appendPath ? ':' + appendPath : ''}`;
  const cached = cache.details.get(key);
  if (usable(cached)) {
    if (cached.ok === false) throw new Error(cached.error || 'TMDB lookup failed recently');
    return cached.data;
  }
  // appendPath addresses the nested resources (seasons, season/N/episode/M) under the same id.
  return once('details', key, () => tmdbFetchJson(`https://api.themoviedb.org/3/${type}/${tmdbId}${appendPath ? '/' + appendPath : ''}`));
}
async function resolveImdbId(type, tmdbId) {
  try { const ext = await getExternalIds(type, tmdbId); return ext.imdb_id || null; } catch { return null; }
}
// Search and trending. Added with the Roku client in mind: until now the API was streams-only, so a client
// had to already know a TMDB id, which is not something a person can do. Same caching and same 429 cool-off
// as every other TMDB call here -- a search box that generates one TMDB request per keystroke is precisely how
// you get rate limited, so this is cached and the client is expected to debounce.
//
// Results are trimmed to what a picker actually renders (id, type, title, year, poster, overview). TMDB's
// search payload carries fields nobody displays, and on a TV every byte of it is a frame of load time.
const MAX_SEARCH_RESULTS = 40;

// TMDB returns a flat list where the same title can appear as both a movie and a TV show. Roku (and every
// other grid) has one row per item, so they are kept separate and labelled rather than merged: sending a
// viewer to the wrong one is worse than showing both.
function normaliseSearchItem(raw) {
  const isMovie = raw.media_type === 'movie' || (!raw.media_type && !!raw.title);
  const date = isMovie ? raw.release_date : (raw.first_air_date || raw.air_date);
  return {
    id: raw.id,
    type: isMovie ? 'movie' : 'series',
    title: raw.title || raw.name || 'Untitled',
    // Truncated here rather than by the client: a 90-character overview is all a grid row can show, and the
    // Roku side has no truncation helper.
    overview: (raw.overview || '').slice(0, 280) || null,
    poster: raw.poster_path ? `https://image.tmdb.org/t/p/w342${raw.poster_path}` : null,
    year: date && date.length >= 4 ? date.slice(0, 4) : null,
    rating: typeof raw.vote_average === 'number' && raw.vote_average > 0
      ? Math.round(raw.vote_average * 10) / 10 : null
  };
}

async function search(query, page = 1) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query is required');
  const key = `${q.toLowerCase()}:${page}`;
  const cached = cache.details.get(key);
  if (usable(cached)) {
    if (cached.ok === false) throw new Error(cached.error || 'TMDB search failed recently');
    return cached.data;
  }
  return once('details', key, async () => {
    const url = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(q)}` +
      `&include_adult=false&page=${page}`;
    const data = await tmdbFetchJson(url);
    const results = (data.results || [])
      // Trending/known-for/person entries have no id we can play; a person has no media_type at all.
      .filter(r => r && r.id && (r.media_type === 'movie' || r.media_type === 'tv'))
      .map(normaliseSearchItem);
    return { query: q, page, totalResults: data.total_results ?? results.length, results: results.slice(0, MAX_SEARCH_RESULTS) };
  });
}

async function trending(window = 'week') {
  // 'day' and 'week' are the only values TMDB accepts. Anything else is a client bug, and answering it with
  // a 400 is better than silently serving the week.
  if (!['day', 'week'].includes(window)) throw new Error("window must be 'day' or 'week'");
  const key = `trending:${window}`;
  const cached = cache.details.get(key);
  if (usable(cached)) {
    if (cached.ok === false) throw new Error(cached.error || 'TMDB trending failed recently');
    return cached.data;
  }
  return once('details', key, async () => {
    const data = await tmdbFetchJson(`https://api.themoviedb.org/3/trending/all/${window}`);
    const results = (data.results || [])
      .filter(r => r && r.id && (r.media_type === 'movie' || r.media_type === 'tv'))
      .map(normaliseSearchItem);
    return { window, results: results.slice(0, MAX_SEARCH_RESULTS) };
  });
}

// For diagnostics: is TMDB currently refusing us, and how much have we cached? Exposed on /api/health so a
// slow response can be attributed to TMDB rate limiting rather than guessed at.
function status() {
  return {
    cooloffRemainingMs: cooloffRemaining(),
    cachedLookups: cache.imdbByTmdb.size + cache.details.size,
    maxEntries: MAX_CACHE_ENTRIES
  };
}

module.exports = { getExternalIds, getDetails, resolveImdbId, search, trending, status };