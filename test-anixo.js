// Run from your project root:  node test-anixo2.js
// Unlike the first test, this runs the REAL anime provider in this same process and then fetches the
// links it made over the SAME shared anixo connection -- exactly what your server does. It also logs
// every time that connection is opened or closed, which is what decides whether the links can work.
try { require('dotenv').config(); } catch (_) { /* optional */ }
const { dispatcherFor } = require('./utils/anixoAgent');
const { getAnimeStreams } = require('./providers/anime');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://anixo.buzz/' };
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const disp = dispatcherFor('https://anixo.buzz/');
let opened = 0, closed = 0;
disp.on('connect', () => { opened++; console.log(`${ts()}  connection OPENED  (total opened: ${opened})`); });
disp.on('disconnect', (_o, _t, err) => { closed++; console.log(`${ts()}  connection CLOSED  (total closed: ${closed})${err ? ' ' + err.message : ''}`); });
disp.on('connectionError', (_o, _t, err) => console.log(`${ts()}  connection ERROR ${err && err.message}`));

const raw = (s) => { try { return decodeURIComponent(new URL(s.url).searchParams.get('url')); } catch (_) { return s.url; } };

async function probe(label, u) {
  try {
    const r = await fetch(u, { headers: H, dispatcher: disp, redirect: 'follow' });
    const body = (await r.text()).slice(0, 70).replace(/\s+/g, ' ');
    console.log(`${ts()}  ${String(r.status).padEnd(4)} ${label}   connection-header=${r.headers.get('connection')}  ${r.status === 200 ? body : ''}`);
    return r.status;
  } catch (e) { console.log(`${ts()}  ERR  ${label}  ${e.message}`); return 0; }
}

(async () => {
  console.log('making links with the real anime provider (takes ~10-15s)...');
  const rows = (await getAnimeStreams(1429, 'tv', 3, 1)).filter((r) => /anixo/i.test(r.url));
  console.log(`${ts()}  ${rows.length} anixo links made`);
  if (!rows.length) { console.log('no anixo links (anixo may be rate limiting you; wait a few minutes and retry)'); process.exit(0); }

  console.log('\n--- using the links right away, on the shared connection ---');
  for (let i = 0; i < Math.min(3, rows.length); i++) await probe(`link ${i} right away`, raw(rows[i]));

  console.log('\n--- same link again after waiting ---');
  await sleep(5000);  await probe('link 0 after 5s', raw(rows[0]));
  await sleep(10000); await probe('link 0 after 15s', raw(rows[0]));

  console.log(`\nsummary: connection opened ${opened}x, closed ${closed}x`);
  process.exit(0);
})();