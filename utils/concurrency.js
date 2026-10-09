/* A counting semaphore, for bounding how much work the process does at once.
 *
 * Why this exists: the aggregate endpoint fans out to ~14 providers per request, and nothing bounded that
 * globally. Two simultaneous users therefore produced ~28 provider invocations, each of which may fan out
 * further internally (the anime provider probes every link it found, 4khdhub parses large HTML pages with
 * cheerio). With 8 users that is ~112 concurrent invocations.
 *
 * The failure is not just slow: the heavy providers do CPU-bound parsing, which blocks Node's single event
 * loop, and when the loop is blocked TIMERS STOP FIRING. Measured during a load test, the aggregate's own
 * 20s soft-deadline timer fired 108,136ms late, so the "leave early rather than wait" safeguard that is
 * supposed to protect the user could not fire either. Users got 60s client timeouts instead of a fast partial
 * answer, and /api/health slowed from 4ms to 474ms -- one heavy request degrading everyone.
 *
 * So provider work is admitted a few at a time, process-wide. Extra work waits its turn instead of thrashing
 * the loop, which keeps timers, timeouts and health checks responsive no matter how many users arrive.
 * The cap is deliberately above one request's provider count so a single user is never slowed down.
 */
class Semaphore {
  constructor(limit) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n < 1) throw new Error('Semaphore requires a limit >= 1');
    this.limit = Math.floor(n);
    this.active = 0;
    this.queue = [];
    this.maxObservedQueue = 0;   // for diagnostics: how much work had to wait
  }

  get pending() { return this.queue.length; }

  _next() {
    if (this.active >= this.limit || this.queue.length === 0) return;
    const { fn, resolve, reject } = this.queue.shift();
    this.active++;
    // Run detached from the caller's chain: the permit must be released by the work itself, however it
    // settles, and a caller that awaits this must never be able to starve the queue.
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => { this.active--; this._next(); });
  }

  // Returns a promise for fn's result, once a permit is free.
  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      if (this.queue.length > this.maxObservedQueue) this.maxObservedQueue = this.queue.length;
      this._next();
    });
  }

  status() {
    return { limit: this.limit, active: this.active, pending: this.queue.length, maxObservedQueue: this.maxObservedQueue };
  }
}

module.exports = { Semaphore };
