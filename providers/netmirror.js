const { getDetails } = require('../utils/tmdb');

const STREAM_CACHE_TTL = 25 * 60 * 1000;
const PLATFORM_ORDER = ['netflix', 'primevideo', 'hotstar', 'disney'];

const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36'
];
const ACCEPT_LANG_POOL = [
    'en-US,en;q=0.9',
    'en-GB,en;q=0.9',
    'en-IN,en;q=0.9,hi;q=0.7',
    'en-US,en;q=0.8,es;q=0.5'
];
let uaIndex = 0;
let langIndex = 0;

function nextUA() { return UA_POOL[uaIndex++ % UA_POOL.length]; }
function nextLang() { return ACCEPT_LANG_POOL[langIndex++ % ACCEPT_LANG_POOL.length]; }

const streamCache = new Map();
const inflight = new Map();
let resolvedApiUrl = '';

const NEW_TV_DOMAINS = [
    'aHR0cHM6Ly9tb2JpbGVkZXRlY3RzLmNvbQ==',
    'aHR0cHM6Ly9tb2JpbGVkZXRlY3QuYXBw',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNsaWNr',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0Lmluaw==',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LmxpdmU=',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnBybw==',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNob3A=',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNpdGU=',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNwYWNl',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnN0b3Jl',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnZpcA==',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0Lndpa2k=',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0Lnh5eg=='
];

const PLATFORM_MAP = { netflix: { ott: 'nf' }, primevideo: { ott: 'pv' }, hotstar: { ott: 'hs' }, disney: { ott: 'hs' } };

function apiBase() {
    return (process.env.NETMIRROR_API_BASE || 'https://net27.cc').replace(/\/$/, '');
}

function streamReferer() {
    return process.env.NETMIRROR_STREAM_REFERER || 'https://videodownloader.site/';
}

function newTvHeaders(ott, extra = {}) {
    return {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-Requested-With': 'NetmirrorNewTV v1.0',
        'Accept': 'application/json, text/plain, */*',
        'Ott': ott,
        'User-Agent': nextUA(),
        'Accept-Language': nextLang(),
        ...extra
    };
}

async function resolveNewTvApi() {
    if (resolvedApiUrl) return resolvedApiUrl;
    const custom = (process.env.NEWTV_DOMAINS || '')
        .split(',')
        .map((value) => value.trim().replace(/\/$/, ''))
        .filter(Boolean);
    const domains = [
        ...custom,
        ...NEW_TV_DOMAINS.map((value) => Buffer.from(value, 'base64').toString('utf8'))
    ];

    for (const domain of domains) {
        try {
            const response = await fetch(`${domain}/checknewtv.php`, {
                headers: { ...newTvHeaders('nf') },
                signal: AbortSignal.timeout(10000)
            });
            const data = await response.json();
            if (data.token_hash) {
                resolvedApiUrl = Buffer.from(data.token_hash, 'base64').toString('utf8').replace(/\/$/, '');
                return resolvedApiUrl;
            }
        } catch {
            // Try the next rotating discovery domain.
        }
    }
    throw new Error('NetMirror NewTV API discovery failed');
}

