#!/usr/bin/env node
/**
 * Stream pipeline smoke test.
 *
 * Hits every enabled provider individually plus the aggregate endpoint, and
 * reports per-provider latency, stream count and container mix. Written after a
 * corrupt user-config.json silently unmounted the proxy layer while
 * /api/streams kept handing out proxied (404) URLs — this makes that class of
 * failure obvious in a single command instead of a black-screened player.
 *
 * Usage:
 *   node scripts/verify-streams.mjs
 *   node scripts/verify-streams.mjs --type series --id 1399 --season 1 --episode 1
 *   node scripts/verify-streams.mjs --base http://192.168.86.75:8787 --provider-timeout 25000
 */
import process from 'node:process';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = argOf('base', process.env.TMDB_EMBED_API_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TYPE = argOf('type', 'movie');
const ID = argOf('id', '550');
const SEASON = argOf('season', '1');
const EPISODE = argOf('episode', '1');
// The client must be willing to wait at least as long as the server promises to take, or this script fails
// correct behaviour. The server answers a slow provider with PROVIDER_TIMEOUT after 45s
// (PROVIDER_TIMEOUT_MS), and several providers legitimately run into that -- 4khdhub was measured anywhere
// from 5s to 161s of its own work. A 25s client abort reported those as "did not respond", which reads like an
// outage but is not one. Kept above the server's own ceiling so a timeout here means something.
const TIMEOUT = Number(argOf('provider-timeout', '60000'));

const useEpisodeQuery = TYPE !== 'movie';
const providerPath = (name) => `/api/streams/${name}/${TYPE}/${ID}`;
const streamPath = useEpisodeQuery
  ? `/api/streams/${TYPE}/${ID}?season=${encodeURIComponent(SEASON)}&episode=${encodeURIComponent(EPISODE)}`
  : `/api/streams/${TYPE}/${ID}`;

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function getJson(path, timeoutMs = TIMEOUT) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal, cache: 'no-store' });
    const elapsed = Date.now() - started;
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, ms: elapsed, body };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, error: e.name === 'AbortError' ? `timeout >${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function containerSummary(streams) {
  const counts = {};
  for (const s of streams || []) {
    const key = s?.playableInBrowser === false ? `${s.container || 'unknown'} (unplayable)` : (s?.container || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ') || '—';
}

const failures = [];
const warnings = [];

const health = await getJson('/api/health', 10000);
console.log(dim(`base: ${BASE}`));
if (!health.body) {
  console.log(red(`✖ /api/health unreachable (${health.status || health.error})`));
  process.exit(1);
}
const proxyEnabled = health.body?.proxy?.enabled;
const proxyMounted = health.body?.proxy?.mounted;
console.log(`health: proxy mounted=${proxyMounted} enabled=${proxyEnabled}`);
if (!proxyMounted) failures.push('proxy routes are not mounted; proxied stream URLs will 404');
if (!proxyEnabled) console.log(yellow('• proxy is disabled — stream URLs are handed out raw (headers required client-side)'));
if (health.body?.config?.overrideOk === false) {
  failures.push(`user-config override file is unreadable (${health.body.config.overrideError}) — all overrides ignored`);
}

const providersRes = await getJson('/api/providers', 10000);
const enabled = (providersRes.body?.providers || []).filter((p) => p.enabled).map((p) => p.name);
if (!enabled.length) {
  console.log(red('✖ no enabled providers'));
  process.exit(1);
}

console.log(`\n${TYPE} ${ID} — ${enabled.length} enabled providers\n`);
const rows = [];
for (const name of enabled) {
  const r = await getJson(providerPath(name));
  const streams = r.body?.streams || [];
  const label = r.status === 0 ? red('NO RESPONSE') : r.ok ? green(String(r.status)) : red(String(r.status));
  rows.push({ name, ms: r.ms, count: streams.length, label, containers: containerSummary(streams) });
  console.log(
    `${name.padEnd(14)} ${label}  ${String(r.ms).padStart(6)}ms  n=${String(streams.length).padStart(2)}  ${dim(rows.at(-1).containers)}`
  );
  if (r.status === 0) failures.push(`${name} did not respond within ${TIMEOUT}ms`);
  if (r.status === 504) warnings.push(`${name} hit the server provider timeout`);
}

const aggregate = await getJson(streamPath, TIMEOUT + 5000);
const aggStreams = aggregate.body?.streams || [];
const playable = aggStreams.filter((s) => s.playableInBrowser !== false);
console.log(`\naggregate ${streamPath}`);
console.log(`  status=${aggregate.status || aggregate.error} ${aggregate.ms}ms  total=${aggStreams.length}  browser-playable=${playable.length}  partial=${aggregate.body?.partial === true}`);
if (aggregate.body?.providerStatus) {
  // providerStatus maps name -> status STRING ('ok' | 'empty' | 'timeout' | 'error' | 'disabled' | 'pending'),
  // so the value is compared directly. This used to read s.status on that string, which is always
  // undefined, and so reported every single provider as degraded.
  const slow = Object.entries(aggregate.body.providerStatus)
    .filter(([, s]) => s !== 'ok' && s !== 'disabled')
    .map(([n, s]) => `${n}:${s}`);
  if (slow.length) console.log(yellow(`  degraded providers: ${slow.join(' ')}`));
}
console.log(`  containers: ${containerSummary(aggStreams)}`);

if (aggregate.status === 0) failures.push('aggregate endpoint did not respond in time');
if (!aggStreams.length) failures.push('aggregate returned zero streams');
if (!playable.length) failures.push('aggregate returned no browser-playable (HLS/mp4/webm) stream');
// A single flaky upstream is a warning; a majority timing out means the pipeline
// itself is broken (or the timeout ceiling is set far too low).
const timedOutNames = new Set(warnings.filter((w) => w.includes('provider timeout')).map((w) => w.split(' ')[0]));
if (timedOutNames.size * 2 >= enabled.length) {
  failures.push(`${timedOutNames.size}/${enabled.length} providers timed out — raise PROVIDER_TIMEOUT_MS or investigate the sources`);
}

if (failures.length) {
  console.log(`\n${red('FAILED')}`);
  for (const f of failures) console.log(`  ✖ ${f}`);
  for (const w of warnings) console.log(yellow(`  • ${w}`));
  process.exit(1);
}
for (const w of warnings) console.log(yellow(`  • ${w}`));
console.log(`\n${green('OK')} — ${playable.length} browser-playable stream(s) available`);
