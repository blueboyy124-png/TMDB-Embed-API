// A single, shared undici connection for every anixo request in this process.
//
// Why this exists: anixo's stream tokens are bound to the client IP that requested them -- fetching one
// from another IP is answered 403 "Invalid or Expired Cryptographic Stream Token ... generated for a
// different client IP address". That is normally harmless (one server, one IP), but this network hands
// out a DIFFERENT public IP per outbound connection: the same token fetched over a pooled connection
// returns 200 while a fresh connection returns 403, and back to 200 on the next pooled request.
//
// So the server's ordinary connection pool -- which opens several sockets to a host and may serve the
// resolve on one and the playback fetch on another -- makes anixo look like two different clients. The
// measured symptom is exactly the one reported: anixo resolves fine and then the stream 403s, or works
// on a refresh and not the next time.
//
// Pinning anixo to ONE connection keeps one public IP for the whole resolve -> playback flow. undici
// pools per origin, so other hosts (TMDB, the other providers) keep their normal parallelism; only
// anixo is serialized, which its anti-bot layer prefers anyway (see ANIXO_CONCURRENCY in providers/anime.js).
const { Agent } = require('undici');

const ANIXO_HOSTS = /(^|\.)anixo\.(buzz|com|site|tv|xyz|cloud)$/i;

function isAnixo(url) {
    try {
        const h = new URL(url).hostname.toLowerCase();
        return ANIXO_HOSTS.test(h) || h === 'anixo.buzz';
    } catch { return false; }
}

let agent = null;

// Returns the shared dispatcher for anixo URLs, or undefined for everything else (so callers can pass
// the result straight into a fetch option and let the default pool handle the rest).
function dispatcherFor(url) {
    if (!isAnixo(url)) return undefined;
    if (!agent) {
        agent = new Agent({
            connections: 1,
            pipelining: 0,
            keepAliveTimeout: 120000,
            keepAliveMaxTimeout: 300000,
        });
    }
    return agent;
}

module.exports = { dispatcherFor, isAnixo };
