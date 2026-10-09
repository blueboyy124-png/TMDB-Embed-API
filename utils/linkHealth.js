/* Link health: stop handing out stream URLs that do not work.
 *
 * The problem this fixes. Providers return links, not playable files. DahmerMovies answered with five
 * streams per title across four different movies and every single one was HTTP 403 -- expired or blocked.
 * Nothing in the pipeline noticed, so the response looked healthy (12 streams, 5 advertised as 4K) and the
 * failure only appeared when you pressed play. Worse, the dead 4K entries sat at the top looking like the
 * best options, which is how "the provider gets nothing" and "it does not look 4K" turned out to be the
 * same bug. Vidlink was the same story with 429. Febbox was fine, and its real 2160p was playable all along.
 *
 * Every stream is probed, manifests included. That was originally wrong: VaPlayer returns manifests that
 * the proxy answers with HTTP 500, and skipping them meant three dead streams survived on every title.
 * The proxy fetches a manifest live anyway, so a probe costs what playback was going to cost regardless.
 *
 * Two rules keep this cheap, because it runs on the request path:
 *  1. Verdicts are cached per URL, so the second request for an episode costs nothing.
 *  2. A provider is only switched off once it is *proven* dead by a sample -- a provider that is merely
 *     slow, or having one bad link, must never be disabled.
 *
 * Only direct-file links are probed. An HLS manifest is fetched fresh by the proxy on every playback
 * anyway, so a cached verdict about one would be stale, and probing it buys nothing.
 */
const { BoundedTtlCache } = require('./boundedCache');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const PROBE_TIMEOUT_MS = Number(process.env.LINK_PROBE_TIMEOUT_MS) || 6000;
const PROBE_CONCURRENCY = Number(process.env.LINK_PROBE_CONCURRENCY) || 8;
// Deliberately short. A link that answers once is not thereby good forever: Vidlink alternates between
// 200 and 429, so a long "alive" TTL freezes a single lucky moment and then hands out dead links for the
// rest of the half hour. Ten minutes still saves the repeated probe on a title you are browsing.
const ALIVE_TTL_MS = Number(process.env.LINK_ALIVE_TTL_MS) || 10 * 60 * 1000;
const DEAD_TTL_MS = Number(process.env.LINK_DEAD_TTL_MS) || 10 * 60 * 1000;

// Bounded, for the same reason every other cache here is: a browsed catalogue must not grow this forever.
const verdictCache = new BoundedTtlCache(Number(process.env.LINK_CACHE_MAX) || 5000);

const providerFailures = new Map();     // name -> { samples, dead, streak, trippedAt }
const TRIP_RATIO = Number(process.env.LINK_BREAKER_RATIO) || 0.8;      // 80% dead
const TRIP_MIN_SAMPLES = Number(process.env.LINK_BREAKER_MIN_SAMPLES) || 5;
// How many CONSECUTIVE bad rounds it takes before a provider is believed to be down. Without this a single
// bad moment could combine with a stale average to switch off something that is merely having a bad day.
const TRIP_MIN_STREAK = Number(process.env.LINK_BREAKER_MIN_STREAK) || 2;
// Old evidence fades by this factor on every new observation, so the ratio tracks recent behaviour.
const DECAY = Number(process.env.LINK_BREAKER_DECAY) || 0.7;
const TRIP_COOLDOWN_MS = Number(process.env.LINK_BREAKER_COOLDOWN_MS) || 5 * 60 * 1000;

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function isManifest(stream) {
  const raw = String((stream && stream.url) || '');
  const m = /[?&]url=([^&]+)/.exec(raw);
  const target = (m && /\/m3u8-proxy|\/ts-proxy/.test(raw)) ? safeDecode(m[1]) : raw;
  return /\.m3u8(\?|#|$)/i.test(target) || /\/m3u8-proxy(\?|$)/i.test(raw);
}

const isFresh = (entry) => (Date.now() - entry.at) < (entry.alive ? ALIVE_TTL_MS : DEAD_TTL_MS);

/** True when this provider is currently believed to be serving nothing usable. */
function isTripped(name) {
  const rec = providerFailures.get(name);
  if (!rec || !rec.trippedAt) return false;
  if (Date.now() - rec.trippedAt > TRIP_COOLDOWN_MS) {
    // Let it be tried again after the cooldown, so a provider that recovers is not written off.
    providerFailures.delete(name);
    return false;
  }
  return true;
}

function trippedProviders() {
  const out = [];
  for (const [name, rec] of providerFailures) {
    if (rec.trippedAt && Date.now() - rec.trippedAt <= TRIP_COOLDOWN_MS) out.push(name);
  }
  return out;
}

/**
 * One probe. HEAD costs no body and reveals 403/429, but some upstreams reject HEAD with 405, which would
 * read as "dead" for a perfectly good link -- so that is retried with a tiny ranged GET first.
 */
function probe(url) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { resolve({ ok: false, reason: 'unparseable' }); return; }
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'HEAD', timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.destroy();
      const code = res.statusCode || 0;
      if (code >= 200 && code < 400) { resolve({ ok: true, code }); return; }
      if (code === 405 || code === 501) { retryGet(parsed, mod, resolve); return; }
      resolve({ ok: false, code, reason: `HTTP ${code}` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, reason: e.message }));
    req.end();
  });
}