async function fetchNetflix(tmdbId, type, title, season, episode) {
    try {
        const base = apiBase();
        const url = type === 'series'
            ? `${base}/api/embed-tmdb/${tmdbId}?type=tv&se=${season}&ep=${episode}`
            : `${base}/api/embed-tmdb/${tmdbId}`;
        const response = await fetch(url, {
            headers: {
                Accept: 'application/json, text/plain, */*',
                Referer: `${base}/`,
                'User-Agent': nextUA(),
                'Accept-Language': nextLang()
            },
            signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) return [];
        const data = await response.json();
        if (data.ok !== true) return [];
        const subtitles = (data.captions || []).flatMap((caption, index) => {
            if (!caption.url) return [];
            return [{
                id: `netflix-${index}-${caption.lang || 'en'}`,
                url: caption.url.startsWith('/') ? `${base}${caption.url}` : caption.url,
                lang: caption.lang || 'en',
                label: caption.name || 'English'
            }];
        });
        const headers = { Referer: streamReferer(), 'User-Agent': nextUA() };
        const streams = (data.streams || []).filter((stream) => stream.url).map((stream) => ({
            name: 'NetMirror | Netflix',
            title: `${title}\n${stream.resolution ? `${stream.resolution}p` : 'Auto'}`,
            url: stream.url,
            quality: stream.resolution ? `${stream.resolution}p` : 'Auto',
            provider: 'NetMirror',
            headers,
            ...(subtitles.length ? { subtitles } : {})
        }));
        if (streams.length || !data.mp4) return streams;
        return [{
            name: 'NetMirror | Netflix',
            title: `${title}\nAuto`,
            url: data.mp4,
            quality: 'Auto',
            provider: 'NetMirror',
            headers,
            ...(subtitles.length ? { subtitles } : {})
        }];
    } catch (error) {
        console.log(`[NetMirror] Netflix direct failed: ${error.message}`);
        return [];
    }
}

function parseNumber(value) {
    if (!value) return null;
    const parsed = parseInt(String(value).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

async function getEpisodes(api, showId, postData, config) {
    const result = [];
    const selectedSeason = Array.isArray(postData.season) ? postData.season.findIndex((item) => item.selected) : -1;
    const selectedSeasonId = selectedSeason >= 0 ? postData.season[selectedSeason].id : postData.nextPageSeason;
    const add = (episode, seasonNumber) => {
        result.push({
            id: episode.id,
            s: seasonNumber || parseNumber(episode.sNum),
            ep: parseNumber(episode.ep) || parseNumber(episode.epNum)
        });
    };

    for (const episode of postData.episodes || []) {
        if (episode) add(episode, selectedSeason >= 0 ? selectedSeason + 1 : null);
    }

    if (postData.nextPageShow === 1 && selectedSeasonId) {
        try {
            const response = await fetch(
                `${api}/newtv/episodes.php?id=${encodeURIComponent(selectedSeasonId)}&page=2`,
                { headers: newTvHeaders(config.ott), signal: AbortSignal.timeout(15000) }
            );
            const data = await response.json();
            for (const episode of data.episodes || []) {
                if (episode) add(episode, selectedSeason >= 0 ? selectedSeason + 1 : null);
            }
        } catch {
            // The first page is still useful when pagination is unavailable.
        }
    }

    return result;
}

async function fetchPlatform(platform, title, type, season, episode) {
    try {
        const config = PLATFORM_MAP[platform];
        const api = await resolveNewTvApi();
        const searchResponse = await fetch(
            `${api}/newtv/search.php?s=${encodeURIComponent(title)}`,
            { headers: newTvHeaders(config.ott), signal: AbortSignal.timeout(15000) }
        );
        const searchData = await searchResponse.json();
        const first = (searchData.searchResult || [])[0];
        if (!first || !first.id) return [];

        const postResponse = await fetch(
            `${api}/newtv/post.php?id=${encodeURIComponent(first.id)}`,
            { headers: newTvHeaders(config.ott, { Lastep: '', Usertoken: '' }), signal: AbortSignal.timeout(15000) }
        );
        const postData = await postResponse.json();

        let targetId = first.id;
        if (type === 'series') {
            const episodes = await getEpisodes(api, first.id, postData, config);
            const target = episodes.find((item) => item.s === season && item.ep === episode);
            if (!target) return [];
            targetId = target.id;
        } else if (postData.type === 't' || ((postData.episodes || []).filter(Boolean).length > 0)) {
            return [];
        } else {
            targetId = postData.main_id || first.id;
        }

        const playerResponse = await fetch(
            `${api}/newtv/player.php?id=${encodeURIComponent(targetId)}`,
            { headers: newTvHeaders(config.ott, { Usertoken: '' }), signal: AbortSignal.timeout(15000) }
        );
        const player = await playerResponse.json();
        if (player.status && player.status !== 'ok') {
            console.log(`[NetMirror] ${platform} player status: ${player.status} — accepting if link present`);
        }
        if (!player.video_link) return [];
        return [{
            name: `NetMirror | ${platform === 'primevideo' ? 'Prime Video' : platform.charAt(0).toUpperCase() + platform.slice(1)}`,
            title: `${title}\nAuto`,
            url: player.video_link,
            quality: 'Auto',
            provider: 'NetMirror',
            headers: {
                Referer: player.referer || api,
                'User-Agent': nextUA()
            }
        }];
    } catch (error) {
        console.log(`[NetMirror] ${platform} failed: ${error.message}`);
        return [];
    }
}

function hdOnly(streams, forceHd) {
    if (!forceHd) return streams;
    const hd = streams.filter((stream) => {
        const match = (stream.quality || '').match(/(\d+)p/i);
        return !match || Number(match[1]) >= 720;
    });
    return hd.length ? hd : streams;
}

async function getNetmirrorStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[NetMirror] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    const type = mediaType === 'tv' ? 'series' : 'movie';
    const season = mediaType === 'tv' ? (seasonNum || null) : null;
    const episode = mediaType === 'tv' ? (episodeNum || null) : null;

    try {
        const details = await getDetails(mediaType === 'tv' ? 'tv' : 'movie', tmdbId);
        const title = (details && (details.title || details.name)) || '';
        if (!title) {
            console.log(`[NetMirror] No TMDB title resolved for ${tmdbId}`);
            return [];
        }

        const key = `${tmdbId}:${type}:${season || 0}:${episode || 0}`;
        const cached = streamCache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            return hdOnly(cached.streams, true);
        }
        const running = inflight.get(key);
        if (running) return running;

        const request = (async () => {
            const direct = await fetchNetflix(tmdbId, type, title, season, episode);
            const fallback = await Promise.all(
                PLATFORM_ORDER
                    .filter((platform) => platform !== 'netflix' || direct.length === 0)
                    .map((platform) => fetchPlatform(platform, title, type, season, episode))
            );
            const streams = hdOnly([...direct, ...fallback.flat()], true);
            streamCache.set(key, { streams, expiresAt: Date.now() + STREAM_CACHE_TTL });
            console.log(`[NetMirror] ${tmdbId} streams ready: ${streams.length}`);
            return streams;
        })().finally(() => inflight.delete(key));

        inflight.set(key, request);
        return request;
    } catch (err) {
        console.error(`[NetMirror] Error: ${err.message}`);
        return [];
    }
}

module.exports = { getNetmirrorStreams };