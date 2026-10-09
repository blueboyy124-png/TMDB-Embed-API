// Unit tests for utils/boundedCache.js -- the guard against unbounded memory growth.
//
// The bug this prevents: every cache was a bare `new Map()` with a TTL but no ceiling, and entries were only
// ever removed when read *after* expiry. A title nobody requested again stayed in the heap forever, so a
// long-running server that is browsed like a catalogue would climb in RSS until it was GC-thrashing (random
// latency spikes, stalled responses) and finally killed.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BoundedTtlCache } = require('../utils/boundedCache.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};

// 1. The ceiling is enforced no matter how much is written.
const c = new BoundedTtlCache(10);
for (let i = 0; i < 5000; i++) c.set(`k${i}`, { data: i, ts: Date.now() });
check('never exceeds maxEntries', c.size <= 10, `size=${c.size}`);

// 2. Eviction drops the OLDEST first (Map iterates in insertion order), so recent work survives.
const order = new BoundedTtlCache(3);
order.set('a', 1); order.set('b', 2); order.set('c', 3); order.set('d', 4);
check('oldest evicted first', !order.has('a') && order.has('d'), `has a=${order.has('a')} d=${order.has('d')}`);

// 3. A hot key is refreshed by a read, so it is never the one thrown away (the LRU-ish property that makes
//    eviction safe under real traffic rather than punishing whichever title was asked for first).
const hot = new BoundedTtlCache(3);
hot.set('x', 1); hot.set('y', 2); hot.set('z', 3);
hot.get('x');            // x becomes the newest
hot.set('w', 4);
check('hot key survives eviction', hot.has('x') && !hot.has('y'), `x=${hot.has('x')} y=${hot.has('y')}`);

// 4. Re-setting an existing key does not grow the map.
const dup = new BoundedTtlCache(5);
dup.set('k', 'v1'); dup.set('k', 'v2');
check('re-set does not duplicate', dup.size === 1 && dup.get('k') === 'v2', `size=${dup.size}`);

// 5. prune() drops expired entries using the caller's own freshness rule, so existing TTL semantics survive.
const ttl = new BoundedTtlCache(100);
for (let i = 0; i < 10; i++) ttl.set(`t${i}`, { ts: i < 5 ? Date.now() : Date.now() - 10_000_000 });
const dropped = ttl.prune(e => Date.now() - e.ts < 1000);
check('prune removes only expired', dropped === 5 && ttl.size === 5, `dropped=${dropped} left=${ttl.size}`);

// 6. Map-like surface, so existing call sites (get/set/has/delete/clear/iteration) are unchanged.
const api = new BoundedTtlCache(2);
api.set('a', 1);
const surface = ['get', 'has', 'set', 'delete', 'clear', 'size', 'keys', 'values', 'entries'];
check('exposes the Map surface used by callers', surface.every(k => k in api), surface.filter(k => !(k in api)).join(',') || 'all present');

// 7. A bad ceiling is rejected loudly rather than silently disabling the bound.
let threw = false;
try { new BoundedTtlCache(0); } catch { threw = true; }
check('rejects a non-positive ceiling', threw);

console.log('');
if (failures) { console.log(`FAILED: ${failures} check(s)`); process.exit(1); }
console.log('PASS: bounded cache evicts correctly under load');
