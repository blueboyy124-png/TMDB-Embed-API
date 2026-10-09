/* Event-loop lag monitor.
 *
 * Why this exists: Node runs all JavaScript on a single thread, so a CPU-bound provider -- cheerio parsing a
 * multi-megabyte page, say -- delays EVERY timer in the process. Not just its own request: the aggregate's
 * soft deadline, the per-provider timeouts, the login rate-limit sweeper, and the browser's own requests all
 * wait. That is what "glitchy" actually felt like, and latency numbers alone do not show it: a deadline
 * configured for 20s was measured firing at 68s during a load test, because the loop it depends on was blocked.
 *
 * The measurement is simply how late a timer fires versus when it was due. A healthy idle server sits near 0;
 * hundreds of milliseconds is user-visible jank, and seconds means requests are timing out. Exposed on
 * /api/health so "is it my machine or the code" is answerable without attaching a profiler.
 *
 * Cost is one timer per interval, unref'd so it never holds the process open.
 */
const INTERVAL_MS = 250;
const MAX_SAMPLES = 240;          // ~1 minute of history at 250ms
const samples = [];
let expected = 0;

function tick() {
  const now = Date.now();
  if (expected) {
    samples.push(Math.max(0, now - expected));
    if (samples.length > MAX_SAMPLES) samples.shift();
  }
  expected = now + INTERVAL_MS;
  setTimeout(tick, INTERVAL_MS).unref();
}

let started = false;
function start() {
  if (started) return;
  started = true;
  expected = Date.now() + INTERVAL_MS;
  setTimeout(tick, INTERVAL_MS).unref();
}

function status() {
  if (!samples.length) return { samples: 0, medianMs: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    samples: samples.length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted[sorted.length - 1]
  };
}

start();
module.exports = { start, status };
