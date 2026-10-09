// Lightweight proxy/m3u8/segment/subtitle rewriting layer. thanks to https://github.com/cinepro-org/ for the original code.
// Adapted from external project (user supplied) to fit CommonJS style and existing config system.
// Provides conditional route registration via enableProxy flag.

const cors = require('cors');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');

// One shared, bounded connection pool per upstream scheme.
//
// Why this matters with more than one user: node-fetch used a fresh socket per request with keep-alive
// effectively off, so N simultaneous viewers meant N concurrent sockets AND N full TLS handshakes. Past a
// few dozen that is where a server starts failing its own users -- upstream hosts rate-limit the burst, local
// ephemeral ports and file descriptors run out, and requests queue behind each other until they time out.
// That presents as "the site got glitchy with a few people watching".
//
// The caps are generous for a household/small server but bounded, and maxSockets queues rather than refusing,
// so a spike degrades into waiting instead of errors. `timeout` stops a dead upstream from holding a socket
// forever. DISABLE_KEEPALIVE=true restores the old per-request behaviour.
const KEEPALIVE = process.env.DISABLE_KEEPALIVE !== 'true';
const MAX_SOCKETS = Number(process.env.PROXY_MAX_SOCKETS) || 64;
const FREE_SOCKET_TIMEOUT_MS = 15000;
// NOTE: deliberately NO `timeout` here. An http.Agent's `timeout` only *emits* a 'timeout' event on the
// socket; it does not abort the request, and with nothing listening the request hangs indefinitely instead of
// failing. Setting it made every proxied fetch hang -- measured: the same manifest took 725ms direct and never
// returned through the proxy. `freeSocketTimeout` is the safe variant: it only reaps sockets sitting IDLE in
// the pool. Per-request timeouts already exist (node-fetch `timeout` at the call sites, and the aggregate's
// own soft deadline), so the agent does not need one.
const agentOptions = { keepAlive: KEEPALIVE, maxSockets: MAX_SOCKETS, maxFreeSockets: 16, freeSocketTimeout: FREE_SOCKET_TIMEOUT_MS };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);
// node-fetch reads the agent per-request, so it is threaded through explicitly at each call site.
const agentFor = url => (String(url).startsWith('http://') ? httpAgent : httpsAgent);

const CACHE_MAX_SIZE = 2000;
const CACHE_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours
const segmentCache = new Map();

// Segment prefetch, bounded.
//
// A variant playlist lists every segment in the episode -- measured at 354 for One Piece S21E1. Serving it
// used to fire ALL of them at once (Promise.all over the whole list), and that saturated the upstream: the
// player's own request for the FIRST segment then queued behind 353 strangers and took 11.4s, where the same
// request on an idle server took 43ms. That gap is the "3-8 seconds of spinner before video" symptom.
//
// So: a small worker pool, a short head-only window (the start is all a player needs to begin), and a hard
// rule that a real request always wins the upstream. Background prefetch is a bonus, never a competitor.
const PREFETCH_CONCURRENCY = 2;   // deliberately small; these hosts throttle badly under load
const PREFETCH_HEAD_SEGMENTS = 4;  // only the first few segments matter for instant start
const prefetchQueue = [];
let prefetchActive = 0;
let realRequestsInFlight = 0;      // while > 0, prefetch workers stand down

// Track first open-ended (bytes=0-) range per target to clamp only once per TTL window
const openRangeClampMap = new Map();
const OPEN_RANGE_CLAMP_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Progressive open-ended growth tracking: keeps expanding bytes=0- served window.
const progressiveOpenMap = new Map(); // url -> { lastEnd }
// Tail prefetch cache: stores last N KB for quick tail range responses
const tailPrefetchMap = new Map(); // url -> { data: Buffer, start: number, end: number, size: number, ts: number }
const TAIL_PREFETCH_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isCacheDisabled() {
    return process.env.DISABLE_CACHE === 'true';
}

