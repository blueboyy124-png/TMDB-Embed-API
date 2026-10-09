// Guards link health: dead links must not be handed out, live ones must survive, and a provider must only
// be switched off on a PROVEN failure -- never on one bad link, which would disable a working provider.
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const linkHealth = require('../utils/linkHealth.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};

// A local server that answers however each case needs, so the probe is tested against real HTTP
// rather than a mock of it.
let mode = 'ok';
const server = http.createServer((req, res) => {
  if (mode === 'dead') { res.writeHead(403).end('no'); return; }
  if (mode === 'ratelimit') { res.writeHead(429).end('slow down'); return; }
  if (mode === 'nohead') {                     // rejects HEAD, must not be read as dead
    if (req.method === 'HEAD') { res.writeHead(405).end(); return; }
    res.writeHead(206, { 'Content-Type': 'video/mp4' }).end(Buffer.alloc(8));
    return;
  }
  res.writeHead(200).end('ok');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const stream = (name, file) => ({ url: `${base}/${file}`, provider: name, quality: '1080p' });

console.log('--- live links survive ---');
linkHealth.reset();
mode = 'ok';
let out = await linkHealth.filterDeadLinks([stream('p1', 'a.mp4'), stream('p2', 'b.mkv')]);
check('both kept', out.streams.length === 2, `${out.streams.length}/2`);
check('nothing reported dead', out.dead === 0);
check('both were probed', out.checked === 2);

console.log('\n--- dead links are dropped ---');
mode = 'dead';
linkHealth.reset();
out = await linkHealth.filterDeadLinks([stream('p3', 'a.mp4'), stream('p3', 'b.mkv')]);
check('all dropped', out.streams.length === 0);
check('counted as dead', out.dead === 2, `dead=${out.dead}`);
check('named the provider', !!(out.deadByProvider.p3 && out.deadByProvider.p3.length === 2));
check('records the reason', out.deadByProvider.p3[0].reason === 'HTTP 403', out.deadByProvider.p3[0].reason);

console.log('\n--- manifests are probed too (VaPlayer 500s were surviving) ---');
mode = 'dead';
linkHealth.reset();
out = await linkHealth.filterDeadLinks([{ url: `${base}/m.m3u8`, provider: 'p4', quality: 'Auto' }]);
check('a dead .m3u8 is dropped, not waved through', out.streams.length === 0 && out.dead === 1);

console.log('\n--- 429 is treated as dead, not playable ---');
mode = 'ratelimit';
linkHealth.reset();
out = await linkHealth.filterDeadLinks([stream('p5', 'a.mp4')]);
check('rate-limited link dropped', out.streams.length === 0);

console.log('\n--- a server that rejects HEAD is not declared dead ---');
mode = 'nohead';
linkHealth.reset();
out = await linkHealth.filterDeadLinks([stream('p6', 'a.mp4')]);
check('405 on HEAD falls back to a ranged GET and survives', out.streams.length === 1,
  `kept=${out.streams.length} reason=${(out.deadByProvider.p6 || [{}])[0].reason || 'alive'}`);

console.log('\n--- the breaker needs a PROVEN, SUSTAINED failure ---');
linkHealth.reset();
mode = 'dead';
// One dead link must never be enough.
await linkHealth.filterDeadLinks([stream('lonely', 'a.mp4')]);
check('one dead link does not switch a provider off', !linkHealth.isTripped('lonely'));
// Neither may two consecutive rounds. This is the regression that cost us anime: the old 3-sample rule
// tripped on two rounds of accumulated transient failures, and `anime` was skipped while returning 11
// working streams for One Piece.
await linkHealth.filterDeadLinks([stream('lonely', 'b.mp4'), stream('lonely', 'c.mkv')]);
check('two consecutive bad rounds do not either', !linkHealth.isTripped('lonely'),
  linkHealth.stats().tripped.join(',') || 'none tripped');
// A provider that stays dead keeps failing, so it trips -- but decay means it takes a few more rounds than
// the old rule did, which is the cost of not tripping on flapping. Five requests to notice a dead site is
// nothing next to the latency and dead streams it prevents.
let trippedAfter = null;
for (let round = 3; round <= 8 && !trippedAfter; round++) {
  await linkHealth.filterDeadLinks([stream('lonely', `d${round}.mp4`), stream('lonely', `e${round}.mkv`)]);
  if (linkHealth.isTripped('lonely')) trippedAfter = round;
}
check('a sustained failure eventually trips', trippedAfter !== null,
  trippedAfter ? `tripped on round ${trippedAfter}` : 'still not tripped after 8 rounds');

console.log('\n--- flapping is NOT a death sentence ---');
// A provider that fails once and then works must never trip, however long that repeats. This is the whole
// point of the decay: only RECENT behaviour counts, so old failures fade instead of accumulating forever.
linkHealth.reset();
mode = 'dead';
await linkHealth.filterDeadLinks([stream('flappy', 'a.mp4'), stream('flappy', 'b.mp4')]);
mode = 'ok';
for (let i = 0; i < 6; i++) {
  await linkHealth.filterDeadLinks([stream('flappy', `ok${i}.mp4`)]);
}
check('a flapping provider never trips', !linkHealth.isTripped('flappy'),
  `tripped=${linkHealth.stats().tripped.join(',') || 'none'}`);

console.log('\n--- a healthy provider is never accused ---');
mode = 'ok';
linkHealth.reset();
await linkHealth.filterDeadLinks([stream('good', 'a.mp4'), stream('good', 'b.mp4'), stream('good', 'c.mp4')]);
check('never tripped', !linkHealth.isTripped('good'));
check('cache grew', linkHealth.stats().cachedVerdicts > 0, `${linkHealth.stats().cachedVerdicts} verdicts`);

console.log('\n--- robustness ---');
check('empty input is safe', (await linkHealth.filterDeadLinks([])).streams.length === 0);
check('non-array is safe', (await linkHealth.filterDeadLinks(null)).streams.length === 0);
linkHealth.reset();
out = await linkHealth.filterDeadLinks([stream('x', 'a.mp4')], { probe: false });
// With probing off nothing can be marked dead, so everything is kept unchecked. `checked` counts links
// ELIGIBLE for probing, not links actually probed -- the two differ exactly when probing is disabled.
check('probing can be switched off', out.streams.length === 1 && out.dead === 0,
  `kept=${out.streams.length} dead=${out.dead}`);

server.close();
console.log('');
if (failures) { console.log(`FAILED: ${failures} check(s)`); process.exit(1); }
console.log('PASS: dead links are dropped, live ones kept, providers only switched off when proven dead');