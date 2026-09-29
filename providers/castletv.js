const { createDecipheriv } = require('crypto');
const { getDetails } = require('../utils/tmdb');

const CASTLE_BASE = 'https://api.hlowb.com';
const PKG = 'com.external.castle';
const CHANNEL = 'IndiaA';
const CLIENT = '1';
const LANG = 'en-US';

const API_HEADERS = {
    'User-Agent': 'okhttp/4.9.3',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'Keep-Alive',
    'Referer': CASTLE_BASE
};

const PLAYBACK_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'video',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
    'DNT': '1'
};

function castleSafeParse(text) {
    const safe = text.replace(/([:{[,]\s*)(\d{16,})/g, '$1"$2"');
    return JSON.parse(safe);
}

function deriveKey(securityKey) {
    const keyBytes = Buffer.from(securityKey, 'base64');
    const suffix = Buffer.from('T!BgJB', 'utf8');
    const combined = Buffer.concat([keyBytes, suffix]);
    if (combined.length < 16) {
        return Buffer.concat([combined, Buffer.alloc(16 - combined.length, 0)]);
    }
    return combined.subarray(0, 16);
}

function decryptCastle(cipherText, securityKey) {
    const key = deriveKey(securityKey);
    const decipher = createDecipheriv('aes-128-cbc', key, key);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(cipherText, 'base64')),
        decipher.final()
    ]);
    return decrypted.toString('utf8');
}

async function castleRequest(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: { ...API_HEADERS, ...(options.headers || {}) },
        signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) {
        throw new Error(`[CastleTV] HTTP ${res.status}: ${res.statusText}`);
    }
    return res;
}

async function extractCipher(res) {
    const text = await res.text();
    const trimmed = text.trim();
    if (!trimmed) throw new Error('[CastleTV] Empty response body');
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed.data && typeof parsed.data === 'string') {
            return parsed.data.trim();
        }
    } catch {
        // Not JSON — raw cipher text
    }
    return trimmed;
}

function unwrap(obj) {
    if (obj && obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
        return obj.data;
    }
    return obj;
}

async function getSecurityKey() {
    const url = `${CASTLE_BASE}/v0.1/system/getSecurityKey/1?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`;
    const res = await castleRequest(url);
    const json = await res.json();
    if (json.code !== 200 || !json.data) {
        throw new Error(`[CastleTV] Security key error: ${JSON.stringify(json)}`);
    }
    return json.data;
}

async function searchCastle(secKey, keyword) {
    const params = new URLSearchParams({
        channel: CHANNEL,
        clientType: CLIENT,
        keyword,
        lang: LANG,
        mode: '1',
        packageName: PKG,
        page: '1',
        size: '30'
    });
    const res = await castleRequest(`${CASTLE_BASE}/film-api/v1.1.0/movie/searchByKeyword?${params}`);
    const cipher = await extractCipher(res);
    return castleSafeParse(decryptCastle(cipher, secKey));
}

async function getCastleDetails(secKey, movieId) {
    const url = `${CASTLE_BASE}/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}&movieId=${movieId}&packageName=${PKG}`;
    const res = await castleRequest(url);
    const cipher = await extractCipher(res);
    return castleSafeParse(decryptCastle(cipher, secKey));
}

async function getVideoByLanguage(secKey, movieId, episodeId, languageId, resolution) {
    const body = {
        mode: '1',
        appMarket: 'GuanWang',
        clientType: CLIENT,
        woolUser: 'false',
        apkSignKey: 'ED0955EB04E67A1D9F3305B95454FED485261475',
        androidVersion: '13',
        movieId,
        episodeId,
        languageId,
        isNewUser: 'true',
        resolution: resolution.toString(),
        packageName: PKG
    };
    const url = `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
    const res = await castleRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const cipher = await extractCipher(res);
    return castleSafeParse(decryptCastle(cipher, secKey));
}

async function getVideoShared(secKey, movieId, episodeId, resolution) {
    const body = {
        mode: '1',
        appMarket: 'GuanWang',
        clientType: CLIENT,
        woolUser: 'false',
        apkSignKey: 'ED0955EB04E67A1D9F3305B95454FED485261475',
        androidVersion: '13',
        movieId,
        episodeId,
        isNewUser: 'true',
        resolution: resolution.toString(),
        packageName: PKG
    };
    const url = `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
    const res = await castleRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const cipher = await extractCipher(res);
    return castleSafeParse(decryptCastle(cipher, secKey));
}

