// Drives the controls and the verdict panel of public/test-player.html in jsdom against a live server.
//
// verify-test-player.mjs guards the classification regression on the default title. This one guards the parts
// that make the page usable as a general test harness -- "does it work for a movie", "does it work for any
// anime", "does it tell me the data arrived complete" -- which is what it is actually used for now, since it
// was extended from a single hardcoded title (One Piece S21E1) to any type plus any TMDB id.
//
// The completeness checks matter most: the page is asked to answer "was it fast AND did it have all its
// data", and a harness that silently renders a thin response as a success is worse than no harness.
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8787';
const html = fs.readFileSync(new URL('../public/test-player.html', import.meta.url), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const red = s => `\x1b[31m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};

async function openPage() {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {
    url: BASE + '/test-player.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) { window.fetch = (input, init = {}) => fetch(input, { ...init }); }
  });
  return { dom, errors, window: dom.window, $: s => dom.window.document.querySelector(s) };
}
// --- helpers ---
// Declared before the checks that use them: `const` bindings are not hoisted, and a script that references
// one above its declaration dies on the first call rather than at parse time.
async function waitForRows(page, maxSeconds = 45) {
  for (let i = 0; i < maxSeconds * 2 && !page.$('#rows').children.length; i++) await sleep(500);
}
const chipsOf = page => [...page.window.document.querySelectorAll('#vchecks .chip')];
const missingOf = page => chipsOf(page).filter(c => c.className.includes('no')).map(c => c.textContent.trim());

// --- an anime series: the headline case ---
console.log('--- anime series ---');
let p = await openPage();
await sleep(500);
await waitForRows(p);
check('title resolved', /One Piece/i.test(p.$('#vtitle').textContent), p.$('#vtitle').textContent);
check('a load time is shown', /\d+\s*ms TOTAL/.test(p.$('#vms').textContent), p.$('#vms').textContent.replace(/\s+/g, ' '));
check('streams rendered', p.$('#rows').children.length > 0, `${p.$('#rows').children.length} rows`);
check('completeness checklist rendered', chipsOf(p).length >= 5, `${chipsOf(p).length} chips`);
check('every data field present for this title', missingOf(p).length === 0,
  missingOf(p).length ? `missing: ${missingOf(p).join(', ')}` : 'title, description, still, date, absolute #, tag, AniList');
check('stopReason is reported', /stopped:/.test(p.$('#vstats').textContent), p.$('#vstats').textContent.replace(/\s+/g, ' ').slice(0, 90));
check('sources are named', p.$('#vwhy').textContent.length > 10, p.$('#vwhy').textContent.slice(0, 70));
check('no page errors', p.errors.length === 0, p.errors.join(' | '));
p.dom.window.close();

// --- a movie: the season inputs must go away and the params must not be sent ---
console.log('\n--- movie ---');
p = await openPage();
await sleep(400);
p.$('#type').value = 'movie';
p.$('#tmdbid').value = '545611';
p.$('#type').dispatchEvent(new p.window.Event('change'));
check('season input hidden for a movie', p.$('#seWrap').style.display === 'none');
check('episode input hidden for a movie', p.$('#epWrap').style.display === 'none');
check('heading reflects the type', /movie/i.test(p.$('#whats').textContent), p.$('#whats').textContent);
p.$('#go').click();
await waitForRows(p);
const movieLog = p.$('#log').textContent;
// The log accumulates and the page auto-loads the default title on open, so assert on the LAST request --
// checking the first would just re-assert the default One Piece load and pass no matter what the form did.
const lastGet = (movieLog.split('\n').filter(l => l.startsWith('GET ')).pop() || '');
check('request carried no season/episode', /GET \/api\/streams\/movie\/545611\?deadline=\d+/.test(lastGet), lastGet.slice(0, 60));
check('movie streams rendered', p.$('#rows').children.length > 0, `${p.$('#rows').children.length} rows`);
const movieMissing = missingOf(p);
check('series-only checks are neutral, not failed',
  !movieMissing.some(m => /absolute episode|AniList/.test(m)), movieMissing.join(', ') || 'none marked missing');
check('no page errors (movie)', p.errors.length === 0, p.errors.join(' | '));
p.dom.window.close();

// --- bad input must not become a 20s round trip ---
console.log('\n--- input validation ---');
p = await openPage();
await sleep(500);
p.$('#tmdbid').value = 'abc';
p.$('#tmdbid').dispatchEvent(new p.window.Event('input'));
p.$('#go').click();
await sleep(300);
check('a non-numeric ID is refused locally', /refused locally/.test(p.$('#log').textContent));
check('and it is reported, not swallowed', /Invalid input/.test(p.$('#vtitle').textContent), p.$('#vtitle').textContent);
p.dom.window.close();

// --- presets drive the form ---
console.log('\n--- presets ---');
p = await openPage();
await sleep(400);
const presetButtons = [...p.window.document.querySelectorAll('#quick button')];
check('anime / TV / movie presets are present', presetButtons.length >= 12, `${presetButtons.length} buttons`);
presetButtons.find(b => /One Piece/.test(b.textContent)).click();
check('a series preset fills id + season + episode',
  p.$('#tmdbid').value === '37854' && p.$('#season').value === '21' && p.$('#episode').value === '1',
  `${p.$('#tmdbid').value} S${p.$('#season').value}E${p.$('#episode').value}`);
check('and selects series type', p.$('#type').value === 'series');
presetButtons.find(b => /Dark Knight/.test(b.textContent)).click();
check('a movie preset switches type and sets the movie id',
  p.$('#type').value === 'movie' && p.$('#tmdbid').value === '155', `${p.$('#type').value} ${p.$('#tmdbid').value}`);
// The preset buttons trigger a real load, and this block has nothing to assert on the results, so the window
// is left open deliberately: closing it here would tear the document out from under the in-flight request and
// produce a teardown crash that has nothing to do with the page. process.exit below settles the leftovers.
console.log('');
if (failures) {
  console.log(red(`FAILED: ${failures} check(s)`));
  process.exit(1);
}
console.log(green('PASS: the test harness works for any type and reports speed + data completeness'));
process.exit(0);