function cleanupCache() {
    const now = Date.now();
    for (const [url, entry] of segmentCache.entries()) {
        if (now - entry.timestamp > CACHE_EXPIRY_MS) segmentCache.delete(url);
    }
    if (segmentCache.size > CACHE_MAX_SIZE) {
        const entries = Array.from(segmentCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = entries.slice(0, segmentCache.size - CACHE_MAX_SIZE);
        toRemove.forEach(([u]) => segmentCache.delete(u));
    }
    return segmentCache.size;
}
setInterval(cleanupCache, 30 * 60 * 1000).unref();

function cleanupClampMap() {
    const now = Date.now();
    for (const [url, ts] of openRangeClampMap.entries()) {
        if (now - ts > OPEN_RANGE_CLAMP_TTL_MS) openRangeClampMap.delete(url);
    }
}
setInterval(cleanupClampMap, 10 * 60 * 1000).unref();

function cleanupTailPrefetch() {
    const now = Date.now();
    for (const [url, entry] of tailPrefetchMap.entries()) {
        if (now - entry.ts > TAIL_PREFETCH_TTL_MS) tailPrefetchMap.delete(url);
    }
}
setInterval(cleanupTailPrefetch, 15 * 60 * 1000).unref();

function getCachedSegment(url) {
    if (isCacheDisabled()) return null;
    const e = segmentCache.get(url);
    if (!e) return null;
    if (Date.now() - e.timestamp > CACHE_EXPIRY_MS) { segmentCache.delete(url); return null; }
    return e;
}

// Pull one prefetched segment. Skipped entirely while a real request is in flight, and paused between
// fetches, so background work can never be what delays the video the user actually asked for.
async function prefetchSegment(url, headers) {
    if (isCacheDisabled() || segmentCache.size >= CACHE_MAX_SIZE) return;
    const existing = segmentCache.get(url);
    if (existing && Date.now() - existing.timestamp <= CACHE_EXPIRY_MS) return;
    try {
        if (prefetchSuppressed()) return;                     // a real request outranks us
        const resp = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, ...headers }, agent: agentFor(url) });
        if (!resp.ok) return;
        const data = new Uint8Array(await resp.arrayBuffer());
        const responseHeaders = {};
        resp.headers.forEach((v, k) => responseHeaders[k] = v);
        segmentCache.set(url, { data, headers: responseHeaders, timestamp: Date.now() });
    } catch (_e) { /* ignore */ }
}

// Queue the head of a playlist for background warming. Anything past PREFETCH_HEAD_SEGMENTS is not queued:
// the player only needs the start to begin, and fetching the tail speculatively is what caused the stall.
function prefetchHead(segmentUrls, headers) {
    if (isCacheDisabled() || !segmentUrls.length) return;
    for (const url of segmentUrls.slice(0, PREFETCH_HEAD_SEGMENTS)) {
        if (prefetchQueue.includes(url)) continue;
        prefetchQueue.push(url);
        if (prefetchQueue.length > PREFETCH_HEAD_SEGMENTS * 4) prefetchQueue.shift();  // bound memory
    }
    drainPrefetchQueue(headers);
}

async function drainPrefetchQueue(headers) {
    while (prefetchActive < PREFETCH_CONCURRENCY && prefetchQueue.length) {
        if (prefetchSuppressed()) { await sleep(120); continue; }   // yield to the player
        const url = prefetchQueue.shift();
        prefetchActive++;
        prefetchSegment(url, headers)
            .catch(() => undefined)
            .then(() => { prefetchActive--; });
    }
}

// Marks the start and end of a genuine client request, so prefetch can stand down while one is open.
// Clamped at zero and paired with a staleness reset: if a 'close' were ever missed, a permanently positive
// count would silently disable prefetching for the life of the process, which is far worse than a stale
// prefetch. Correctness of playback must not depend on this counter staying exact.
let realRequestStartedAt = 0;
function beginRealRequest() { realRequestsInFlight++; realRequestStartedAt = Date.now(); }
function endRealRequest() {
  realRequestsInFlight = Math.max(0, realRequestsInFlight - 1);
  if (realRequestsInFlight === 0) realRequestStartedAt = 0;
}
function prefetchSuppressed() {
  // A request that has been "in flight" for minutes is a leak, not a slow client.
  if (realRequestsInFlight > 0 && realRequestStartedAt && Date.now() - realRequestStartedAt > 30 * 1000) {
    realRequestsInFlight = 0;
    realRequestStartedAt = 0;
  }
  return realRequestsInFlight > 0;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));


