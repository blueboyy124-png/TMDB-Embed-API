// Resolve the IMDB ID TMDB associates with a given matched title + year.
// Ported from Infinite-streams (src/lib/tmdb-verify.ts). Uses the repo's
// configured TMDB key. Returns null when inconclusive — callers must treat
// null as "pass through", never reject on it.

const { getTmdbApiKey } = require('./tmdbKey');
const { findBestMatch } = require('./titleMatch');

const TMDB_BASE = 'https://api.themoviedb.org/3';

const cache = new Map();
const TTL = 24 * 60 * 60 * 1000;

async function tmdbTitleToImdbId(title, year, type) {
  const key = `${title.toLowerCase()}|${year || ''}|${type}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.imdbId;

  const set = (v) => {
    cache.set(key, { imdbId: v, ts: Date.now() });
    return v;
  };

  const apiKey = getTmdbApiKey();
  if (!apiKey) return set(null);

  try {
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const yearParam = year ? `&${type === 'series' ? 'first_air_date_year' : 'year'}=${year}` : '';
    const searchUrl =
      `${TMDB_BASE}/search/${tmdbType}` +
      `?api_key=${apiKey}&query=${encodeURIComponent(title)}${yearParam}&page=1`;

    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
    if (!searchRes.ok) return set(null);

    const searchData = await searchRes.json();
    const results = searchData.results || [];
    if (results.length === 0) return set(null);

    const candidates = results.slice(0, 10).map((r) => {
      const dateStr = r.first_air_date || r.release_date;
      const candidateYear = dateStr ? parseInt(dateStr.slice(0, 4), 10) : undefined;
      return {
        title: r.name || r.title || '',
        year: Number.isFinite(candidateYear) ? candidateYear : undefined,
        type,
        raw: r,
      };
    });

    const { best } = findBestMatch(
      { title, year, type },
      candidates,
      { provider: 'tmdb-verify', query: title, quiet: true },
    );
    if (!best) return set(null);
    const topId = best.raw.id;

    const extUrl = `${TMDB_BASE}/${tmdbType}/${topId}/external_ids?api_key=${apiKey}`;
    const extRes = await fetch(extUrl, { signal: AbortSignal.timeout(8000) });
    if (!extRes.ok) return set(null);

    const extData = await extRes.json();
    return set(extData.imdb_id || null);
  } catch (err) {
    console.warn(`[tmdb-verify] lookup failed: ${err.message}`);
    return set(null);
  }
}

module.exports = { tmdbTitleToImdbId };