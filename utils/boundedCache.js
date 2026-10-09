/* A TTL cache with a hard entry ceiling.
 *
 * Why this exists: every provider and utility kept its own bare `new Map()` with a TTL but no size limit. An
 * entry is only ever removed when it is *read* after expiry, so a title nobody asks about again stays in
 * memory forever. On a server that is browsed like a catalogue rather than one title at a time, that is a slow
 * leak into the heap: RSS climbs until the process is GC-thrashing (which shows up as random latency spikes
 * and stalled responses) and eventually gets killed. Several of these caches hold parsed JSON bodies.
 *
 * This gives every one of them eviction. The policy is deliberately simple:
 *   - entries expire by TTL (the caller already supplies the age)
 *   - when the map is full, the OLDEST inserted entry is dropped (Map preserves insertion order, so this is
 *     just taking the first key -- no sorting, no per-write cost)
 *
 * Eviction is lazy but bounded: `prune()` runs on write when over the cap, so memory cannot grow without
 * limit even if nobody ever reads an entry again. `size` is exposed for the health endpoint.
 */
class BoundedTtlCache {
  /**
   * @param {number} maxEntries hard ceiling on retained entries
   * @param {object} [opts]
   * @param {number} [opts.maxEntries] alias, so callers can use either spelling
   */
  constructor(maxEntries, opts = {}) {
    const cap = Number(opts.maxEntries || maxEntries);
    if (!Number.isFinite(cap) || cap <= 0) throw new Error('BoundedTtlCache requires a positive maxEntries');
    this.maxEntries = Math.floor(cap);
    this.map = new Map();
  }

  get size() { return this.map.size; }

  // get() refreshes recency, so a key that is actively being used is never the one evicted. Map does NOT do
  // this on its own -- only re-inserting moves a key to the end -- so the delete/set pair is the mechanism.
  // The earlier version claimed Map handled it and did not, which is exactly the kind of assumption that makes
  // an LRU bound quietly degrade into FIFO under real traffic.
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  // Read without touching recency, for callers that cache immutable values and do not want a read to
  // count as a use.
  peek(key) { return this.map.get(key); }

  has(key) { return this.map.has(key); }

  set(key, value) {
    // Re-insert so the key moves to the end: a hot key is never the one evicted.
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) this.evictOldest();
    return this;
  }

  delete(key) { return this.map.delete(key); }

  clear() { this.map.clear(); }

  // Drop expired entries. `isFresh` mirrors the calling module's own freshness rule, so a cache keeps
  // whatever TTL semantics it had before it gained a size limit.
  prune(isFresh) {
    if (typeof isFresh !== 'function') return 0;
    let dropped = 0;
    for (const [k, v] of this.map) {
      if (!isFresh(v)) { this.map.delete(k); dropped++; }
    }
    return dropped;
  }

  evictOldest() {
    // Map iterates in insertion order, so the first key is the oldest.
    const oldest = this.map.keys().next();
    if (!oldest.done) this.map.delete(oldest.value);
  }

  keys() { return this.map.keys(); }
  values() { return this.map.values(); }
  entries() { return this.map.entries(); }
  [Symbol.iterator]() { return this.map[Symbol.iterator](); }
}

module.exports = { BoundedTtlCache };
