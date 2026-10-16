// Run from your project root (the folder that contains utils/):  node test-anixo.js
// Tries several ways of asking anixo for the playlist, each on its own freshly made link.
let dispatcherFor = () => undefined;
try { ({ dispatcherFor } = require('./utils/anixoAgent')); console.log('using utils/anixoAgent dispatcher'); }
catch (e) { console.log('could not load utils/anixoAgent (' + e.message.split('\n')[0] + ') -> plain fetch'); }

const API = process.env.API || 'http://localhost:8787';
const URL_ = `${API}/api/streams/anime/series/1429?season=3&episode=1`;
const UA124 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA131 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REF = { Referer: 'https://anixo.buzz/' };

const variants = [
  ['UA 124 + Referer      (what anime.js uses)', { 'User-Agent': UA124, ...REF }],
  ['UA 131 + Referer      (what the proxy uses)', { 'User-Agent': UA131, ...REF }],
  ['UA 131 + Referer + Origin', { 'User-Agent': UA131, ...REF, Origin: 'https://anixo.buzz' }],
  ['no User-Agent + Referer', { ...REF }],
  ['UA 124, NO Referer', { 'User-Agent': UA124 }],
];

(async () => {
  const t0 = Date.now();
  const d = await (await fetch(URL_)).json();
  const lookupMs = Date.now() - t0;
  const rows = (d.streams || []).filter(s => /anixo/i.test(s.url));
  console.log(`lookup took ${lookupMs}ms, ${rows.length} anixo links`);
  if (!rows.length) { console.log('no anixo links to test (wait a few minutes and retry)'); return; }
  const raw = s => decodeURIComponent(new URL(s.url).searchParams.get('url'));
  const madeAt = Date.now();
  for (let i = 0; i < variants.length && i < rows.length; i++) {
    const [label, headers] = variants[i];
    const u = raw(rows[i]);
    const disp = dispatcherFor(u);
    try {
      const r = await fetch(u, disp ? { headers, dispatcher: disp, redirect: 'follow' } : { headers, redirect: 'follow' });
      const body = (await r.text()).slice(0, 250).replace(/\s+/g, ' ');
      console.log(`${String(r.status).padEnd(4)} +${((Date.now() - madeAt) / 1000).toFixed(1)}s  ${label}   ${body}`);
    } catch (e) { console.log(`ERR   ${label}   ${e.message}`); }
  }

  // Phase 2: same link, shared connection vs brand-new connections. Your network may give each new
  // connection a different public IP, and anixo ties a link to the IP that asked for it.
  console.log('\n--- same link, shared connection vs fresh connections ---');
  const u = raw(rows[0]);
  const H = { 'User-Agent': UA124, ...REF };
  const disp = dispatcherFor(u);
  const status = async (opts) => { try { const r = await fetch(u, { headers: H, ...opts }); await r.text(); return r.status; } catch (e) { return 'ERR'; } };
  let shared = [];
  for (let i = 0; i < 3; i++) shared.push(await status(disp ? { dispatcher: disp } : {}));
  console.log('shared connection x3:', shared.join(' '));
  let fresh = [];
  try {
    const { Agent } = require('undici');
    for (let i = 0; i < 4; i++) { const a = new Agent({ connections: 1 }); fresh.push(await status({ dispatcher: a })); await a.close(); }
  } catch (e) { fresh = ['(undici not found: ' + e.message.split('\n')[0] + ')']; }
  console.log('fresh connection  x4:', fresh.join(' '));
  try { const ip = await (await fetch('https://api.ipify.org')).text(); console.log('your public IP right now:', ip); } catch (e) { /* ignore */ }
})();