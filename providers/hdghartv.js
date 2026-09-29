const { getDetails, resolveImdbId } = require('../utils/tmdb');
const { findBestMatchWithRetry } = require('../utils/titleMatch');
const { tmdbTitleToImdbId } = require('../utils/tmdbTitleToImdb');

const HDGHARTV_API = 'https://hdghartv.cc/api';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, */*',
    'Referer': 'https://hdghartv.cc/'
};

async function fetchJson(url, timeoutMs = 10000) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.warn(`[HDGharTV] fetch failed for ${url}: ${err.message}`);
        return null;
    }
}

async function searchHdghartv(title, kind, variants) {
    const searchByVariant = async (variantTitle) => {
        const encoded = encodeURIComponent(variantTitle);
        const data = await fetchJson(`${HDGHARTV_API}/search?q=${encoded}`);
        if (!data) return [];
        const results = kind === 'movie' ? data.movies : data.series;
        return (results || []).map((r) => ({ title: r.title, type: kind, raw: r }));
    };

    const { best } = await findBestMatchWithRetry(
        { title, type: kind },
        variants,
        searchByVariant,
        { provider: 'HDGharTV' }
    );
    if (!best) return null;
    return { id: best.raw._id, title: best.raw.title };
}

const QUALITY_RANK = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, '360p': 4 };

function sortLinks(links) {
    return [...links].sort((a, b) => (QUALITY_RANK[a.quality] || 99) - (QUALITY_RANK[b.quality] || 99));
}

function linksToStreams(links, labelSuffix = '') {
    return sortLinks(links.filter((l) => l.isActive && l.url)).map((l) => ({
        name: 'HDGharTV',
        title: `HDGharTV${labelSuffix ? ` ${labelSuffix}` : ''} · ${l.quality}`,
        url: l.url,
        quality: l.quality,
        provider: 'HDGharTV',
        headers: HEADERS
    }));
}

async function getHdghartvStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[HDGharTV] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    try {
        const kind = mediaType === 'tv' ? 'series' : 'movie';
        const tmdbType = mediaType === 'tv' ? 'tv' : 'movie';
        const details = await getDetails(tmdbType, tmdbId);
        const title = (details && (details.title || details.name)) || '';
        if (!title) {
            console.log(`[HDGharTV] No TMDB title resolved for ${tmdbId}`);
            return [];
        }
        const variants = [title];
        const imdbId = await resolveImdbId(tmdbType, tmdbId);

        const match = await searchHdghartv(title, kind, variants);
        if (!match) {
            console.log(`[HDGharTV] "${title}" not found`);
            return [];
        }

        if (imdbId && imdbId.startsWith('tt')) {
            const resolvedId = await tmdbTitleToImdbId(match.title, undefined, kind).catch(() => null);
            if (resolvedId && resolvedId !== imdbId) {
                console.log(`[HDGharTV] IMDB ID mismatch — rejecting match: expected ${imdbId}, resolved ${resolvedId}`);
                return [];
            }
        }

        if (kind === 'movie') {
            const movie = await fetchJson(`${HDGHARTV_API}/movies/public/${match.id}`);
            if (!movie || !movie.streamingLinks || !movie.streamingLinks.length) {
                console.log(`[HDGharTV] No streaming links for movie "${match.title}"`);
                return [];
            }
            return linksToStreams(movie.streamingLinks);
        }

        const season = seasonNum || 1;
        const episode = episodeNum || 1;
        const series = await fetchJson(`${HDGHARTV_API}/series/public/${match.id}`);
        if (!series || !series.seasons || !series.seasons.length) {
            console.log(`[HDGharTV] No seasons for series "${match.title}"`);
            return [];
        }

        const seasonData = series.seasons.find((s) => s.seasonNumber === season);
        if (!seasonData) {
            console.log(`[HDGharTV] Season ${season} not found`);
            return [];
        }

        const episodeData = seasonData.episodes && seasonData.episodes.find((e) => e.episodeNumber === episode);
        if (!episodeData || !episodeData.streamingLinks || !episodeData.streamingLinks.length) {
            console.log(`[HDGharTV] Episode ${episode} or links not found`);
            return [];
        }

        return linksToStreams(episodeData.streamingLinks, `S${season}E${episode}`);
    } catch (err) {
        console.error(`[HDGharTV] Error: ${err.message}`);
        return [];
    }
}

module.exports = { getHdghartvStreams };