const axios = require('axios');
const { getTmdbApiKey } = require('../utils/tmdbKey');

const VIDEASY_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://player.videasy.net',
    'Referer': 'https://player.videasy.net/'
};

const VIDEASY_API = 'https://api.speedracelight.com';

// Each server maps a name to its API route. moviesOnly:true skips TV requests.
const SERVERS = {
    'CDN':   { url: `${VIDEASY_API}/cdn/sources-with-title` },
    'LaMovie': { url: `${VIDEASY_API}/lamovie/sources-with-title` },
    'Meine': { url: `${VIDEASY_API}/meine/sources-with-title`, moviesOnly: true }
};

// --- Seed-based response decryption (mirrors player.videasy.net) ---
const MAGIC = [109, 118, 109, 49]; // "mvm1"
const HASH_TABLE = [1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580];

function u32x(x) { return x >>> 0; }
function mul32(a, b) { return Math.imul(a, b) >>> 0; }
function rotl32(x, n) {
    x >>>= 0;
    n &= 31;
    return n === 0 ? x : ((x << n) | (x >>> (32 - n))) >>> 0;
}
function hash32(x) {
    x = u32x(x);
    x ^= x >>> 16;
    x = mul32(x, 2246822507);
    x ^= x >>> 13;
    x = mul32(x, 3266489909);
    x ^= x >>> 16;
    return u32x(x);
}
function fnv1a(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = mul32(h ^ str.charCodeAt(i), 16777619);
    return hash32(h);
}
function initStream(seed, secondKey) {
    const S = new Array(61);
    let a = u32x(hash32(fnv1a(seed) ^ hash32(u32x((secondKey >>> 0) ^ 2654435769))));
    for (let i = 0; i < 8; i++) {
        if ((i * (i + 1) & 1) === 0) {
            const idx = a % 61;
            a = rotl32(a + u32x(2654435769), 7 + (7 & i));
            S[idx] = u32x(a ^ hash32(a));
            a = hash32(u32x(a + idx));
        } else {
            S[i] = HASH_TABLE[15 & i];
        }
    }
    return { S, acc: u32x(hash32(2779096485 ^ a)) };
}
function nextByte(st, ctr) {
    const r = st.S;
    const o = st.acc;
    const n = o % 61;
    const inSet = 0 - Number(n in r);
    const d = r[n] >>> 0;
    const x = u32x(d ^ mul32(2654435769, ctr + 1));
    const y = u32x((o ^ x) | (o & x & inSet));
    const no = hash32(u32x(rotl32(u32x(y + o), 31 & n) ^ rotl32(o, 31 & Math.imul(n, 7))) + 2654435769);
    r[n] = no >>> 0;
    st.acc = no;
    return no >>> 0;
}
function keystream(seed, secondKey, len) {
    const st = initStream(seed, secondKey);
    const out = new Uint8Array(len);
    let ctr = 0;
    for (let i = 0; i < len;) {
        const b = nextByte(st, ctr++);
        out[i++] = 255 & b;
        if (i < len) out[i++] = (b >>> 8) & 255;
        if (i < len) out[i++] = (b >>> 16) & 255;
        if (i < len) out[i++] = (b >>> 24) & 255;
    }
    return out;
}
function decryptPayload(payload, seed, secondKey) {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(4 * Math.ceil(payload.length / 4), '=');
    const data = Buffer.from(b64, 'base64');
    const ks = keystream(seed, secondKey, data.length);
    for (let i = 0; i < data.length; i++) data[i] ^= ks[i];
    for (let i = 0; i < MAGIC.length; i++) {
        if (data[i] !== MAGIC[i]) throw new Error('Invalid encrypted payload');
    }
    return data.subarray(MAGIC.length).toString('utf8');
}