function resolutionLabel(res) {
    const map = { 1: '480p', 2: '720p', 3: '1080p' };
    return map[res] || `${res}p`;
}

const KNOWN_HEIGHTS = new Set([240, 360, 480, 540, 576, 720, 1080, 1440, 2160]);

function knownHeight(value) {
    const n = Number(value);
    return Number.isFinite(n) && KNOWN_HEIGHTS.has(n);
}

function resolutionNumToLabel(num) {
    const map = { 1: '480p', 2: '720p', 3: '1080p', 4: '4K' };
    return map[num] || null;
}

function streamQuality(url, description, resolutionNum, defaultQual) {
    if (description) {
        const m = /(?:SD|HD|FHD|UHD|4K)?\s*(\d{3,4})\s*p?/i.exec(String(description).trim());
        if (m && knownHeight(m[1])) {
            return `${m[1]}p`;
        }
        if (/4k|uhd/i.test(String(description))) return '4K';
    }
    const numLabel = resolutionNumToLabel(Number(resolutionNum));
    if (numLabel) return numLabel;
    if (url) {
        const tokens = url.match(/[^/a-z](?:(\d{3,4})\s*p?)[^a-z]/gi);
        if (tokens) {
            for (const t of tokens) {
                const m = /(\d{3,4})/i.exec(t);
                if (m && knownHeight(m[1])) return `${m[1]}p`;
            }
        }
    }
    return defaultQual;
}

function formatSize(bytes) {
    if (typeof bytes !== 'number' || bytes <= 0) return 'Unknown';
    if (bytes > 1000000000) return `${(bytes / 1000000000).toFixed(2)} GB`;
    return `${(bytes / 1000000).toFixed(0)} MB`;
}

function buildCastleStreams(raw, langLabel, titleLine, resolution) {
    const data = unwrap(raw);
    if (!data.videoUrl && !((data.videos || []).length)) return [];

    const defaultQual = resolutionLabel(resolution);

    const subtitles = (data.subtitles || [])
        .filter((s) => typeof s.url === 'string' && s.url.length > 0)
        .map((s, i) => ({
            url: s.url.replace(/ /g, '%20'),
            lang: s.abbreviate || s.title || 'Unknown',
            id: `castle-${s.languageId || s.abbreviate || i}`
        }));

    const streams = [];

    if (data.videos && data.videos.length > 0) {
        const bestByUrl = new Map();
        for (const v of data.videos) {
            const videoUrl = v.url || data.videoUrl;
            if (!videoUrl) continue;
            const resNum = Number(v.resolution) || 0;
            const qual = streamQuality(
                videoUrl,
                v.resolutionDescription,
                resNum,
                defaultQual
            );
            const existing = bestByUrl.get(videoUrl);
            if (existing && existing.resNum >= resNum) continue;
            const nameTag = langLabel ? `CastleTV ${langLabel}` : 'CastleTV';
            bestByUrl.set(videoUrl, {
                resNum,
                stream: {
                    name: `${nameTag} | ${qual}`,
                    title: `${titleLine}\n${qual} | ${formatSize(v.size)} | Castle`,
                    url: videoUrl,
                    quality: qual,
                    provider: 'CastleTV',
                    headers: PLAYBACK_HEADERS,
                    ...(subtitles.length ? { subtitles } : {})
                }
            });
        }
        for (const { stream } of bestByUrl.values()) {
            streams.push(stream);
        }
    } else {
        const videoUrl = data.videoUrl;
        if (!videoUrl) return [];
        const qual = streamQuality(videoUrl, data.resolutionDescription, 0, defaultQual);
        const nameTag = langLabel ? `CastleTV ${langLabel}` : 'CastleTV';
        streams.push({
            name: `${nameTag} | ${qual}`,
            title: `${titleLine}\n${qual} | ${formatSize(data.size)} | Castle`,
            url: videoUrl,
            quality: qual,
            provider: 'CastleTV',
            headers: PLAYBACK_HEADERS,
            ...(subtitles.length ? { subtitles } : {})
        });
    }

    return streams;
}

function pickPreferredTracks(tracks) {
    if (!tracks || !tracks.length) return tracks || [];
    const withVideo = tracks.filter((t) => t.existIndividualVideo === true);
    return withVideo.length > 0 ? withVideo : tracks;
}

