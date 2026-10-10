// Guards the Showbox liveness probe and dead-last sort. The rules under test:
//   1. A link that answers 4xx/5xx is dead (playlists included — dead HLS rows used to ship
//      as if fine because the old size probe skipped .m3u8 entirely).
//   2. A link that times out or refuses the connection is NOT dead: a slow CDN is not a dead
//      CDN, and a false "dead" hides a playable row.
//   3. The 30-minute dead marker is honoured (no re-probe) and expires (no eternal damnation).
//   4. Dead rows are kept, but sink below everything alive, preserving order within each group.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

delete process.env.DISABLE_CACHE;                       // the marker tests need the cache ON
const Showbox = require('../providers/Showbox.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};

let mode = 'ok-hls';
const server = http.createServer((req, res) => {
  if (mode === 'dead') { res.writeHead(403).end('access denied'); return; }
  if (mode === 'ok-file') { res.writeHead(200, { 'Content-Length': '1048576' }).end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
    .end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-ENDLIST\n');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const url = (file) => `${base}/${file}`;

const CACHE_DIR = process.env.SHOWBOX_CACHE_DIR || path.join(os.tmpdir(), 'tmdb-embed-showbox-cache');
const markerPath = (u) => path.join(CACHE_DIR, 'stream_liveness', crypto.createHash('md5').update(u).digest('hex') + '.json');
const plantMarker = (u, marker) => {
  fs.mkdirSync(path.dirname(markerPath(u)), { recursive: true });
  fs.writeFileSync(markerPath(u), JSON.stringify(marker));
};
const plant = (u, marker) => plantMarker(u, marker);
// Every URL the probe touches can leave a marker behind (it caches what it learns) — all are
// removed at the end so a rerun re-proves the network paths instead of trusting old verdicts.
const touched = ['dead.m3u8', 'dead.mkv', 'live.m3u8', 'live.mkv', 'marker-dead.m3u8', 'marker-expired.m3u8']
  .map(file => url(file));

try {
  console.log('--- dead links are marked dead (playlists included) ---');
  mode = 'dead';
  let r = await Showbox.fetchStreamProbe(url('dead.m3u8'));
  check('dead playlist -> dead', r.dead === true, JSON.stringify(r));
  r = await Showbox.fetchStreamProbe(url('dead.mkv'));
  check('dead file -> dead', r.dead === true, JSON.stringify(r));

  console.log('\n--- live links are alive, with sizes ---');
  mode = 'ok-hls';
  r = await Showbox.fetchStreamProbe(url('live.m3u8'));
  check('live playlist -> alive', r.dead === false, JSON.stringify(r));
  check('playlist size labelled', r.size === 'Playlist (size N/A)', r.size);
  mode = 'ok-file';
  r = await Showbox.fetchStreamProbe(url('live.mkv'));
  check('live file -> alive', r.dead === false, JSON.stringify(r));
  check('file size parsed from content-length', r.size === '1.00 MB', r.size);

  console.log('\n--- a connection error is NOT dead ---');
  r = await Showbox.fetchStreamProbe('http://127.0.0.1:9/refused.m3u8');
  check('refused connection -> not dead', r.dead === false, JSON.stringify(r));

  console.log('\n--- dead marker is honoured, then expires ---');
  mode = 'ok-hls';                              // network would say ALIVE — the marker must win
  const u1 = url('marker-dead.m3u8');
  plant(u1, { dead: true, status: 403, ts: Date.now() });
  r = await Showbox.fetchStreamProbe(u1);
  check('fresh dead marker -> dead', r.dead === true, JSON.stringify(r));

  const u2 = url('marker-expired.m3u8');
  plant(u2, { dead: true, status: 403, ts: Date.now() - 31 * 60 * 1000 });
  r = await Showbox.fetchStreamProbe(u2);
  check('expired dead marker -> re-probed alive', r.dead === false, JSON.stringify(r));

  console.log('\n--- dead rows sink, order preserved, nothing dropped ---');
  const rows = [
    { url: 'a', linkDead: false },
    { url: 'b', linkDead: true },
    { url: 'c' },                                 // unprobed: still offered, among the live ones
    { url: 'd', linkDead: true },
    { url: 'e', linkDead: false },
  ];
  const sorted = Showbox.sortDeadLast(rows);
  check('dead at the end', sorted.map(s => s.url).join(',') === 'a,c,e,b,d', sorted.map(s => s.url).join(','));
  check('nothing dropped', sorted.length === rows.length);
  const allDead = [{ url: 'x', linkDead: true }, { url: 'y', linkDead: true }];
  check('all-dead keeps order', Showbox.sortDeadLast(allDead)[0].url === 'x');
  const noneDead = [{ url: 'p' }, { url: 'q' }];
  check('no-dead returns as-is', Showbox.sortDeadLast(noneDead) === noneDead);
} finally {
  for (const u of touched) { try { fs.unlinkSync(markerPath(u)); } catch { /* already gone */ } }
  server.close();
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
