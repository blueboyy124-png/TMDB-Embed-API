#!/usr/bin/env node
/**
 * Coverage matrix: does the server return playable streams for a deliberately
 * awkward spread of TMDB titles?
 *
 * The project goal is "stream any sort of media reliably". The per-provider
 * smoke test (verify-streams.mjs) answers a different question -- "is each
 * provider reachable right now, for this one title". Neither catches the
 * failure that actually matters: a whole *category* of media (anime films,
 * foreign-language movies, older series) quietly having no working source,
 * which reads as "the app is broken" to a user and as nothing at all in the
 * provider logs, because every provider individually reports `empty`.
 *
 * So this sweeps a fixed catalogue and reports coverage per category, latency,
 * and -- importantly -- which titles depend on only ONE provider. A title with
 * a single source is not covered, it is one bad afternoon away from being
 * unavailable.
 *
 * Usage:
 *   node scripts/verify-coverage.mjs
 *   node scripts/verify-coverage.mjs --base http://127.0.0.1:8787 --deadline 28000
 *   node scripts/verify-coverage.mjs --quick     (one title per category)
 */
import process from 'node:process';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const QUICK = args.includes('--quick');

const BASE = argOf('base', process.env.TMDB_EMBED_API_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const DEADLINE = Number(argOf('deadline', '28000'));

// Fixed catalogue, chosen to hit the categories most likely to fall through the
// cracks rather than the blockbusters we already know work. season/episode are
// per-title where season 1 episode 1 is not the interesting episode.
const CATALOGUE = [
  { category: 'blockbuster', type: 'movie', id: '155', title: 'The Dark Knight' },
  { category: 'blockbuster', type: 'movie', id: '680', title: 'Pulp Fiction' },
  { category: 'classic', type: 'movie', id: '389', title: '12 Angry Men (1957)' },
  { category: 'classic', type: 'movie', id: '429', title: 'Good Bad Ugly' },
  { category: 'obscure', type: 'movie', id: '1632', title: 'The Prestige' },
  { category: 'obscure', type: 'movie', id: '106646', title: 'Wolf of Wall Street' },
  { category: 'anime-film', type: 'movie', id: '4935', title: "Howl's Moving Castle" },
  { category: 'anime-film', type: 'movie', id: '568124', title: 'Demon Slayer Mugen Train' },
  { category: 'foreign', type: 'movie', id: '19404', title: 'Dilwale (Hindi)' },
  { category: 'foreign', type: 'movie', id: '329865', title: 'Arrival' },
  { category: 'recent', type: 'movie', id: '545611', title: 'Everything Everywhere' },
  { category: 'recent', type: 'movie', id: '264660', title: 'Once Upon a Time in Hollywood' },
  { category: 'pop-series', type: 'series', id: '1396', title: 'Breaking Bad' },
  { category: 'pop-series', type: 'series', id: '1399', title: 'Game of Thrones' },
  { category: 'pop-series', type: 'series', id: '1861', title: 'Better Call Saul' },
  { category: 'anime', type: 'series', id: '37854', title: 'One Piece', season: 21, episode: 1 },
  { category: 'anime', type: 'series', id: '1429', title: 'Attack on Titan', season: 4, episode: 1 },
  { category: 'anime', type: 'series', id: '1100', title: 'Death Note' },
  { category: 'anime', type: 'series', id: '16498', title: 'Cowboy Bebop' },
  { category: 'long-run', type: 'series', id: '105', title: 'Friends' },
  { category: 'long-run', type: 'series', id: '66732', title: 'Stranger Things' },
  { category: 'kids', type: 'series', id: '60625', title: 'Rick and Morty' },
  { category: 'kids', type: 'series', id: '456', title: 'The Simpsons' },
  { category: 'sports', type: 'series', id: '2160', title: 'Formula 1' },
  { category: 'older-show', type: 'series', id: '1628', title: 'Chernobyl' },
  { category: 'older-show', type: 'series', id: '76479', title: 'The Mandalorian' }
];

// --quick: one title per category, so this stays usable in a tight loop.
const LIST = QUICK
  ? CATALOGUE.filter((t, i) => CATALOGUE.findIndex((x) => x.category === t.category) === i)
  : CATALOGUE;

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

async function getJson(path, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal, cache: 'no-store' });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, ms: Date.now() - started, body };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started,
      error: e.name === 'AbortError' ? `timeout >${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}
const health = await getJson('/api/health', 10000);
if (!health.body) {
  console.log(red(`✖ /api/health unreachable (${health.status || health.error}) — is the server on ${BASE}?`));
  process.exit(1);
}
const categories = new Set(LIST.map((t) => t.category));
console.log(dim(`base: ${BASE}`));
console.log(`catalogue: ${LIST.length} titles / ${categories.size} categories${QUICK ? ' (--quick)' : ''}\n`);

const results = [];
for (const t of LIST) {
  const path = t.type === 'movie'
    ? `/api/streams/movie/${t.id}?deadline=${DEADLINE}`
    : `/api/streams/series/${t.id}?season=${t.season ?? 1}&episode=${t.episode ?? 1}&deadline=${DEADLINE}`;
  const r = await getJson(path, DEADLINE + 15000);
  const streams = r.body?.streams || [];
  const playable = streams.filter((s) => s.playableInBrowser !== false);
  const providers = {};
  for (const s of streams) providers[s.provider] = (providers[s.provider] || 0) + 1;
  results.push({
    ...t, ms: r.ms, status: r.status, error: r.error,
    playable: playable.length, providers, sources: Object.keys(providers),
    partial: r.body?.partial === true,
    stop: r.body?.stopReason || (r.body?.partial === true ? 'deadline' : 'complete')
  });
  // Mark: !! nothing playable, ~ thin or slow, otherwise fine.
  const mark = !playable.length ? red('!!')
    : (playable.length < 5 || r.ms > 20000) ? yellow(' ~')
    : green('  ');
  console.log(
    `${mark} ${t.title.slice(0, 29).padEnd(30)}${String(playable.length).padStart(4)} playable` +
    ` ${String(r.ms).padStart(6)}ms ${dim(Object.entries(providers).map(([k, v]) => `${k}:${v}`).join(' ').slice(0, 44))}`
  );
}

// --- per-category rollup: the number that answers "any sort of media"
const byCategory = new Map();
for (const r of results) {
  if (!byCategory.has(r.category)) byCategory.set(r.category, []);
  byCategory.get(r.category).push(r);
}
console.log(`\n${bold('coverage by category')}`);
console.log('-'.repeat(74));
const gaps = [];
for (const [cat, rows] of byCategory) {
  const covered = rows.filter((r) => r.playable > 0).length;
  const pc = Math.round((covered / rows.length) * 100);
  const missed = rows.filter((r) => !r.playable).map((r) => r.title);
  console.log(
    `${cat.padEnd(13)} ${covered}/${rows.length}  ` +
    (pc === 100 ? green('OK') : pc >= 50 ? yellow(`${pc}%`) : red(`${pc}%`)) +
    (missed.length ? `   ${dim(`no source: ${missed.join(', ')}`)}` : '')
  );
  for (const r of rows) if (!r.playable) gaps.push(r);
}

// --- single-source titles. Covered, but with no redundancy at all.
const singleSource = results.filter((r) => r.playable > 0 && r.sources.length === 1);
const thin = results.filter((r) => r.playable > 0 && r.playable < 5);

const covered = results.filter((r) => r.playable > 0).length;
const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
const at = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];

console.log(`\n${bold('summary')}`);
console.log(`covered        : ${covered}/${results.length} (${Math.round((covered / results.length) * 100)}%)`);
console.log(`latency        : median ${at(0.5)}ms   p90 ${at(0.9)}ms   max ${latencies[latencies.length - 1]}ms`);
console.log(`single-source  : ${singleSource.length ? yellow(singleSource.map((r) => `${r.title} (${r.sources[0]})`).join(', ')) : 'none'}`);
if (thin.length) console.log(`thin (<5)      : ${thin.map((r) => `${r.title}(${r.playable})`).join(', ')}`);
const partialCount = results.filter((r) => r.partial).length;
const stopReasons = {};
for (const r of results) stopReasons[r.stop] = (stopReasons[r.stop] || 0) + 1;
// `partial` is now true for the common fast case too, because we deliberately leave early once the answer is
// good. Reporting that as "hit deadline" would be noise, so break it down by stopReason -- only 'deadline'
// means we actually ran out of time.
const realTimeouts = stopReasons.deadline || 0;
const stoppedEarly = stopReasons.enough || 0;
if (stoppedEarly) console.log(`stopped early  : ${stoppedEarly}/${results.length} left once the answer was already good (not a timeout)`);
if (realTimeouts) console.log(yellow(`hit deadline   : ${realTimeouts}/${results.length} ran out of time`));
if (!stoppedEarly && !realTimeouts && !partialCount) console.log(`every response : waited for all providers`);

// Hard-fail only on a completely uncovered title. A single-source title is
// reported loudly but not failed: it is usually one upstream's catalogue gap,
// not a regression in this server.
const hardFail = gaps.length > 0;
console.log('');
if (hardFail) {
  console.log(red('GAPS FOUND'));
  for (const g of gaps) console.log(red(`  ✖ ${g.title} (${g.category}) returned no playable stream — ${g.error || `HTTP ${g.status}`}`));
  process.exit(1);
}
console.log(green('PASS: every title in the catalogue has at least one working source'));
if (singleSource.length) {
  console.log(yellow(`NOTE: ${singleSource.length} title(s) rest on a single provider — no redundancy if it goes down`));
}