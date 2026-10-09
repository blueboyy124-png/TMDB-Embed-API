// Proves utils/tmdb.js does not turn one upstream failure into a retry storm.
//
// The bug: a failed TMDB lookup was not cached at all, so the ~14 providers that ask about the same title
// during a single aggregate request each retried independently and simultaneously. One 429 or one dropped
// connection therefore produced 14 concurrent retries, which is what kept TMDB refusing us -- observed live as
// six providers reporting "network timeout at api.themoviedb.org" on one request.
//
// TMDB is stubbed here, so this is deterministic and needs no network and no API key.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Count calls and make every one fail, standing in for a 429.
process.env.TMDB_API_KEY = 'test-key-stub';
const calls = { n: 0 };
require.cache[require.resolve('node-fetch')] = {
  id: require.resolve('node-fetch'), filename: require.resolve('node-fetch'), loaded: true,
  exports: (...args) => {
    calls.n++;
    const init = args[1] || {};
    return Promise.resolve({
      ok: false, status: 429,
      headers: { get: () => '30' },      // Retry-After: 30s
      json: async () => ({})
    });
  }
};

const tmdb = require('../utils/tmdb.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};

(async () => {
  // 14 providers asking about the same title at the same instant, as a real aggregate does.
  const results = await Promise.allSettled(
    Array.from({ length: 14 }, () => tmdb.getDetails('tv', '37854'))
  );
  const rejected = results.filter(r => r.status === 'rejected').length;

  check('all callers failed (as intended)', rejected === 14, `rejected=${rejected}`);
  // The whole point: one upstream attempt, not fourteen.
  check('exactly ONE upstream call was made', calls.n === 1, `upstream calls=${calls.n} (was ${14} before the fix)`);

  // A 429 must also pause the process, so the rate-limit window can actually expire.
  const st = tmdb.status();
  check('a 429 triggered a cool-off', st.cooloffRemainingMs > 0, `cooloffRemainingMs=${st.cooloffRemainingMs}`);
  check('cool-off honours Retry-After (30s)', st.cooloffRemainingMs > 25000, `${st.cooloffRemainingMs}ms`);

  // And during the cool-off, further lookups must not touch the network at all. They reject fast, which is
  // the point: "no metadata" rather than a 15s hang or a fresh burst of requests.
  const before = calls.n;
  const held = await Promise.allSettled([
    tmdb.getDetails('tv', '99999'),
    tmdb.getDetails('movie', '550'),
    tmdb.getExternalIds('tv', '99999')
  ]);
  check('no upstream calls during cool-off', calls.n === before, `calls went ${before} -> ${calls.n}`);
  check('held-off lookups reject fast', held.every(r => r.status === 'rejected'), `rejected=${held.filter(r => r.status === 'rejected').length}/3`);

  // A later request for the SAME title must also be served from the negative cache, not retried.
  const same = await Promise.allSettled([tmdb.getDetails('tv', '37854')]);
  check('same title served from negative cache', same[0].status === 'rejected' && calls.n === before, `calls=${calls.n}`);

  console.log('');
  if (failures) { console.log(`FAILED: ${failures} check(s)`); process.exit(1); }
  console.log('PASS: one upstream failure produces one retry, not fourteen');
})();