const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function inferContentType(upstreamCT, targetUrl) {
    const bad = !upstreamCT || /application\/octet-stream/i.test(upstreamCT) || /application\/(x-)?zip/i.test(upstreamCT);
    if (!bad) return upstreamCT;
    if (/\.mkv(\?|$)/i.test(targetUrl)) return 'video/x-matroska';
    if (/\.mp4(\?|$)/i.test(targetUrl)) return 'video/mp4';
    if (/\.m3u8(\?|$)/i.test(targetUrl)) return 'application/vnd.apple.mpegurl';
    if (/\.ts(\?|$)/i.test(targetUrl)) return 'video/mp2t';
    return 'application/octet-stream';
}

function extractOriginalUrl(proxyUrl) {
    try {
        const url = new URL(proxyUrl);
        if (url.pathname.includes('/proxy/')) {
            const m = url.pathname.match(/\/proxy\/(.+)$/);
            if (m) {
                let decoded = decodeURIComponent(m[1]);
                while (decoded.includes('%2F')) {
                    try { decoded = decodeURIComponent(decoded); } catch { break; }
                }
                if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
                // If it's just a path (like Vidlink /proxy/wiwii/...), keep the full original URL
                return proxyUrl;
            }
        }
        if (url.searchParams.has('url')) return decodeURIComponent(url.searchParams.get('url'));
        const patterns = [
            /\/api\/[^/]+\/proxy\?url=(.+)$/,
            /\/proxy\?.*url=([^&]+)/,
            /\/stream\/proxy\/(.+)$/,
            /\/p\/(.+)$/
        ];
        for (const p of patterns) {
            const m = proxyUrl.match(p); if (m) return decodeURIComponent(m[1]);
        }
        return proxyUrl;
    } catch { return proxyUrl; }
}

function rewriteM3u8(content, targetUrl, baseProxyUrl, headers) {
    const lines = content.split('\n');
    const out = []; const segmentUrls = [];
    // Hosts like anixo serve variants and segments from the same extensionless path
    // (/api/stream/m3u8?t=...), so the URL alone cannot say which it is. The line above it can: a URI on
    // the line right after #EXT-X-STREAM-INF is another playlist, anything else on a bare line is media.
    let afterVariantTag = false;
    for (const line of lines) {
        if (line.startsWith('#')) {
            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                afterVariantTag = true;
                out.push(line);
            } else if (line.startsWith('#EXT-X-KEY:')) {
                const regex = /https?:\/\/[^""\s]+/g; const keyUrl = regex.exec(line)?.[0];
                if (keyUrl) {
                    const proxyUrl = `${baseProxyUrl}/ts-proxy?url=${encodeURIComponent(keyUrl)}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
                    out.push(line.replace(keyUrl, proxyUrl));
                    if (!isCacheDisabled()) prefetchSegment(keyUrl, headers);
                } else out.push(line);
            } else if (line.startsWith('#EXT-X-MEDIA:') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
                const uriMatch = line.match(/URI="([^"]+)"/);
                if (uriMatch) {
                    try {
                        const mediaUrl = new URL(uriMatch[1], targetUrl).href;
                        const proxyUrl = `${baseProxyUrl}/m3u8-proxy?url=${encodeURIComponent(mediaUrl)}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
                        out.push(line.replace(uriMatch[1], proxyUrl));
                    } catch { out.push(line); }
                } else out.push(line);
            } else out.push(line);
        } else if (line.trim()) {
            try {
                const abs = new URL(line, targetUrl).href;
                // The old check demanded a dot before "m3u8", so extensionless playlist paths were left
                // unproxied and the browser fetched them without the Referer the host requires (403).
                if (afterVariantTag || /\.m3u8(\?|$)/i.test(abs)) {
                    out.push(`${baseProxyUrl}/m3u8-proxy?url=${encodeURIComponent(abs)}&headers=${encodeURIComponent(JSON.stringify(headers))}`);
                } else {
                    segmentUrls.push(abs);
                    out.push(`${baseProxyUrl}/ts-proxy?url=${encodeURIComponent(abs)}&headers=${encodeURIComponent(JSON.stringify(headers))}`);
                }
                afterVariantTag = false;
            } catch { out.push(line); }
        } else out.push(line);
    }
    if (segmentUrls.length && !isCacheDisabled()) {
        // Was: Promise.all(segmentUrls.map(prefetchSegment)) -- every segment in the episode (354 measured)
        // fired at once, and the player's own first-segment request queued behind all of them for ~11s.
        prefetchHead(segmentUrls, headers);
    }
    return out.join('\n');
}