async function getVideasyStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[Videasy] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    const tmdbKey = getTmdbApiKey();
    if (!tmdbKey) {
        console.error('[Videasy] No TMDB API key configured.');
        return [];
    }

    // Step 1: Resolve title/year/imdbId from TMDB
    let details;
    try {
        const type = mediaType === 'tv' ? 'tv' : 'movie';
        const { data } = await axios.get(
            `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${tmdbKey}&append_to_response=external_ids`,
            { timeout: 8000 }
        );
        details = {
            title: data.title || data.name || '',
            year: (data.release_date || data.first_air_date || '').split('-')[0],
            imdbId: (data.external_ids && data.external_ids.imdb_id) || '',
            type
        };
    } catch (err) {
        console.error(`[Videasy] TMDB lookup failed: ${err.message}`);
        return [];
    }

    if (!details.title) {
        console.error('[Videasy] No title returned from TMDB.');
        return [];
    }

    const allStreams = [];
    const seen = new Set();

    // Step 2: Fetch a decryption seed (cached server-side per mediaId, short TTL)
    let seed;
    try {
        const seedRes = await axios.get(`${VIDEASY_API}/seed?mediaId=${tmdbId}`, {
            headers: VIDEASY_HEADERS,
            timeout: 8000
        });
        seed = seedRes.data && seedRes.data.seed;
    } catch (err) {
        console.error(`[Videasy] Seed fetch failed: ${err.message}`);
        return [];
    }
    if (!seed) {
        console.error('[Videasy] No seed returned.');
        return [];
    }

    const queryServers = async (activeSeed) => {
        await Promise.all(Object.entries(SERVERS).map(async ([name, server]) => {
            if (server.moviesOnly && mediaType === 'tv') return;

            let apiUrl = `${server.url}?title=${encodeURIComponent(details.title)}`
                + `&mediaType=${details.type === 'tv' ? 'TV Series' : 'Movie'}&year=${details.year}`
                + `&tmdbId=${tmdbId}&imdbId=${details.imdbId || ''}`;
            if (mediaType === 'tv') apiUrl += `&seasonId=${seasonNum}&episodeId=${episodeNum}`;
            apiUrl += `&enc=2&seed=${activeSeed}`;

            try {
                const encRes = await axios.get(apiUrl, {
                    headers: VIDEASY_HEADERS,
                    timeout: 8000,
                    responseType: 'text'
                });

                const encryptedText = typeof encRes.data === 'string' ? encRes.data : JSON.stringify(encRes.data);
                if (!encryptedText || encryptedText.length < 20 || encryptedText.startsWith('<')) return;

                // Step 3: Decrypt payload locally with the seed cipher
                const plain = decryptPayload(encryptedText, activeSeed, String(tmdbId));
                const resData = JSON.parse(plain);
                if (!resData || !Array.isArray(resData.sources)) return;

                for (const s of resData.sources) {
                    if (!s.url || seen.has(s.url)) continue;
                    seen.add(s.url);
                    allStreams.push({
                        name: `Videasy ${name}`,
                        title: `Videasy ${name} - ${s.quality || 'Auto'}`,
                        url: s.url,
                        quality: s.quality || 'Auto',
                        provider: 'Videasy',
                        headers: {
                            'Referer': 'https://player.videasy.net/',
                            'Origin': 'https://player.videasy.net'
                        }
                    });
                }
                console.log(`[Videasy] Server ${name}: ${resData.sources.length} source(s)`);
            } catch {
                // server unreachable or returned no data — skip silently
            }
        }));
    };

    // Step 4: Query each server in parallel; retry once with a fresh seed if nothing matched
    await queryServers(seed);
    if (allStreams.length === 0) {
        try {
            const seedRes = await axios.get(`${VIDEASY_API}/seed?mediaId=${tmdbId}`, {
                headers: VIDEASY_HEADERS,
                timeout: 8000
            });
            const freshSeed = seedRes.data && seedRes.data.seed;
            if (freshSeed && freshSeed !== seed) await queryServers(freshSeed);
        } catch {
            // ignore retry failure
        }
    }

    console.log(`[Videasy] Total streams: ${allStreams.length}`);
    return allStreams;
}

module.exports = { getVideasyStreams };