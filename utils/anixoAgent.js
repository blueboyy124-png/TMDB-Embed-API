// One kept-alive connection for every anixo request in this process.
//
// Why this exists: anixo's stream tokens are bound to the client IP that requested them -- fetching one
// from another IP is answered 403 "Invalid or Expired Cryptographic Stream Token ... generated for a
// different client IP address". On a network that hands out a DIFFERENT public IP per outbound connection
// (VPNs such as ExpressVPN, some school/office/carrier networks) the lookup and the playback therefore have
// to travel over the SAME socket, or anixo sees two different clients.
//
// Why NOT undici any more: measured on such a network, node's built-in https.Agent({ keepAlive,
// maxSockets: 1 }) held ONE socket (same public IP and same local port for every request, 1.5s apart),
// while undici -- both Agent and Client, connections:1 -- opened a fresh socket per request and changed IP
// every time. So anixo traffic now goes through anixoFetch() below, which rides a native https.Agent and
// returns an object shaped like the fetch Response the call sites already use (ok/status/headers.get +
// forEach/text/json/arrayBuffer and a Node Readable `body`). Everything that is NOT anixo keeps using the
// normal global fetch.
//
// Trade-offs, on purpose:
//   - maxSockets:1 serialises anixo requests. That is what its anti-bot layer prefers anyway (see
//     ANIXO_CONCURRENCY in providers/anime.js) and it is the only way to keep one IP.
//   - If that socket is ever lost (the server or network closes it, or a request is aborted before its
//     headers arrive), the next request opens a new one -- possibly a new IP -- and tokens made earlier stop
//     working. A body that the client abandons mid-download is DRAINED, not destroyed, so a seek or a closed
//     tab does not throw the connection away.
const https = require('https');
const zlib = require('zlib');
const { PassThrough } = require('stream');
const { Agent } = require('undici');

const ANIXO_HOSTS = /(^|\.)anixo\.(buzz|com|site|tv|xyz|cloud)$/i;

function isAnixo(url) {
    try {
        const h = new URL(url).hostname.toLowerCase();
        return ANIXO_HOSTS.test(h) || h === 'anixo.buzz';
    } catch { return false; }
}

const nativeAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 1, maxFreeSockets: 1, scheduling: 'fifo' });

const MAX_REDIRECTS = 5;

function abortError(signal) {
    const reason = signal && signal.reason;
    if (reason instanceof Error) return reason;
    const e = new Error(reason ? String(reason) : 'The operation was aborted');
    e.name = 'AbortError';
    return e;
}

// One request, no redirect handling. Resolves with the Node IncomingMessage as soon as headers arrive.
function requestOnce(urlObj, { method = 'GET', headers = {}, signal } = {}) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(abortError(signal));
        const h = { 'Accept-Encoding': 'gzip, deflate', ...headers };
        const req = https.request(urlObj, { method, headers: h, agent: nativeAgent }, (res) => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(res);
        });
        const onAbort = () => req.destroy(abortError(signal));   // before headers there is nothing to drain
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        req.on('error', (err) => { if (signal) signal.removeEventListener('abort', onAbort); reject(err); });
        req.end();
    });
}

function decoded(res) {
    const enc = String(res.headers['content-encoding'] || '').toLowerCase();
    if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
    if (enc === 'deflate') return res.pipe(zlib.createInflate());
    if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
    return res;
}

// fetch-like. Only https is handled here; anything else falls back to the global fetch.
async function anixoFetch(url, opts = {}) {
    let target = new URL(url);
    if (target.protocol !== 'https:') return fetch(url, opts);
    const method = opts.method || 'GET';
    let res;
    for (let hop = 0; ; hop++) {
        res = await requestOnce(target, { method, headers: opts.headers, signal: opts.signal });
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc && opts.redirect !== 'manual' && hop < MAX_REDIRECTS) {
            res.resume();                                   // read the small redirect body so the socket stays reusable
            target = new URL(loc, target);
            if (target.protocol !== 'https:') return fetch(target.href, opts);
            continue;
        }
        break;
    }

    // Body handed to callers: a PassThrough, so destroying it early drains the upstream instead of killing the socket.
    const source = decoded(res);
    const body = new PassThrough();
    source.on('error', (err) => body.destroy(err));
    source.pipe(body);
    body.on('close', () => {
        if (!source.readableEnded) { try { source.unpipe(body); source.resume(); } catch (_) { /* ignore */ } }
    });
    body.cancel = () => body.destroy();                     // parity with web ReadableStream.cancel()

    let consumed = null;
    const collect = () => {
        if (!consumed) {
            consumed = new Promise((resolve, reject) => {
                const chunks = [];
                body.on('data', (c) => chunks.push(c));
                body.on('end', () => resolve(Buffer.concat(chunks)));
                body.on('error', reject);
            });
        }
        return consumed;
    };

    const headers = {
        get: (name) => { const v = res.headers[String(name).toLowerCase()]; return v === undefined ? null : (Array.isArray(v) ? v.join(', ') : String(v)); },
        has: (name) => res.headers[String(name).toLowerCase()] !== undefined,
        forEach: (fn) => { for (const [k, v] of Object.entries(res.headers)) fn(Array.isArray(v) ? v.join(', ') : String(v), k); },
    };

    return {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage || '',
        url: target.href,
        headers,
        text: async () => (await collect()).toString('utf8'),
        json: async () => JSON.parse((await collect()).toString('utf8')),
        arrayBuffer: async () => { const b = await collect(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
        get body() { return body; },
    };
}

// Kept so any other caller that still asks for an undici dispatcher keeps working. anixo traffic itself no
// longer uses it -- see anixoFetch above.
let legacyAgent = null;
function dispatcherFor(url) {
    if (!isAnixo(url)) return undefined;
    if (!legacyAgent) legacyAgent = new Agent({ connections: 1, pipelining: 0, keepAliveTimeout: 120000, keepAliveMaxTimeout: 300000 });
    return legacyAgent;
}

module.exports = { dispatcherFor, isAnixo, anixoFetch };