function createProxyRoutes(app) {
    // m3u8 playlist proxy
    app.get('/m3u8-proxy', cors(), async (req, res) => {
        const targetUrl = req.query.url; if (!targetUrl) return res.status(400).json({ error: 'URL parameter required' });
        let headers = {};
        try { headers = JSON.parse(req.query.headers || '{}'); } catch {
            // Ignore URL parsing errors
        }
        try {
            const response = await fetch(targetUrl, { headers: { 'User-Agent': DEFAULT_UA, ...headers }, agent: agentFor(targetUrl) });
            if (!response.ok) return res.status(response.status).json({ error: `M3U8 fetch failed: ${response.status}` });
            const text = await response.text();
            const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
            const baseProxyUrl = `${protocol}://${req.get('host')}`;
            const rewritten = rewriteM3u8(text, targetUrl, baseProxyUrl, headers);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.send(rewritten);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ts / key segment proxy
    app.get('/ts-proxy', cors(), async (req, res) => {
        // A genuine player request. Prefetch workers stand down while any of these is open, so background
        // warming can never be the reason the video the user clicked is slow to start.
        beginRealRequest();
        res.on('close', endRealRequest);
        const targetUrl = req.query.url; if (!targetUrl) return res.status(400).json({ error: 'URL parameter required' });
        const debug = req.query.debug === '1';
        const noSynth = req.query.noSynth === '1';
        const force200 = req.query.force200 === '1';
        const clampOpen = req.query.clampOpen !== '0';
        const progressiveOpen = req.query.progressiveOpen !== '0';
        const tailPrefetchEnabled = req.query.tailPrefetch !== '0';
        let tailPrefetchKB = parseInt(req.query.tailPrefetchKB || '256', 10);
        if (isNaN(tailPrefetchKB) || tailPrefetchKB < 64) tailPrefetchKB = 256;
        if (tailPrefetchKB > 2048) tailPrefetchKB = 2048; // max 2MB tail window
        let openChunkKB = parseInt(req.query.openChunkKB || '4096', 10);
        if (isNaN(openChunkKB) || openChunkKB < 64) openChunkKB = 4096;
        if (openChunkKB > 16384) openChunkKB = 16384; // cap at 16MB
        let initChunkKB = parseInt(req.query.initChunkKB || '512', 10);
        if (isNaN(initChunkKB) || initChunkKB < 64) initChunkKB = 512;
        if (initChunkKB > 2048) initChunkKB = 2048; // hard cap 2MB
        let headers = {}; try { headers = JSON.parse(req.query.headers || '{}'); } catch {
            // Ignore URL parsing errors
        }
        // Pass through Range header for progressive playback / seeking
        const range = req.headers['range'];
        let appliedClamp = false;
        let effectiveRange = range;
        if (range) headers.Range = range;
        // Clamp first open-ended bytes=0- request to a bounded span (once per TTL) to avoid gigantic initial 206
        if (range && /^bytes=0-\s*$/i.test(range) && !force200) {
            const now = Date.now();
            // Progressive growth supersedes single-shot clamp if enabled
            if (progressiveOpen) {
                const prog = progressiveOpenMap.get(targetUrl) || { lastEnd: -1 };
                const prevEnd = prog.lastEnd;
                let nextEnd;
                if (prog.lastEnd < 0) {
                    nextEnd = openChunkKB * 1024 - 1;
                } else {
                    const increment = openChunkKB * 1024;
                    nextEnd = prog.lastEnd + increment;
                    const maxCap = 256 * 1024 * 1024 - 1; // 256MB
                    if (nextEnd > maxCap) nextEnd = maxCap;
                }
                const newRange = `bytes=0-${nextEnd}`;
                headers.Range = newRange;
                effectiveRange = newRange;
                prog.lastEnd = nextEnd;
                progressiveOpenMap.set(targetUrl, prog);
                appliedClamp = true; // reuse flag for logging
                if (debug) console.log('[ts-proxy] progressiveOpen expand', { prevEnd, nextEnd, increment: openChunkKB * 1024 });
            } else if (clampOpen) {
                const lastTs = openRangeClampMap.get(targetUrl);
                if (!lastTs || (now - lastTs) > OPEN_RANGE_CLAMP_TTL_MS) {
                    const clampBytes = openChunkKB * 1024;
                    const newRange = `bytes=0-${clampBytes - 1}`;
                    headers.Range = newRange;
                    effectiveRange = newRange;
                    openRangeClampMap.set(targetUrl, now);
                    appliedClamp = true;
                }
            }
        }
        if (debug) console.log('[ts-proxy] incoming', { url: targetUrl, range, effectiveRange, appliedClamp, clampOpen, progressiveOpen, openChunkKB, noSynth, initChunkKB, force200, tailPrefetchEnabled, tailPrefetchKB });
        if (!isCacheDisabled()) {
            const cached = getCachedSegment(targetUrl);
            if (cached) {
                const ct = inferContentType(cached.headers['content-type'], targetUrl);
                res.setHeader('Content-Type', ct);
                res.setHeader('Cache-Control', 'public, max-age=3600');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Accept-Ranges', 'bytes');
                if (debug) console.log('[ts-proxy] cache hit');
                return res.send(Buffer.from(cached.data));
            }
        }
        try {
            // If we have a tail prefetch entry and the client requests a tail range fully inside it, serve from memory early.
            if (effectiveRange && /^bytes=\d+-$/i.test(effectiveRange)) {
                const tailEntry = tailPrefetchMap.get(targetUrl);
                if (tailEntry) {
                    const m = effectiveRange.match(/bytes=(\d+)-/i);
                    if (m) {
                        const startReq = parseInt(m[1], 10);
                        if (!isNaN(startReq) && startReq >= tailEntry.start && startReq <= tailEntry.end) {
                            const offset = startReq - tailEntry.start;
                            const slice = tailEntry.data.subarray(offset);
                            const endByte = tailEntry.end;
                            res.status(206);
                            const ct = inferContentType(null, targetUrl);
                            res.setHeader('Content-Type', ct);
                            res.setHeader('Accept-Ranges', 'bytes');
                            res.setHeader('Content-Length', slice.length.toString());
                            res.setHeader('Content-Range', `bytes ${startReq}-${endByte}/${tailEntry.size}`);
                            res.setHeader('Cache-Control', 'public, max-age=3600');
                            res.setHeader('Access-Control-Allow-Origin', '*');
                            if (debug) console.log('[ts-proxy] tail serve hit', { startReq, cachedStart: tailEntry.start, cachedEnd: tailEntry.end, size: tailEntry.size });
                            return res.end(slice);
                        }
                    }
                }
            }

            // HEAD preflight (only when no explicit Range requested) to get size for synthesized partial response
            let contentLength = null;
            let upstreamAcceptRanges = null;
            if (!effectiveRange) {
                try {
                    const headResp = await fetch(targetUrl, { method: 'HEAD', headers: { 'User-Agent': DEFAULT_UA, ...headers }, agent: agentFor(targetUrl) });
                    if (headResp.ok) {
                        contentLength = headResp.headers.get('content-length');
                        upstreamAcceptRanges = headResp.headers.get('accept-ranges');
                        if (debug) console.log('[ts-proxy] HEAD ok', { contentLength, upstreamAcceptRanges });
                    } else if (debug) {
                        console.log('[ts-proxy] HEAD status', headResp.status);
                    }
                } catch (_e) { if (debug) console.log('[ts-proxy] HEAD failed'); }
            }

            // Fallback probe: if still no size, attempt a 0-0 range request to derive total size from Content-Range
            if (!effectiveRange && !contentLength) {
                try {
                    const probeRange = 'bytes=0-0';
                    if (debug) console.log('[ts-proxy] probe range');
                    const probeResp = await fetch(targetUrl, { headers: { 'User-Agent': DEFAULT_UA, ...headers, 'Range': probeRange }, agent: agentFor(targetUrl) });
                    if (probeResp.status === 206) {
                        const cr = probeResp.headers.get('content-range');
                        if (cr) {
                            const m = cr.match(/\/(\d+)$/); if (m) contentLength = m[1];
                        }
                        try { await probeResp.arrayBuffer(); } catch (readErr) {
                            if (debug) console.log('[ts-proxy] probe body read failed', readErr.message);
                        }
                        if (debug) console.log('[ts-proxy] probe success', { contentLength });
                    } else if (debug) {
                        console.log('[ts-proxy] probe status', probeResp.status);
                    }
                } catch (_e) { if (debug) console.log('[ts-proxy] probe failed'); }
            }
            if (debug && contentLength) console.log('[ts-proxy] size determined', contentLength);

            // Initiate tail prefetch asynchronously (once) when size known and feature enabled
            if (tailPrefetchEnabled && contentLength && !tailPrefetchMap.has(targetUrl)) {
                const total = parseInt(contentLength, 10);
                if (!isNaN(total) && total > 0) {
                    const tailBytes = Math.min(tailPrefetchKB * 1024, total);
                    const start = Math.max(0, total - tailBytes);
                    const tailRange = `bytes=${start}-`;
                    (async () => {
                        try {
                            if (debug) console.log('[ts-proxy] tail prefetch start', { tailRange });
                            const tr = await fetch(targetUrl, { headers: { 'User-Agent': DEFAULT_UA, ...headers, Range: tailRange }, agent: agentFor(targetUrl) });
                            if (tr.status === 206) {
                                const buf = Buffer.from(await tr.arrayBuffer());
                                const cr = tr.headers.get('content-range');
                                if (cr) {
                                    const mm = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
                                    if (mm) {
                                        const s = parseInt(mm[1], 10); const e = parseInt(mm[2], 10); const sz = parseInt(mm[3], 10);
                                        if (!isNaN(s) && !isNaN(e) && !isNaN(sz)) {
                                            tailPrefetchMap.set(targetUrl, { data: buf, start: s, end: e, size: sz, ts: Date.now() });
                                            if (debug) console.log('[ts-proxy] tail prefetch success', { start: s, end: e, bytes: buf.length });
                                        }
                                    }
                                }
                            } else if (debug) {
                                console.log('[ts-proxy] tail prefetch status', tr.status);
                            }
                        } catch (e) { if (debug) console.log('[ts-proxy] tail prefetch error', e.message); }
                    })();
                }
            }

            // If no range requested but we now know size (HEAD or probe), synthesize an initial small range fetch to accelerate playback.
            if (!force200 && !effectiveRange && contentLength && !noSynth && req.query.progressiveOpen === '0') {
                const total = parseInt(contentLength, 10);
                const desired = initChunkKB * 1024;
                const chunkSize = Math.min(desired, Math.max(0, total - 1));
                const syntheticRange = `bytes=0-${chunkSize}`;
                const resp = await fetch(targetUrl, { headers: { 'User-Agent': DEFAULT_UA, ...headers, 'Range': syntheticRange }, agent: agentFor(targetUrl) });
                if (resp.status === 206) {
                    if (debug) console.log('[ts-proxy] synthetic 206', syntheticRange);
                    const upstreamCT = inferContentType(resp.headers.get('content-type'), targetUrl);
                    res.status(206);
                    res.setHeader('Content-Type', upstreamCT);
                    res.setHeader('Accept-Ranges', upstreamAcceptRanges || 'bytes');
                    const contentRange = resp.headers.get('content-range');
                    if (contentRange) res.setHeader('Content-Range', contentRange);
                    const cl = resp.headers.get('content-length'); if (cl) res.setHeader('Content-Length', cl);
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    // Pipe first chunk then leave connection open? Simpler: end after chunk; player will request next range.
                    return resp.body.pipe(res);
                }
                // If server ignored range (e.g., returned 200), fall through to normal logic below.
            }

            const upstreamOptions = { headers: { 'User-Agent': DEFAULT_UA, ...headers }, agent: agentFor(targetUrl) };
            // If client supplied a suffix range like bytes=0- we pass it; force200 strips Range
            if (force200 && headers.Range) delete headers.Range;
            const resp = await fetch(targetUrl, upstreamOptions);
            if (!resp.ok && resp.status !== 206) {
                if (debug) console.log('[ts-proxy] upstream error', resp.status);
                return res.status(resp.status).json({ error: `TS fetch failed: ${resp.status}` });
            }
            // Forward partial content status when range used
            if (effectiveRange && resp.status === 206 && !force200) { res.status(206); if (debug) console.log('[ts-proxy] forwarding 206', { appliedClamp }); }
            if (force200 && resp.status === 206) {
                // Some origins still return 206 even without Range; normalize to 200 for players expecting full stream
                if (debug) console.log('[ts-proxy] normalizing 206 -> 200 due to force200');
            }
            // Copy key streaming headers
            const upstreamCT = inferContentType(resp.headers.get('content-type'), targetUrl);
            res.setHeader('Content-Type', upstreamCT);
            let cl = resp.headers.get('content-length');
            const crHeader = resp.headers.get('content-range');
            if (!cl && crHeader) {
                // Try to derive length from range span
                const m = crHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
                if (m) {
                    const start = parseInt(m[1], 10); const end = parseInt(m[2], 10);
                    if (!isNaN(start) && !isNaN(end)) cl = (end - start + 1).toString();
                }
            }
            if (cl) res.setHeader('Content-Length', cl);
            const acceptRanges = resp.headers.get('accept-ranges');
            // Advertise seeking only when ranges actually work. If the client asked for a
            // Range and the upstream answered 200, it ignored the Range: claiming
            // `Accept-Ranges: bytes` there makes players (mpv especially) seek-spiral --
            // every seek restarts a full multi-GB download and playback wedges. Saying
            // nothing makes them stream progressively instead.
            if (resp.status === 206) {
                res.setHeader('Accept-Ranges', acceptRanges || 'bytes');
            } else if (!effectiveRange) {
                res.setHeader('Accept-Ranges', upstreamAcceptRanges || acceptRanges || 'bytes');
            }
            const contentRange = resp.headers.get('content-range'); if (contentRange && !force200) res.setHeader('Content-Range', contentRange);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Access-Control-Allow-Origin', '*');
            if (debug) console.log('[ts-proxy] streaming body', { status: resp.status, ct: upstreamCT, cl, contentRange: force200 ? undefined : contentRange });
            resp.body.pipe(res);
        } catch (e) { if (debug) console.log('[ts-proxy] exception', e.message); res.status(500).json({ error: e.message }); }
    });

    // subtitle proxy
    app.get('/sub-proxy', cors(), async (req, res) => {
        const targetUrl = req.query.url; if (!targetUrl) return res.status(400).json({ error: 'url parameter required' });
        let headers = {}; try { headers = JSON.parse(req.query.headers || '{}'); } catch {
            // Ignore URL parsing errors
        }
        try {
            const resp = await fetch(targetUrl, { headers: { 'User-Agent': DEFAULT_UA, ...headers }, agent: agentFor(targetUrl) });
            if (!resp.ok) return res.status(resp.status).json({ error: `subtitle fetch failed: ${resp.status}` });
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Content-Type', resp.headers.get('content-type') || 'text/vtt');
            resp.body.pipe(res);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
}

function processStreamsForProxy(streams, serverUrl) {
    if (!Array.isArray(streams)) return streams;
    return streams.map(s => {
        if (!s || !s.url || typeof s.url !== 'string') return s;
        const original = extractOriginalUrl(s.url);
        const headers = s.headers || {};
        const hParam = Object.keys(headers).length ? `&headers=${encodeURIComponent(JSON.stringify(headers))}` : '';
        let host = '';
        try {
            host = new URL(original).hostname.toLowerCase();
        } catch {
            // Ignore errors
        }
        // Force specific hosts through ts-proxy (direct file style) even without extension
        if (host.includes('pixeldrain.') || host === 'video-downloads.googleusercontent.com') {
            return { ...s, url: `${serverUrl}/ts-proxy?url=${encodeURIComponent(original)}${hParam}` };
        }
        if (/\.(mp4|mkv)(\?|$)/i.test(original)) {
            return { ...s, url: `${serverUrl}/ts-proxy?url=${encodeURIComponent(original)}${hParam}` };
        }
        return { ...s, url: `${serverUrl}/m3u8-proxy?url=${encodeURIComponent(original)}${hParam}` };
    });
}

module.exports = { createProxyRoutes, processStreamsForProxy };