// Guards the audit fixes: that /api/config cannot be written or used to read secrets without a session, and
// that a nonsense season/episode is rejected instead of quietly serving a different episode.
//
// Both were real. POST /api/config was completely open and saveConfigPatch merges the patch with no key
// whitelist, so anyone who could reach the server could set enableProxy:false (breaking playback for
// everyone) or minQualities:"2160p" (filtering out every stream) -- and both GET and POST returned the TMDB
// API key and the FebBox cookie in plaintext. And `?season=abc` became NaN, which is falsy, so the providers'
// `seasonNum || 1` turned it into season 1 and returned 16 streams for the wrong episode with success:true.
import process from 'node:process';

const BASE = process.env.BASE || 'http://localhost:8787';
let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};

const req = (path, init) => fetch(`${BASE}${path}`, { cache: 'no-store', ...init });

// Read the real key/cookie out of the environment so "is it still being leaked" is a real comparison.
const key = (process.env.TMDB_API_KEY || '').slice(0, 12);
const cookie = (process.env.FEBBOX_COOKIES || '').slice(0, 20);

console.log('--- config must not be writable without a session ---');
const noAuth = await req('/api/config', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ minQualities: '2160p' })
});
check('POST /api/config without a session is refused', noAuth.status === 401, `HTTP ${noAuth.status}`);

console.log('\n--- config must not leak secrets on read ---');
const cfg = await req('/api/config');
const cfgText = await cfg.text();
check('GET /api/config still works (dashboard needs it)', cfg.ok, `HTTP ${cfg.status}`);
if (key) check('the real TMDB key is not in the response', !cfgText.includes(key), key ? `searched for ${key}…` : 'no key in env to compare');
if (cookie) check('the real FebBox cookie is not in the response', !cfgText.includes(cookie));
const parsed = JSON.parse(cfgText);
const m = parsed.merged || {};
check('a has* flag is provided instead', m.hasTmdbApiKeys !== undefined || m.hasFebboxCookies !== undefined,
  `hasTmdbApiKeys=${m.hasTmdbApiKeys} hasFebboxCookies=${m.hasFebboxCookies}`);
check('key values are masked, not empty', Array.isArray(m.tmdbApiKeys) ? m.tmdbApiKeys.every(v => !v || v.includes('…') || v === '•••') : true,
  JSON.stringify(m.tmdbApiKeys));

console.log('\n--- debug endpoint must not be open ---');
const dbg = await req('/api/debug/env');
check('GET /api/debug/env without a session is refused', dbg.status === 401, `HTTP ${dbg.status}`);

console.log('\n--- nonsense season/episode must fail, not silently serve another episode ---');
const BAD = [
  '/api/streams/series/1429?season=abc&episode=xyz',
  '/api/streams/series/1429?season=-5&episode=0',
  '/api/streams/series/1429?season=2.5&episode=1',
  '/api/streams/series/1429?season=1e3&episode=1',
  '/api/streams/series/1429?season=0x10&episode=1',
  '/api/metadata/series/1429?season=abc&episode=1',
  '/api/metadata/series/1429?season=1&episode=abc',
  '/api/streams/castletv/series/1429?season=abc&episode=1'
];
for (const p of BAD) {
  const r = await req(p);
  check(`rejected: ${p.slice(0, 52)}`, r.status === 400, `HTTP ${r.status}`);
}

console.log('\n--- half an episode is still rejected ---');
const half = await req('/api/streams/series/1429?season=2');
check('season without episode is refused', half.status === 400, `HTTP ${half.status}`);

console.log('\n--- but valid input must still work ---');
const good = await req('/api/streams/series/1429?season=2&episode=1&deadline=20000');
const goodBody = await good.json();
check('a valid request still returns streams', good.ok && Array.isArray(goodBody.streams) && goodBody.streams.length > 0,
  `HTTP ${good.status} count=${goodBody.count}`);
const spec = await req('/api/streams/series/1429?season=0&episode=1&deadline=20000');
check('season 0 (specials) is allowed', spec.status === 200, `HTTP ${spec.status}`);

console.log('\n--- response compression is on ---');
const enc = await req('/api/streams/series/1429?season=2&episode=1&deadline=20000', { headers: { 'Accept-Encoding': 'gzip' } });
check('JSON is served gzipped when accepted', /gzip/.test(String(enc.headers.get('content-encoding') || '')),
  `content-encoding=${enc.headers.get('content-encoding')}`);

console.log('');
if (failures) { console.log(`FAILED: ${failures} check(s)`); process.exit(1); }
console.log('PASS: config is locked down, bad input is rejected, valid input still works');
