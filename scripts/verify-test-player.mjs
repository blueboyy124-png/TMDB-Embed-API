// Drives public/test-player.html in jsdom against a live server, and checks the thing that actually broke:
// that every proxied stream is classified as HLS. The page's own code runs -- this is not a reimplementation.
//
// The regression this guards: with `enableProxy` on, URLs look like <origin>/m3u8-proxy?url=... . A bare
// /\.m3u8/ test does not match that, so the page used to hand HLS to <video src>, which Chrome cannot decode:
// controls, duration 0:00, no error. 20 of 20 streams were misclassified on One Piece S21E1.
//
// jsdom cannot decode video, so playback itself is not asserted -- classification and rendering are, which is
// the part that was wrong.
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8787';
const html = fs.readFileSync(new URL('../public/test-player.html', import.meta.url), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const red = s => `\x1b[31m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;

const vc = new VirtualConsole();
const pageErrors = [];
vc.on('jsdomError', e => pageErrors.push(e.message));
vc.on('error', (...a) => pageErrors.push(a.join(' ')));

const dom = new JSDOM(html, {
  url: BASE + '/test-player.html',     // location.origin must be the API: the page derives its URLs from it
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  // Inject fetch BEFORE any page script runs. The page calls run() on load, so assigning window.fetch
  // afterwards is too late -- jsdom has no fetch and the request fails with "fetch is not defined".
  beforeParse(window) {
    window.fetch = (input, init = {}) => fetch(input, { ...init });
  }
});
const { window } = dom;

await sleep(300);
const $ = s => window.document.querySelector(s);

// The page auto-runs on load; the aggregate request uses deadline=30000, so allow for that.
for (let i = 0; i < 45 && !$('#rows').children.length; i++) await sleep(1000);

const rows = [...window.document.querySelectorAll('#rows tr')];
console.log($('#log').textContent.split('\n').filter(Boolean).map(l => '  ' + l).join('\n'));
console.log(`\nrows rendered: ${rows.length}`);

const problems = [];
if (!rows.length) problems.push('no stream rows rendered');

// THE KEY ASSERTION. Read the labels back out of the DOM, so this reflects the page's own classify():
// a URL containing .m3u8 must be labelled HLS, and .mkv must be labelled MKV.
let hls = 0, file = 0, mkv = 0, other = 0;
for (const r of rows) {
  const kind = (r.querySelector('.kind') || {}).textContent?.trim() || '?';
  const shownUrl = (r.querySelector('.src') || {}).textContent || '';
  if (kind === 'HLS') hls++;
  else if (kind === 'MKV') mkv++;
  else if (kind === 'file') file++;
  else other++;
  if (/\.m3u8(\?|#|$)/i.test(shownUrl) && kind !== 'HLS') {
    problems.push(`m3u8 URL labelled "${kind}" instead of HLS: ${shownUrl.slice(0, 80)}`);
  }
  if (/\.mkv(\?|#|$)/i.test(shownUrl) && kind !== 'MKV') {
    problems.push(`mkv URL labelled "${kind}" instead of MKV: ${shownUrl.slice(0, 80)}`);
  }
}
console.log(`classified: ${hls} HLS, ${file} file, ${mkv} MKV, ${other} unknown`);
if (hls === 0) problems.push('no stream classified as HLS — the m3u8-proxy misclassification is back');

const playBtns = window.document.querySelectorAll('#rows button[data-i]').length;
const disabled = window.document.querySelectorAll('#rows button[disabled]').length;
console.log(`play buttons: ${playBtns}, disabled: ${disabled}`);
if (playBtns === 0) problems.push('no playable stream buttons rendered');
if (pageErrors.length) problems.push('page errors: ' + pageErrors.join(' | '));

// 6. Listener hygiene: listeners must be attached once, not per click. A stream that neither loads nor
//    errors used to leave its listener attached, so the NEXT stream's failure was reported under the
//    PREVIOUS provider's name -- misleading when the whole point is naming the broken source.
const src = html;
const attached = (src.match(/v\.addEventListener\('(loadeddata|error)'/g) || []).length;
const inLoop = /function play\([^)]*\)\s*\{[\s\S]*?v\.addEventListener\(/.test(src);
console.log(`video listeners attached at top level: ${attached}, any inside play(): ${inLoop}`);
if (inLoop) problems.push('video listeners are attached inside play() — they will leak across clicks');

// 7. play() must not be called before the manifest is parsed, or a healthy stream logs a bogus
//    "autoplay blocked" message.
if (/^\s*v\.play\(\)/m.test(src) && !/MANIFEST_PARSED/.test(src)) {
  problems.push('play() called without waiting for MANIFEST_PARSED');
}

// 8. A dead source must produce a visible message, not an endless spinner.
if (!/no first frame within/.test(src)) problems.push('no stalled-source watchdog on playback');

console.log('');
if (problems.length) {
  console.log(red('FAILED'));
  for (const p of problems) console.log('  x ' + p);
  process.exit(1);
}
if (other) console.log(yellow(`  note: ${other} stream(s) had no recognisable extension`));
console.log(green('OK') + ` — ${hls} HLS + ${file} file stream(s) correctly classified and playable`);
window.close();
process.exit(0);
