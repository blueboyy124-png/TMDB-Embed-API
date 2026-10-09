const axios = require('axios');
const { pickPrimaryLanguage } = require('../utils/streamMeta');

const BASE_URL = 'https://vixsrc.to';
const VIXSRC_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': BASE_URL,
    'Origin': BASE_URL
};

// Step 1: GET /api/movie/{id} or /api/tv/{id}/{s}/{e} → { src: "/embed/..." }
async function fetchApi(url) {
    try {
        const response = await axios.get(url, { headers: VIXSRC_HEADERS, timeout: 10000 });
        if (response.status !== 200 || !response.data) return null;
        return response.data;
    } catch {
        return null;
    }
}

// Step 2: GET BASE_URL + sublink.src → HTML embed page
async function fetchEmbedPage(suburl) {
    try {
        const response = await axios.get(BASE_URL + suburl, {
            headers: { ...VIXSRC_HEADERS, Accept: 'text/html,application/xhtml+xml,*/*' },
            timeout: 10000,
            responseType: 'text'
        });
        if (response.status !== 200) return null;
        return response.data;
    } catch {
        return null;
    }
}

// Step 3: Extract token, expires, playlist URL from embed HTML
function extractTokenData(html) {
    const token = html.match(/token["']\s*:\s*["']([^"']+)/)?.[1];
    const expires = html.match(/expires["']\s*:\s*["']([^"']+)/)?.[1];
    const playlist = html.match(/url\s*:\s*["']([^"']+)/)?.[1];

    if (!token || !expires || !playlist) return null;

    // Reject expired tokens (with 60s grace period)
    if (parseInt(expires, 10) * 1000 - 60_000 < Date.now()) {
        console.log('[Vixsrc] Token is expired');
        return null;
    }

    return { token, expires, playlist };
}

// Step 4: Append token params to master URL
function buildMasterUrl(tokenData) {
    const { token, expires, playlist } = tokenData;
    const sep = playlist.includes('?') ? '&' : '?';
    return `${playlist}${sep}token=${token}&expires=${expires}&h=1`;
}

// Step 5: Fetch the master HLS playlist
async function fetchPlaylist(masterUrl, pageApiUrl) {
    try {
        const response = await axios.get(masterUrl, {
            headers: { ...VIXSRC_HEADERS, Referer: pageApiUrl },
            timeout: 10000,
            responseType: 'text'
        });
        if (response.status !== 200) return null;
        return response.data;
    } catch {
        return null;
    }
}

// Step 6: Parse HLS manifest for quality variants, audio tracks, subtitles
function parsePlaylist(content, masterUrl, pageApiUrl) {
    const sources = [];
    const subtitles = [];
    const audioTracks = [];

    const lines = content.split('\n');

    // Audio tracks
    for (const line of lines) {
        if (!line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) continue;
        const language = line.match(/LANGUAGE="([^"]+)"/)?.[1] ?? 'unknown';
        const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'Audio';
        audioTracks.push({ language, label });
    }

    // Subtitles
    for (const line of lines) {
        if (!line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')) continue;
        const url = line.match(/URI="([^"]+)"/)?.[1];
        if (!url) continue;
        const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'unknown';
        subtitles.push({ url, label, format: 'vtt' });
    }

    // Quality variants — find the highest resolution
    const variantRegex = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)[^\n]*\n([^\n]+)/g;
    let match;
    let bestResolution = 0;
    while ((match = variantRegex.exec(content)) !== null) {
        const res = parseInt(match[1], 10);
        if (res > bestResolution) bestResolution = res;
    }

    if (bestResolution === 0) return { sources: [], subtitles: [], audioTracks };

    sources.push({
        name: `Vixsrc - ${bestResolution}p`,
        title: `Vixsrc - ${bestResolution}p`,
        url: masterUrl,
        quality: `${bestResolution}p`,
        provider: 'Vixsrc',
        headers: {
            'Referer': pageApiUrl,
            'User-Agent': VIXSRC_HEADERS['User-Agent']
        }
    });

    return { sources, subtitles, audioTracks };
}

async function getVixsrcStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[Vixsrc] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    // Build API URL
    let apiUrl;
    if (mediaType === 'movie') {
        apiUrl = `${BASE_URL}/api/movie/${tmdbId}`;
    } else {
        apiUrl = `${BASE_URL}/api/tv/${tmdbId}/${seasonNum}/${episodeNum}`;
    }

    console.log(`[Vixsrc] Step 1 - Calling API: ${apiUrl}`);
    const apiData = await fetchApi(apiUrl);
    if (!apiData || !apiData.src) {
        console.log('[Vixsrc] No src returned from API');
        return [];
    }
    console.log(`[Vixsrc] Step 2 - Fetching embed page: ${BASE_URL}${apiData.src}`);

    const html = await fetchEmbedPage(apiData.src);
    if (!html) {
        console.log('[Vixsrc] Failed to fetch embed page');
        return [];
    }
    console.log(`[Vixsrc] Embed HTML length: ${html.length} characters`);

    const tokenData = extractTokenData(html);
    if (!tokenData) {
        console.log('[Vixsrc] Could not extract token/expires/playlist from embed HTML');
        return [];
    }

    const masterUrl = buildMasterUrl(tokenData);
    console.log(`[Vixsrc] Step 3 - Master URL: ${masterUrl}`);

    const playlistContent = await fetchPlaylist(masterUrl, apiUrl);
    if (!playlistContent) {
        console.log('[Vixsrc] Failed to fetch HLS playlist');
        return [];
    }

    const { sources, subtitles, audioTracks } = parsePlaylist(playlistContent, masterUrl, apiUrl);

    if (sources.length === 0) {
        console.log('[Vixsrc] No streams found in HLS playlist');
        return [];
    }

    // Audio renditions were parsed all along and thrown away. Attach the language so vixsrc reports one like
    // every other provider, and keep the full list because a manifest with several renditions is genuinely
    // multi-language and a client may want to know that.
    const lang = pickPrimaryLanguage(audioTracks);
    for (const s of sources) {
      if (lang.language) { s.language = lang.language; s.languageLabel = lang.languageLabel; }
      if (lang.audioTracks && lang.audioTracks.length) s.audioTracks = lang.audioTracks;
    }

    console.log(`[Vixsrc] Successfully extracted ${sources.length} stream(s). Subtitles: ${subtitles.length}. Audio: ${(audioTracks || []).map(t => t.language).join(',') || 'none'}${lang.language ? ` -> ${lang.language}` : ''}`);
    return sources;
}

// parsePlaylist is exported for testing. It is a pure function, and it is the only place the audio-rendition
// language is read out of the manifest -- the behaviour that was silently dropped, so it needs a test that
// does not depend on vixsrc.to being up.
module.exports = { getVixsrcStreams, parsePlaylist };