async function getCastletvStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[CastleTV] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    try {
        const type = mediaType === 'tv' ? 'series' : 'movie';
        const tmdbType = mediaType === 'tv' ? 'tv' : 'movie';
        const details = await getDetails(tmdbType, tmdbId);
        const title = (details && (details.title || details.name)) || '';
        const year = (details && (details.release_date || details.first_air_date || '').slice(0, 4)) || null;
        if (!title) {
            console.log(`[CastleTV] No TMDB title resolved for ${tmdbId}`);
            return [];
        }

        const season = seasonNum || 1;
        const episode = episodeNum || 1;
        const titleLine = type === 'series'
            ? `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}${year ? ` (${year})` : ''}`
            : `${title}${year ? ` (${year})` : ''}`;

        const secKey = await getSecurityKey();

        const keyword = year ? `${title} ${year}` : title;
        const searchResult = await searchCastle(secKey, keyword);
        const rows = (unwrap(searchResult).rows || []);

        if (rows.length === 0) {
            console.log(`[CastleTV] No search results for "${keyword}"`);
            return [];
        }

        const titleLc = title.toLowerCase();
        const match = rows.find((r) => {
            const name = (r.title || r.name || '').toLowerCase();
            return name.includes(titleLc) || titleLc.includes(name);
        }) || rows[0];

        if (!match) return [];
        const castleId = (match.id || match.redirectId || match.redirectIdStr || '').toString();
        if (!castleId) return [];

        let castleDetails = await getCastleDetails(secKey, castleId);
        let activeId = castleId;

        if (type === 'series') {
            const seasons = (unwrap(castleDetails).seasons || []);
            const seasonEntry = seasons.find((s) => s.number === season);
            if (seasonEntry && seasonEntry.movieId && seasonEntry.movieId.toString() !== castleId) {
                castleDetails = await getCastleDetails(secKey, seasonEntry.movieId.toString());
                activeId = seasonEntry.movieId.toString();
            }
        }

        const episodes = (unwrap(castleDetails).episodes || []);
        let episodeId = null;

        if (type === 'series') {
            const ep = episodes.find((e) => e.number === episode);
            episodeId = ep && ep.id ? ep.id.toString() : null;
        } else {
            episodeId = episodes[0] && episodes[0].id ? episodes[0].id.toString() : null;
        }

        if (!episodeId) {
            console.log(`[CastleTV] No episode found (${season}/${episode})`);
            return [];
        }

        const epEntry = episodes.find((e) => e.id && e.id.toString() === episodeId);
        const allTracks = (epEntry && epEntry.tracks) || [];
        const tracks = pickPreferredTracks(allTracks);

        const streams = [];
        const seenUrls = new Set();

        if (tracks.length > 0) {
            const langJobs = tracks.map((track) =>
                Promise.allSettled(
                    [3, 2, 1].map((resolution) =>
                        getVideoByLanguage(secKey, activeId, episodeId, String(track.languageId), resolution)
                            .then((raw) => ({ raw, resolution, track }))
                    )
                )
            );
            const allResults = await Promise.all(langJobs);

            for (const trackResults of allResults) {
                for (const r of trackResults) {
                    if (r.status !== 'fulfilled') continue;
                    const { raw, resolution, track } = r.value;
                    const langLabel = `[${track.languageName || track.abbreviate || 'Unknown'}]`;
                    for (const s of buildCastleStreams(raw, langLabel, titleLine, resolution)) {
                        if (!seenUrls.has(s.url)) {
                            seenUrls.add(s.url);
                            streams.push(s);
                        }
                    }
                }
            }
        }

        if (streams.length === 0) {
            const sharedResults = await Promise.allSettled(
                [3, 2, 1].map((resolution) =>
                    getVideoShared(secKey, activeId, episodeId, resolution)
                        .then((raw) => ({ raw, resolution }))
                )
            );
            for (const r of sharedResults) {
                if (r.status !== 'fulfilled') continue;
                const { raw, resolution } = r.value;
                for (const s of buildCastleStreams(raw, '', titleLine, resolution)) {
                    if (!seenUrls.has(s.url)) {
                        seenUrls.add(s.url);
                        streams.push(s);
                    }
                }
            }
        }

        console.log(`[CastleTV] Got ${streams.length} stream(s) for "${title}"`);
        return streams;
    } catch (err) {
        console.error(`[CastleTV] Error: ${err.message}`);
        return [];
    }
}

module.exports = { getCastletvStreams };