function retryGet(parsed, mod, resolve) {
  try {
    const req = mod.request(parsed, {
      method: 'GET', timeout: PROBE_TIMEOUT_MS, headers: { Range: 'bytes=0-1' }
    }, (res) => {
      res.destroy();
      const code = res.statusCode || 0;
      resolve(code >= 200 && code < 400 ? { ok: true, code } : { ok: false, code, reason: `HTTP ${code}` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, reason: e.message }));
    req.end();
  } catch (e) {
    resolve({ ok: false, reason: e.message });
  }
}

/**
 * Drops streams whose link is known-dead, and returns the survivors plus a tally.
 * Only direct-file streams are probed; manifests are never probed and are always kept.
 */
async function filterDeadLinks(streams, { probe: doProbe = true } = {}) {
  if (!Array.isArray(streams) || !streams.length) {
    return { streams: Array.isArray(streams) ? streams : [], checked: 0, dead: 0, cached: 0, deadByProvider: {} };
  }

  const known = new Map();          // stream index -> verdict
  let cached = 0;
  let toProbe = [];

  streams.forEach((s, i) => {
    if (!s) return;
    const hit = verdictCache.get(s.url);
    if (hit && isFresh(hit)) { known.set(i, hit); cached++; }
    else toProbe.push({ idx: i, stream: s });
  });

  if (doProbe && toProbe.length) {
    // Bounded concurrency: probing 40 links at once would be its own kind of self-inflicted load.
    let next = 0;
    const workers = new Array(Math.min(PROBE_CONCURRENCY, toProbe.length)).fill(0).map(async () => {
      while (next < toProbe.length) {
        const job = toProbe[next++];
        const result = await probe(job.stream.url);
        const entry = { alive: result.ok, at: Date.now(), code: result.code, reason: result.reason };
        // Only successes are cached. A dead link usually RECOVERS -- a signature expires, a rate limit
        // passes -- and caching that as permanent is how a good provider stays switched off for good.
        if (result.ok) verdictCache.set(job.stream.url, entry);
        known.set(job.idx, entry);
      }
    });
    await Promise.all(workers);
  }

  const alive = [];
  const deadByProvider = {};
  let dead = 0;
  let checked = 0;

  streams.forEach((s, i) => {
    if (!s) { alive.push(s); return; }
    const provider = s.provider || '?';
    checked++;
    const v = known.get(i);
    if (v && v.alive === false) {
      dead++;
      if (!deadByProvider[provider]) deadByProvider[provider] = [];
      deadByProvider[provider].push({ quality: s.quality, reason: v.reason });
      return;
    }
    alive.push(s);
  });

  // Feed the breaker with one sample per provider, counting only the links actually probed -- judging a
  // provider on 2 dead links when it also returned 10 manifests would be nonsense.
  //
  // DECAY is the important part. The first version accumulated counters forever, so a provider that is
  // merely FLAKY accumulated transient failures across requests until the all-time ratio crossed the
  // threshold and it was switched off. That is what tripped `anime`, which returns 11 working streams for
  // One Piece -- the aggregate silently dropped from {anime:12, CastleTV:8} to {CastleTV:8}. A provider is
  // flapping, not down, and only recent behaviour should count.
  const decay = rec => {
    rec.samples *= DECAY;
    rec.dead *= DECAY;
  };

  for (const [provider, entries] of Object.entries(deadByProvider)) {
    const rec = providerFailures.get(provider) || { samples: 0, dead: 0, streak: 0, trippedAt: null };
    decay(rec);
    rec.samples += entries.length;
    rec.dead += entries.length;
    // A streak counts CONSECUTIVE bad observations, which is what actually distinguishes "down" from
    // "flaky". A provider that fails once and then works ten times never builds one.
    rec.streak += 1;
    if (rec.samples >= TRIP_MIN_SAMPLES && rec.dead / rec.samples >= TRIP_RATIO && rec.streak >= TRIP_MIN_STREAK) {
      if (!rec.trippedAt) {
        rec.trippedAt = Date.now();
        console.warn(`[linkHealth] ${provider}: ${Math.round(rec.dead)}/${Math.round(rec.samples)} probed links dead over ${rec.streak} consecutive checks — skipping for ${TRIP_COOLDOWN_MS}ms`);
      }
    }
    providerFailures.set(provider, rec);
  }

  // A provider that came back with links this round has just disproved the case against it.
  for (const [provider, rec] of [...providerFailures.entries()]) {
    if (rec.trippedAt) continue;
    const offered = streams.filter((s) => (s.provider || '?') === provider).length;
    if (offered > 0 && !deadByProvider[provider]) {
      rec.streak = 0;
      rec.samples *= DECAY;
      rec.dead *= DECAY;
      if (rec.samples < 0.5 && rec.dead < 0.5) providerFailures.delete(provider);
      else providerFailures.set(provider, rec);
    }
  }

  return { streams: alive, checked, dead, cached, deadByProvider };
}

function stats() {
  return {
    cachedVerdicts: verdictCache.size,
    tripped: trippedProviders(),
    providers: [...providerFailures.entries()].map(([name, r]) => ({
      provider: name, dead: r.dead, samples: r.samples, tripped: !!r.trippedAt
    }))
  };
}

function reset() {
  verdictCache.clear();
  providerFailures.clear();
}

/**
 * Has this exact link already been probed and found alive?
 *
 * The quality gate needs this, and it is the reason the gate cannot simply scan provider output. DahmerMovies
 * returns five 2160p links that are all 403: they LOOK like 4K, and treating them as such stops the aggregate
 * early and hands back a response with zero real 4K while the good provider is still running.
 */
function isVerifiedAlive(stream) {
  if (!stream || !stream.url) return false;
  const hit = verdictCache.get(stream.url);
  return !!(hit && isFresh(hit) && hit.alive === true);
}

/**
 * Probe one link only if we have no fresh verdict for it, and report whether it is alive.
 *
 * Used by the quality gate for 4K candidates only. There is usually one or two of those versus twenty-odd
 * 1080p links, so the cost is a single HEAD on a path that is otherwise idle -- and the verdict is cached for
 * the final link-health pass, so this work is not repeated.
 */
async function probeIfUnknown(stream) {
  if (!stream || !stream.url) return false;
  const hit = verdictCache.get(stream.url);
  if (hit && isFresh(hit)) return hit.alive === true;
  const result = await probe(stream.url);
  const entry = { alive: result.ok, at: Date.now(), code: result.code, reason: result.reason };
  if (result.ok) verdictCache.set(stream.url, entry);   // successes only; see filterDeadLinks
  return result.ok;
}

module.exports = {
  filterDeadLinks, isTripped, trippedProviders, isManifest, stats, reset,
  isVerifiedAlive, probeIfUnknown, verdictCache
};
