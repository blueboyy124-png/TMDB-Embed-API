const axios = require('axios');
const { getTmdbApiKey } = require('../utils/tmdbKey');

const DAHMER_MOVIES_API = 'https://a.111477.xyz';
const DAHMER_WORKER_API = 'https://p.111477.xyz/bulk?u=';

const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': `${DAHMER_MOVIES_API}/`
};

function parseLinks(html) {
    const links = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
        const rowContent = match[1];
        const linkMatch = rowContent.match(/<a[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>/i);
        const sizeMatch = rowContent.match(/<td[^>]*>(\d+(?:\.\d+)?\s?[KMGT]B)<\/td>/i);
        if (linkMatch) {
            const href = linkMatch[1];
            const text = linkMatch[2].trim();
            const size = sizeMatch ? sizeMatch[1].trim() : 'N/A';
            if (text && href !== '../' && /\.(mkv|mp4|avi|webm|m3u8)$/i.test(text)) {
                links.push({ text, href, size });
            }
        }
    }
    return links;
}

async function fetchDirectory(title, year, season) {
    const cleanTitle = title.replace(/:/g, '');
    const variants = season !== null ? [
        `/tvs/${encodeURIComponent(cleanTitle)}/Season%20${season < 10 ? '0' + season : season}/`,
        `/tvs/${encodeURIComponent(cleanTitle)}/Season%20${season}/`
    ] : [
        `/movies/${encodeURIComponent(`${cleanTitle} (${year})`)}/`
    ];

    for (const variant of variants) {
        try {
            const res = await axios.get(DAHMER_MOVIES_API + variant, {
                headers: REQUEST_HEADERS,
                timeout: 10000,
                responseType: 'text'
            });
            if (res.data) return { html: res.data, dirUrl: DAHMER_MOVIES_API + variant };
        } catch {
            // try next variant
        }
    }
    return null;
}

async function getDahmermoviesStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[DahmerMovies] Searching for ${mediaType} ${tmdbId}`);

    const tmdbKey = getTmdbApiKey();
    if (!tmdbKey) {
        console.error('[DahmerMovies] No TMDB API key configured.');
        return [];
    }

    let title, year;
    try {
        const type = mediaType === 'tv' ? 'tv' : 'movie';
        const { data } = await axios.get(
            `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${tmdbKey}`,
            { timeout: 8000 }
        );
        title = data.title || data.name || '';
        year = (data.release_date || data.first_air_date || '').substring(0, 4);
    } catch (err) {
        console.error(`[DahmerMovies] TMDB lookup failed: ${err.message}`);
        return [];
    }

    if (!title) return [];

    const dir = await fetchDirectory(title, year, seasonNum);
    if (!dir) {
        console.log(`[DahmerMovies] Directory not found for "${title}"`);
        return [];
    }

    let paths = parseLinks(dir.html);

    // For TV, filter to the specific episode when possible
    if (seasonNum !== null && episodeNum !== null) {
        const epStr = String(episodeNum).padStart(2, '0');
        const seStr = String(seasonNum).padStart(2, '0');
        const epFiltered = paths.filter(p => {
            const name = p.text.toLowerCase();
            return name.includes(`s${seStr}e${epStr}`) || name.includes(`e${epStr}`);
        });
        if (epFiltered.length > 0) paths = epFiltered;
    }

    // Sort 4K first
    paths.sort((a, b) => (/2160p|4k/i.test(b.text) ? 1 : 0) - (/2160p|4k/i.test(a.text) ? 1 : 0));

    const streams = [];
    for (const path of paths.slice(0, 5)) {
        let directUrl;
        if (path.href.startsWith('http')) {
            directUrl = path.href;
        } else if (path.href.includes('/movies/') || path.href.includes('/tvs/')) {
            directUrl = DAHMER_MOVIES_API + (path.href.startsWith('/') ? '' : '/') + path.href;
        } else {
            directUrl = dir.dirUrl + path.href;
        }
        directUrl = decodeURI(directUrl.replace(/([^:]\/)\/+/g, '$1'));

        const fileName = path.text;
        const isMulti = /\b(HIN|TAM|TEL|Multi|Dual|DUB|Multi-Audio|MULTI)\b/i.test(fileName);
        const hasEngTag = /\b(Eng|English)\b/i.test(fileName);
        const isEnglishTitle = /^[a-zA-Z0-9\s?!\-:]+$/.test(title);
        let language = 'Original';
        if (isMulti) language = 'Multi Audio';
        else if (isEnglishTitle && hasEngTag) language = 'English';

        const formatMatch = fileName.match(/\.(mkv|mp4|m3u8|avi|webm)$/i);
        const fileFormat = formatMatch ? formatMatch[1].toUpperCase() : 'LINK';
        const resolution = fileName.match(/\b(2160p|1080p|720p|4[Kk])\b/)?.[0] || '1080p';

        const info = fileName
            .replace(/\.(mkv|mp4|avi|webm|m3u8)$/i, '')
            .replace(/[\[\]()._-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        streams.push({
            name: 'DahmerMovies',
            title: `${resolution} | ${language} | ${path.size} | ${fileFormat} | ${info}`,
            url: DAHMER_WORKER_API + encodeURI(directUrl),
            quality: resolution,
            provider: 'DahmerMovies',
            headers: {
                'User-Agent': REQUEST_HEADERS['User-Agent'],
                'Referer': `${DAHMER_MOVIES_API}/`,
                'Accept': '*/*',
                'Range': 'bytes=0-'
            }
        });
    }

    console.log(`[DahmerMovies] Total results found: ${streams.length}`);
    return streams;
}

module.exports = { getDahmermoviesStreams };