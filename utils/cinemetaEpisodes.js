// Episode count per season from Cinemeta.
// Ported from Infinite-streams (src/lib/cinemeta.ts getEpisodesPerSeason).

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;

const episodeCountCache = new Map();

async function getEpisodesPerSeason(imdbId) {
  const cacheKey = `eps:${imdbId}`;
  const cached = episodeCountCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = `${CINEMETA_BASE}/meta/series/${imdbId}.json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Stremio Addon' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      episodeCountCache.set(cacheKey, { data: [], ts: Date.now() });
      return [];
    }

    const json = await res.json();
    const videos = (json.meta && json.meta.videos) || [];
    if (videos.length === 0) {
      episodeCountCache.set(cacheKey, { data: [], ts: Date.now() });
      return [];
    }

    const seasonMaxEp = new Map();
    for (const v of videos) {
      if (!v.season || v.season <= 0) continue;
      const ep = v.number || v.episode || 0;
      if (ep > 0) {
        const prev = seasonMaxEp.get(v.season) || 0;
        seasonMaxEp.set(v.season, Math.max(prev, ep));
      }
    }

    if (seasonMaxEp.size === 0) {
      episodeCountCache.set(cacheKey, { data: [], ts: Date.now() });
      return [];
    }

    const maxSeason = Math.max(...seasonMaxEp.keys());
    const result = [];
    for (let s = 1; s <= maxSeason; s++) {
      result.push(seasonMaxEp.get(s) || 0);
    }

    episodeCountCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  } catch (err) {
    console.error(`[Cinemeta] getEpisodesPerSeason error: ${err.message}`);
    episodeCountCache.set(cacheKey, { data: [], ts: Date.now() });
    return [];
  }
}

module.exports = { getEpisodesPerSeason };