// Unit-tests the classify()/isHlsUrl() helpers inside public/test-player.html across every URL shape the API
// can produce. The live title (One Piece S21E1) only yields HLS and MKV, so the mp4/webm/extensionless
// branches would otherwise never run. The functions are lifted out of the real file, not reimplemented.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/test-player.html', import.meta.url), 'utf8');
const start = src.indexOf('function isHlsUrl');
const end = src.indexOf('// --- playback ---');
if (start === -1 || end === -1) { console.error('could not locate helpers in test-player.html'); process.exit(1); }
const helpers = new Function(`${src.slice(start, end)}; return { isHlsUrl, classify, unwrap };`)();

const prox = (route, orig) =>
  `http://host:8787/${route}?url=${encodeURIComponent(orig)}&headers=${encodeURIComponent('{"Referer":"https://x/"}}')}`;

const CASES = [
  // [url, expectedKind, description]
  [prox('m3u8-proxy', 'https://a.com/x.m3u8?tk=1'), 'hls', 'proxied playlist (the bug case: no dot before m3u8)'],
  ['https://a.com/master.m3u8?tk=1', 'hls', 'direct playlist'],
  [prox('m3u8-proxy', 'https://anixo.buzz/api/stream/m3u8?t=abc'), 'hls', 'proxied, no file extension, m3u8 route'],
  [prox('ts-proxy', 'https://a.com/v.mp4'), 'file', 'proxied mp4'],
  ['https://a.com/v.mp4', 'file', 'direct mp4'],
  ['https://a.com/v.webm', 'file', 'webm'],
  ['https://a.com/v.mov', 'file', 'quicktime'],
  [prox('ts-proxy', 'https://a.com/One%20Piece%20S21E01.mkv'), 'mkv', 'proxied mkv'],
  ['https://a.com/movie.mkv', 'mkv', 'direct mkv'],
  [prox('ts-proxy', 'https://a.com/download?id=9'), 'file', 'proxied, no extension, ts route'],
  ['https://a.com/weird/thing', 'unknown', 'genuinely unknown'],
  ['', 'unknown', 'empty url']
];

let bad = 0;
for (const [url, want, desc] of CASES) {
  const got = helpers.classify({ url }).kind;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${String(got).padEnd(8)} want=${String(want).padEnd(8)} ${desc}`);
}

// The specific regression: a proxied playlist must be recognised as HLS.
const regression = helpers.isHlsUrl(prox('m3u8-proxy', 'https://a.com/x.m3u8?tk=1'))
  && !/\.m3u8(\?|#|$)/i.test(prox('m3u8-proxy', 'https://a.com/x.m3u8?tk=1'));
console.log(`\nregression (old bare /\\.m3u8/ misses proxied HLS, new helper catches it): ${regression ? 'ok' : 'FAIL'}`);
if (!regression) bad++;

console.log(bad ? `\nFAILED: ${bad} mismatch(es)` : `\nPASS: ${CASES.length + 1} checks`);
process.exit(bad ? 1 : 0);
