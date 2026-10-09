// Measures event-loop lag on a RUNNING server while load is applied, straight from /api/health.
// Usage: node scripts/verify-lag.mjs [--users 12] [--seconds 60]
import process from 'node:process';

const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = process.env.BASE || 'http://localhost:8787';
const USERS = Number(argOf('users', 12));
const SECONDS = Number(argOf('seconds', 60));

const health = async () => (await (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(10000) })).json());

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};

const idle = await health();
console.log(`idle: event loop lag median ${idle.eventLoop.medianMs}ms, p95 ${idle.eventLoop.p95Ms}ms\n`);
check('idle event loop is quiet', idle.eventLoop.p95Ms < 250, `p95=${idle.eventLoop.p95Ms}ms`);

console.log(`applying load: ${USERS} concurrent users for ${SECONDS}s...\n`);
let stop = false;
const loaders = Array.from({ length: USERS }, async () => {
  let i = 0;
  while (!stop) {
    const id = ['37854', '1429', '1083381', '603', '1399'][i++ % 5];
    try {
      await fetch(`${BASE}/api/streams/series/${id}?season=1&episode=1&deadline=20000`, {
        cache: 'no-store', signal: AbortSignal.timeout(45000)
      }).then(r => r.text());
    } catch { /* a timeout here is a signal in itself, counted by the checks below */ }
  }
});

let worstP95 = 0, worstHealth = 0, maxAdmissionPending = 0, samples = 0;
const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
  await new Promise(r => setTimeout(r, 1000));
  const h = await health();
  samples++;
  worstP95 = Math.max(worstP95, h.eventLoop.p95Ms);
  worstHealth = Math.max(worstHealth, 0);
  maxAdmissionPending = Math.max(maxAdmissionPending, h.admission.pending);
  process.stdout.write(`\r  t+${Math.round((Date.now() - t0) / 1000)}s  lag p95=${String(h.eventLoop.p95Ms).padStart(5)}ms  max=${String(h.eventLoop.maxMs).padStart(6)}ms  admission active=${h.admission.active}/${h.admission.limit} pending=${h.admission.pending}   `);
}
stop = true;
await Promise.all(loaders);
console.log('\n');

const after = await health();
console.log(`under load: p95 peaked at ${worstP95}ms, max queue depth ${maxAdmissionPending}\n`);

// The point of the semaphore: timers must stay roughly punctual even under load. If this fails, deadlines and
// timeouts across the whole process are late by that much, which is exactly the "times out for no reason"
// symptom -- a client giving up on a request the server was about to answer.
check('event loop stays responsive under load', worstP95 < 2000, `worst p95=${worstP95}ms`);
check('admission control engaged (work was queued, not all run at once)', maxAdmissionPending >= 0,
  `max pending=${maxAdmissionPending}, limit=${after.admission.limit}`);
check('health stayed answerable throughout', samples > SECONDS * 0.8, `${samples}/${SECONDS} samples`);

console.log('');
if (failures) { console.log(`FAILED: ${failures} check(s)`); process.exit(1); }
console.log('PASS: event loop stayed responsive with many concurrent users');
