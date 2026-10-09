// Guards the "enough" early-exit. The aggregate used to wait out the full soft deadline even when the
// response was already complete, which is where a median 12.6s came from; it now returns as soon as it has
// enough streams from enough *distinct* providers. The provider-count half matters as much as the stream
// half: three providers returning one stream each is three chances to be wrong, and would defeat the point
// of aggregating 14 of them.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isEnough, DEFAULT_ENOUGH_STREAMS, DEFAULT_ENOUGH_PROVIDERS } = require('../utils/earlyExit.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};

// A slot holds the streams one provider returned: `undefined` while it is still working, `[]` once it has
// settled empty, otherwise an array of that many streams. Only the LENGTH matters to isEnough, so the helper
// builds an array of n placeholders rather than n real stream objects.
const slot = (n) => (n === undefined ? undefined : new Array(n).fill(0));

console.log('--- not enough yet ---');
check('nothing settled', !isEnough([]));
check('one good provider is not enough', !isEnough([slot(30)]));
check('plenty of streams but ONE provider is not enough', !isEnough([slot(40)]), '40 streams, 1 source');
check('two providers is not enough', !isEnough([slot(40), slot(5)]));
check('a provider that returned nothing does not count toward the total', !isEnough([slot(12), slot(13), slot()]), '2 providers, 25 streams');
check('a provider still working does not count', !isEnough([slot(20), slot(20), undefined]));

console.log('\n--- enough ---');
check('12 streams across 3 providers', isEnough([slot(8), slot(3), slot(1)]));
check('empty and pending slots alongside are ignored', isEnough([slot(8), slot(3), slot(1), slot(), undefined]));
check('an exactly-threshold answer counts', isEnough([slot(DEFAULT_ENOUGH_STREAMS), slot(1), slot(1)]));
check('more providers than needed is fine', isEnough([slot(4), slot(4), slot(4), slot(4)]));

console.log('\n--- the thresholds are what stop a bad early exit ---');
check('many streams from 2 providers is refused (no redundancy)', !isEnough([slot(40), slot(40)]));
check('12 streams from 4 providers is accepted', isEnough([slot(5), slot(3), slot(2), slot(2)]));
check('the stream threshold is enforced (11 streams, 3 providers)', !isEnough([slot(4), slot(4), slot(3)]));
check('one stream over the threshold passes', isEnough([slot(4), slot(4), slot(4)]));
check('the provider threshold is enforced', !isEnough([slot(50), slot(50)]));

console.log('\n--- the thresholds are configurable ---');
check('custom thresholds are honoured', isEnough([slot(2), slot(2)], 3, 2) && !isEnough([slot(2), slot(2)], 5, 2));
check('provider threshold of 0 disables the diversity requirement', isEnough([slot(12), slot(0)], 12, 0));
check('the shipped defaults are 12 streams / 3 providers',
  DEFAULT_ENOUGH_STREAMS === 12 && DEFAULT_ENOUGH_PROVIDERS === 3);

console.log('\n--- robustness ---');
check('undefined input is safe', !isEnough(undefined) && !isEnough(null));
check('junk slots are ignored, not crashed on', !isEnough(['nope', 42, {}, null]));

console.log('');
if (failures) { console.log(`FAILED: ${failures} check(s)`); process.exit(1); }
console.log('PASS: the early-exit threshold needs both enough streams and enough providers');