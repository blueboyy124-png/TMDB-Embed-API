// Concurrency safety test for the showbox per-request context.
//
// Bug under test: providers/registry.js stored per-request state on `global.currentRequestConfig`, which is
// ONE slot shared by the whole process. Two users hitting /api/streams at the same time therefore overwrote
// each other's cookie selection, and `global.currentRequestUserCookie` was never cleared at all -- so a cookie
// chosen for user A was still sitting there for user B's request.
//
// This asserts the fix: concurrent calls must not observe each other's state, and nothing may survive a call.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const registry = require('../providers/registry.js');

const results = [];
let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};

// Two "users" asking for different titles at the same instant. Each get() must observe only its own
// request-scoped context, and must find it cleaned up afterwards.
const userA = registry.__test__getWithContext('movie', '111', null, null, null, 'ui=COOKIE_A');
const userB = registry.__test__getWithContext('tv', '222', 1, 1, null, 'ui=COOKIE_B');
const [a, b] = await Promise.all([userA, userB]);

check('both concurrent calls returned', Array.isArray(a) && Array.isArray(b), `a=${Array.isArray(a)} b=${Array.isArray(b)}`);

// The decisive assertion: nothing global may be left behind that a later, unrelated request could read.
const leaked = registry.__test__peekGlobalState();
const noConfig = leaked.currentRequestConfig == null || Object.keys(leaked.currentRequestConfig).length === 0;
check('currentRequestConfig cleared after calls', noConfig, JSON.stringify(leaked.currentRequestConfig));
check('currentRequestUserCookie never persisted', leaked.currentRequestUserCookie == null,
  leaked.currentRequestUserCookie ? 'LEAKED a cookie' : '');
check('region state not left on a global', leaked.lastRequestedRegion == null && leaked.usedRegionFallback == null,
  JSON.stringify({ last: leaked.lastRequestedRegion, fb: leaked.usedRegionFallback }));

// Contexts must be isolated from each other, not merely absent afterwards. Two overlapping requests each get
// their own object, and neither can see or overwrite the other's cookie.
const ctx = require('../utils/requestContext.js');
let sawA = null, sawB = null, isolated = false;
const work = (name, mine) => ctx.runWithRequestContext(async () => {
  const rc = ctx.requestContext();
  rc.cookies = [mine];
  // Interleave: both are mid-flight at the same time, which is where a shared global corrupts one of them.
  await new Promise(r => setTimeout(r, 20));
  rc.chosenFebboxBaseCookieForRequest = `ui=${mine}`;
  await new Promise(r => setTimeout(r, 20));
  if (name === 'A') sawA = ctx.requestContext(); else sawB = ctx.requestContext();
});
await Promise.all([work('A', 'COOKIE_A'), work('B', 'COOKIE_B')]);

check('each request has a distinct context object', sawA !== sawB, `${sawA === sawB ? 'SAME OBJECT' : 'distinct'}`);
check('request A only sees its own cookie', JSON.stringify(sawA.cookies) === '["COOKIE_A"]' && sawA.chosenFebboxBaseCookieForRequest === 'ui=COOKIE_A',
  `${JSON.stringify(sawA.cookies)} / ${sawA.chosenFebboxBaseCookieForRequest}`);
check('request B only sees its own cookie', JSON.stringify(sawB.cookies) === '["COOKIE_B"]' && sawB.chosenFebboxBaseCookieForRequest === 'ui=COOKIE_B',
  `${JSON.stringify(sawB.cookies)} / ${sawB.chosenFebboxBaseCookieForRequest}`);
isolated = sawA !== sawB && !sawA.cookies.includes('COOKIE_B') && !sawB.cookies.includes('COOKIE_A');
check('neither request observed the other', isolated, '');

// Outside any request there is no context at all, and callers handle that by falling back to their defaults.
check('no context outside a request', ctx.requestContext() === null, '');

console.log('');
if (failures) { console.log(`FAILED: ${failures} check(s)`); process.exit(1); }
console.log('PASS: no cross-request state leaks through globals');
