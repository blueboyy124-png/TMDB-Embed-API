/* ============ Engine (copy this class into any project) ============
   1. Cached stream for the title, if fresh, is tried first (no network round trip to the API).
   2. Providers are ranked by learned success rate and speed. The best few start at once.
   3. If nothing has come back after a short "hedge" delay, the next provider starts, and so on.
      A fast failure starts the next one immediately.
   4. Every candidate is verified by actually loading video data before it is accepted,
      so a dead link falls through to the next candidate instead of showing a black screen.
   5. Providers that keep failing are skipped for a cooldown (circuit breaker), but are
      still tried last if everything else fails.
   6. Results feed back into the stats, so ranking improves the more it is used. */
class Resolver {
  constructor(o = {}) {
    this.base = o.base; this.timeout = o.timeout || 60000; this.initial = o.initial || 2;
    this.ttl = o.ttl || 3 * 60 * 60 * 1000; this.cooldown = o.cooldown || 2 * 60 * 1000;
    this.seed = o.seed || []; this.log = o.log || (() => {});
    this.stats = JSON.parse(localStorage.getItem('sr.stats') || '{}');
    this.names = null; this.t = 'movie'; this.only = false; this.expect = null;
    this.years = []; this.anime = false; this.ready = Promise.resolve(); this.bad = new Set(); this.demote = o.demote || ['netmirror']; this.grace = o.grace || 10000; this.absFirst = o.absFirst || ['showbox'];   // keep anime in one 'season 1' folder with absolute numbers
    this.num = {}; try { localStorage.removeItem('sr.num'); } catch {}   // old global per-provider override: it forced absolute numbering onto every show, so it is retired (now learned per show)
    this.seenUrl = new Map();   // stream url -> episode it was first returned for
    this.play = JSON.parse(localStorage.getItem('sr.play') || '{}'); this.hdr = new Set(); this.mkvSeen = false;   // play: provider -> links that did / did not really load here; hdr: providers whose links need Referer/Origin
    this.numT = JSON.parse(localStorage.getItem('sr.numt') || '{}'); // 'provider|title' -> 'abs' | 'tmdb', learned per show
    this.block = JSON.parse(localStorage.getItem('sr.block') || '{}');
    this.inflight = new Map(); this.maxCache = o.maxCache || 80; this.namesAt = 0;
    for (const k of Object.keys(this.stats)) if (!k.includes('|')) delete this.stats[k];
  }
  save() { localStorage.setItem('sr.stats', JSON.stringify(this.stats)); }
  stat(p) { return this.stats[p + '|' + this.t] ||= { ok: 0.7, lat: 3000, fail: 0, last: 0 }; }
  record(p, ok, ms) {
    const s = this.stat(p);
    s.ok = s.ok * 0.8 + (ok ? 0.2 : 0);
    if (ok) { s.lat = s.lat * 0.7 + ms * 0.3; s.fail = 0; } else { s.fail++; s.last = Date.now(); }
    this.save();
  }
  miss(p) { const s = this.stat(p); s.ok *= 0.95; this.save(); }   // answered but had nothing for this title: slight nudge, never a cooldown
  cooldownFor(s) { return this.cooldown * 2 ** Math.min(Math.max(s.fail - 3, 0), 4); }
  playRate(p) { const s = this.play[p] || { g: 0, b: 0 }; return (s.g + 1) / (s.g + s.b + 2); }
  played(p, ok) {
    const s = this.play[p] ||= { g: 0, b: 0 }; ok ? s.g++ : s.b++;
    if (s.g + s.b > 20) { s.g = Math.round(s.g / 2); s.b = Math.round(s.b / 2); }   // recent behaviour counts most
    try { localStorage.setItem('sr.play', JSON.stringify(this.play)); } catch {}
  }
  cooling(p) { const s = this.stat(p); return s.fail >= 3 && Date.now() - s.last < this.cooldownFor(s); }
  score(p) { const s = this.stat(p), i = this.seed.indexOf(p); return (s.ok * s.ok / (s.lat + 500)) * (0.25 + 0.75 * this.playRate(p)) * (i < 0 ? 1 : 1 + 1 / (i + 1)); }
  async providers() {
    if (this.names && Date.now() - this.namesAt < 300000) return this.names;   // provider list rarely changes
    try {
      const j = await (await fetch(this.base + '/api/providers')).json();
      const raw = Array.isArray(j) ? j : (j.providers || j);
      const e = Array.isArray(raw) ? raw.map(x => typeof x === 'string' ? [x, {}] : [x.name || x.id || x.key, x]) : Object.entries(raw);
      this.names = e.filter(([n, v]) => n && (typeof v !== 'object' || v.enabled !== false)).map(([n]) => n); this.namesAt = Date.now();
    } catch { this.names = this.names || this.seed.slice(); this.namesAt = 0; }
    return this.names;
  }
  async order(cx = this) {
    await Promise.race([cx.ready, new Promise(r => setTimeout(r, 1200))]);   // title info, so anime can demote Netflix mirrors
    let all = [...new Set([...(await this.providers()), ...this.seed])];
    if (this.only && this.seed.length) all = all.filter(p => this.seed.includes(p));
    const usable = all.filter(p => !this.block[p + '|' + this.t]);
    if (usable.length) all = usable;
    const idx = p => { const i = this.seed.indexOf(p); return i < 0 ? 99 : i; };
    const rank = all.sort((a, b) => this.score(b) - this.score(a) || idx(a) - idx(b));
    const ok = rank.filter(p => !this.cooling(p)), cool = rank.filter(p => this.cooling(p));
    const pin = this.seed.filter(p => ok.includes(p));                       // pinned providers always go first
    const low = ok.filter(p => cx.anime && this.demote.includes(p) && !pin.includes(p));
    const dead = p => this.stat(p).fail >= 6;   // still cooling and failing over and over: do not even try (each try leaves a stuck request on the API)
    const out = [...pin, ...ok.filter(p => !pin.includes(p) && !low.includes(p)), ...low, ...cool.filter(p => !dead(p))];
    return out.length ? out : cool;
  }
  key(t, id, q) { return `${t}:${id}` + (t === 'series' ? `:${q.season}:${q.episode}` : ''); }
  numMode(p, id) { return this.numT[p + '|' + id] || this.num[p] || 'tmdb'; }
  learn(p, id, m) {
    this.numT[p + '|' + id] = m;
    const ks = Object.keys(this.numT); if (ks.length > 300) ks.slice(0, ks.length - 300).forEach(k => delete this.numT[k]);
    try { localStorage.setItem('sr.numt', JSON.stringify(this.numT)); } catch {}
  }
  url(p, t, id, q, mode) {
    const abs = (mode || this.numMode(p, id)) === 'abs' && q.abs;   // 'abs' = season 1 + absolute episode number (anime style)
    return `${this.base}/api/streams/${p}/${t}/${id}` + (t === 'series' ? `?season=${abs ? 1 : q.season}&episode=${abs ? q.abs : q.episode}` : '');
  }
  clearCache() { Object.keys(localStorage).filter(k => k.startsWith('sr.c.')).forEach(k => localStorage.removeItem(k)); }
    cacheGet(k) {
    try { const c = JSON.parse(localStorage.getItem('sr.c.' + k)); if (c && Date.now() - c.t < this.ttl) return c.streams; } catch {}
    return null;
  }
  cachePut(k, streams) {
    const val = JSON.stringify({ t: Date.now(), streams });
    for (let i = 0; i < 3; i++) { try { localStorage.setItem('sr.c.' + k, val); break; } catch { this.prune(10); } }   // storage full: drop oldest, retry
    this.prune(0);
  }
  prune(extra) {   // keep at most maxCache saved links, oldest go first
    const all = Object.keys(localStorage).filter(x => x.startsWith('sr.c.')).map(x => { let t = 0; try { t = JSON.parse(localStorage.getItem(x)).t; } catch {} return [x, t]; }).sort((a, b) => a[1] - b[1]);
    let n = Math.max(extra, all.length - this.maxCache);
    for (const [x] of all) { if (n-- <= 0) break; localStorage.removeItem(x); }
  }
  cacheDrop(k) { localStorage.removeItem('sr.c.' + k); }
  static tag(s) {   // the episode the file itself claims: last SxxEyy found, since file names come last
    let tail = '';
    try { tail = decodeURIComponent(String(s.url).split('?')[0].split('/').pop()); } catch {}
    const all = [...`${s.name || ''} ${s.title || ''} ${tail}`.matchAll(/S(\d{1,2})\s*[ ._-]?E(\d{1,4})/gi)];
    const m = all[all.length - 1];
    return m ? { s: +m[1], e: +m[2] } : null;
  }
  static wrong(s, q) {
    const m = Resolver.tag(s);
    return !!m && !((m.s === +q.season && m.e === +q.episode) || (q.abs && m.e === +q.abs));
  }
  nameOk(x, expect = this.expect) {
    const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const txt = ' ' + norm(`${x.name || ''} ${x.title || ''}`) + ' ';
    if (expect.some(n => txt.includes(' ' + n + ' '))) return true;
    const rest = txt.replace(/\b(\d{3,4}p|4k|hdr\d*|dv|x26[45]|h26[45]|hevc|web|dl|webrip|bluray|brrip|mkv|mp4|aac|ddp?\d*|atmos|auto|febbox|fid|s\d{1,2} ?e\d{1,4})\b/g, ' ');
    return new Set(rest.split(' ').filter(w => w.length > 2 && !/^\d+$/.test(w))).size < 3;   // too little text to judge (distinct words: 'VaPlayer' in both name and title is one word)
  }
  reject(x, t, q, cx = this, id = null) {
    if (t === 'series' && Resolver.wrong(x, q)) { const m = Resolver.tag(x); return `wrong episode S${m.s}E${m.e}`; }
    if (this.bad.has(x.url)) return 'failed earlier';
    if (cx.expect && !this.nameOk(x, cx.expect)) return 'wrong title';
    const y = /\((\d{4})\)/.exec(`${x.name || ''} ${x.title || ''}`);   // e.g. live action (2023) vs anime (1999)
    if (y && cx.years.length && !cx.years.some(v => Math.abs(v - +y[1]) <= 1)) return 'wrong year ' + y[1];
    if (t === 'series' && id != null) {   // a provider that ignores the episode number returns the same file for every episode
      const ek = `${id}:${q.season}:${q.episode}`, prev = this.seenUrl.get(x.url);
      if (prev && prev !== ek) return 'same link already used for another episode';
      this.seenUrl.set(x.url, ek);
      if (this.seenUrl.size > 3000) this.seenUrl.delete(this.seenUrl.keys().next().value);
    }
    return '';
  }
  direct(c) {   // .../ts-proxy?url=<upstream>  ->  the upstream link itself (null when c is not a proxied file link)
    try {
      const u = new URL(c.url, this.base);
      if (u.origin !== new URL(this.base).origin || !/\/ts-proxy$/.test(u.pathname)) return null;
      const o = u.searchParams.get('url');
      return o && /^https?:/i.test(o) ? { ...c, url: o, direct: true } : null;
    } catch { return null; }
  }
  static hevc() {   // can this browser play H.265? most cannot, and an x265 file would burn a probe slot for nothing
    if (Resolver._hevc == null) {
      try { const v = document.createElement('video'); Resolver._hevc = !!(v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') || v.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"')); }
      catch { Resolver._hevc = false; }
    }
    return Resolver._hevc;
  }
  static mkv() { if (Resolver._mkv == null) { try { Resolver._mkv = !!document.createElement('video').canPlayType('video/x-matroska'); } catch { Resolver._mkv = false; } } return Resolver._mkv; }
  // ★ INTEGRATION NOTE A (copy of the same helper in player.html — keep the two in sync) ★
  // An HLS playlist, INCLUDING our own proxy endpoint "/m3u8-proxy?url=...".
  // A bare /\.m3u8/ test is WRONG here: "m3u8-proxy" has no dot before "m3u8", so every proxied
  // stream would be misjudged as a plain file — ranked low (playable() 1) and never treated as HLS.
  // player.html defines the same helper for its own use; both must stay identical.
  static isHlsUrl(u) {
    if (typeof u !== 'string') return false;
    return /\.m3u8(\?|#|$)/i.test(u) || /\/m3u8-proxy(\?|$)/i.test(u);
  }
  static isMkv(s) { return !Resolver.isHlsUrl(s.url) && /\.mkv|\bmkv\b|matroska/i.test(`${s.name || ''} ${s.title || ''} ${s.url}`); }
  static playable(s) {   // 2 = should play here, 1 = one likely problem, 0 = two (still tried, but last)
    if (Resolver.isHlsUrl(s.url)) return 2;
    const hevc = /x265|hevc|h[ .]?265/i.test(`${s.name || ''} ${s.title || ''} ${s.url}`);
    return (Resolver.isMkv(s) && !Resolver.mkv() ? 0 : 1) + (hevc && !Resolver.hevc() ? 0 : 1);
  }
  static exact(s, q) { const m = Resolver.tag(s); return m && ((m.s === +q.season && m.e === +q.episode) || (q.abs && m.e === +q.abs)) ? 1 : 0; }
  static q(x) { x = String(x || '').toLowerCase(); return x.includes('4k') ? 2160 : x === 'auto' ? 1080 : parseInt(x) || 0; }

  async *candidates(t, id, q = {}, signal, cx = this, quiet = false) {
    const k = this.key(t, id, q);
    const order = await this.order(cx);
    this.log('order: ' + order.map(p => p + (this.cooling(p) ? '(cooling)' : '')).join(', '));
    const ctrl = new AbortController();
    const queue = []; let wake = null, launched = 0, pending = 0, done = false, timer = null, said = false;
    const pend = new Set(), live = new Set(), out = {}, t00 = Date.now(); let yielded = 0;   // live = healthy providers still loading   // pinned providers still loading; their results get first pick
    const pinned = order.filter(p => this.seed.includes(p) && this.stat(p).ok >= 0.3);   // one that mostly fails is not worth waiting for
    const held = () => pend.size > 0 && Date.now() - t00 < this.grace;
    const ping = () => wake && wake();
    if (signal) signal.addEventListener('abort', () => { done = true; ctrl.abort(); ping(); }, { once: true });
    let step = 0;
    const hedge = () => Math.max(400, Math.min(2500, Math.max(600, this.stat(order[0]).lat * 1.3)) * Math.pow(0.8, step++));

    const launch = () => {
      if (done || launched >= order.length) return;
      if (this.cooling(order[launched]) && live.size > 0) return;   // providers on cooldown only get a turn once every healthy one has answered
      const p = order[launched++]; const t0 = performance.now(); pending++; if (pinned.includes(p)) pend.add(p); if (!this.cooling(p)) live.add(p);
      this.log('start ' + p);
      const ask = async (mode, sg) => {
        const r = await fetch(this.url(p, t, id, q, mode), { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(this.cooling(p) ? 5000 : this.stat(p).ok < 0.5 ? 12000 : Math.min(this.timeout, Math.max(20000, this.stat(p).lat * 4))), ...(sg ? [sg] : [])]) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        return (Array.isArray(j) ? j : (j.streams || [])).filter(x => x && x.url);
      };
      const sift = (raw, mode) => {   // drop wrong episode/title/year; best first: exact episode, playable in this browser, then quality
        const bad = [];
        let list = raw.filter(x => { const r = this.reject(x, t, q, cx, id); if (r) bad.push(r); return !r; });
        if (t === 'series' && mode === 'abs' && q.abs && this.url(p, t, id, q, 'abs') !== this.url(p, t, id, q, 'tmdb')) {
          const ok = list.filter(x => Resolver.exact(x, q));   // absolute numbering is a guess: only trust a file that says which episode it is
          if (ok.length < list.length) bad.push('untagged link in absolute mode');
          list = ok;
        }
        list.sort((a, b) => (t === 'series' ? Resolver.exact(b, q) - Resolver.exact(a, q) : 0) || Resolver.playable(b) - Resolver.playable(a) || Resolver.q(b.quality) - Resolver.q(a.quality));
        return { list, bad };
      };
      (async () => {
        const learned = !!this.numT[p + '|' + id], pref = !learned && t === 'series' && q.abs && cx.anime && this.absFirst.includes(p);
        const first = pref ? 'abs' : this.numMode(p, id), other = first === 'abs' ? 'tmdb' : 'abs';
        const altOk = () => t === 'series' && q.abs && (cx.anime || !cx.expect) && this.url(p, t, id, q, other) !== this.url(p, t, id, q, first);
        const run = async (mode, sg) => { const raw = await ask(mode, sg); await cx.ready; return sift(raw, mode); };
        // Anime past season 1 is often only known by absolute number (or TMDB season/episode for a provider that wants absolute).
        // First time for this provider+show: ask both numberings at once, so the fallback costs no extra time.
        // Already learned: ask the known one and only try the other if it comes back empty.
        const alt = new AbortController();
        const early = !quiet && !learned && !pref && altOk();   // warm-ups stay light: no doubled requests
        const p2 = early ? run(other, alt.signal).catch(() => null) : null;
        let err = null, used = first;
        let r = await run(first).catch(e => { err = e; return null; });
        if (r && r.list.length) alt.abort();
        else {
          let r2 = null;
          if (p2) r2 = await p2;
          else if (altOk()) { this.log(`${p}: nothing with ${first} numbering, trying ${other}`); r2 = await run(other).catch(() => null); }
          if (r2 && r2.list.length) { r = r2; used = other; this.learn(p, id, other); this.log(`${p}: ${other} numbering works for this show, remembered`); }
          else if (!r) throw err || new Error('no response');
        }
        const { list, bad } = r;
        const ms = performance.now() - t0;
        if (bad.length) this.log(`${p}: skipped ${bad.length} (${bad[0]})`);
        if (!list.length) { out[p] = 'empty'; this.miss(p); this.log(`${p}: no usable streams`); launch(); return; }   // empty is not a provider failure
        out[p] = 'ok'; this.record(p, true, ms); this.log(`${p}: ${list.length} streams in ${Math.round(ms)}ms | ${String(list[0].title || list[0].name || '').trim().split('\n')[0].slice(0, 60)}`);
        if (list.some(s => s.headers && (s.headers.Referer || s.headers.Origin))) this.hdr.add(p);
        if (list.some(Resolver.isMkv)) this.mkvSeen = true;
        queue.push(...list.map(s => ({ ...s, provider: s.provider || p, src: p, ms })));
        ping();   // wake the generator now, while p is still marked pending, so a pinned result gets first pick
      })()
        .catch(e => { if (!done) { out[p] = e.name === 'TimeoutError' ? 'timed out' : e.message; this.record(p, false); this.log(`${p}: ${out[p]}`); launch(); } })
        .finally(() => { pending--; pend.delete(p); live.delete(p); if (!done && !live.size && launched < order.length && this.cooling(order[launched])) launch(); ping(); });
    };
    const tick = () => { if (done || launched >= order.length) return; launch(); timer = setTimeout(tick, hedge()); };

    try {
      for (let i = 0; i < this.initial; i++) launch();
      timer = setTimeout(tick, hedge());
      while (true) {
        while (queue.length) {
          const i = held() ? queue.findIndex(x => this.seed.includes(x.src)) : 0;
          if (i < 0) { if (!said) { said = true; this.log('waiting for pinned provider before using others'); } break; }
          yielded++; yield queue.splice(i, 1)[0];
        }
        if (launched >= order.length && pending === 0) return;
        await new Promise(r => { wake = r; setTimeout(r, 300); });
        if (done) return;
      }
    } finally {
      done = true; clearTimeout(timer); ctrl.abort();
      if (!yielded && !(signal && signal.aborted)) {   // one line that says who had nothing, who broke, who was slow
        const g = {}; for (const [p, r] of Object.entries(out)) (g[r === 'empty' ? 'no match' : r] ||= []).push(p);
        const stuck = order.filter(p => !(p in out) && order.indexOf(p) < launched);
        this.log('summary: ' + (Object.entries(g).map(([r, ps]) => `${r}: ${ps.join(', ')}`).concat(stuck.length ? ['no answer: ' + stuck.join(', ')] : []).join(' | ') || 'no providers answered'));
      }
    }
  }

  // Warm the cache for a title (next episode, or the one being typed) without playing it.
  // One job per title; a Play on the same title joins it instead of asking the API twice.
  prefetch(t, id, q = {}, cx) {
    const k = this.key(t, id, q);
    if (this.cacheGet(k)) return Promise.resolve();
    if (this.inflight.has(k)) return this.inflight.get(k);
    const ac = new AbortController();
    const job = (async () => {
      try { for await (const c of this.candidates(t, id, q, ac.signal, cx, true)) { this.cachePut(k, [c]); this.log('warmed ' + k); return c; } }
      catch {} finally { this.inflight.delete(k); }
    })();
    job.abort = () => ac.abort();
    this.inflight.set(k, job);
    return job;
  }
  cancelWarm(keep) { for (const [k, j] of this.inflight) if (k !== keep) j.abort(); }
  // Resolve and verify. verify(stream) must resolve true when it really plays.
  // Verifies up to K candidates at the same time; first one that really loads wins.
  async resolve(t, id, q, verify, K = 3, ext, pinWindow = 1500, cx) {
    const k = this.key(t, id, q), ac = new AbortController(), sg = ac.signal;
    const warm = this.inflight.get(k);
    if (warm && !this.cacheGet(k)) {   // a warm-up for this exact title is already running: wait for it instead of duplicating
      this.log('joining background warm-up');
      await Promise.race([warm, new Promise(r => setTimeout(r, this.grace + 1500))]);
      if (ext && ext.aborted) return null;
    }
    if (ext) { if (ext.aborted) ac.abort(); else ext.addEventListener('abort', () => ac.abort(), { once: true }); }
    let win = null, active = 0, ended = false, w = [], pinBusy = false, pinAt = 0; const deadSrc = new Set();
    const poke = () => w.splice(0).forEach(r => r()), wait = () => new Promise(r => w.push(r));
    // A link that goes through the API proxy gets a second chance straight from its source if the proxy path fails.
    const vfy = async (c, sg) => {
      let r = await verify(c, sg);
      if (!r && !sg.aborted) {
        const d = this.direct(c);
        if (d) {
          this.log(`${c.src || 'cache'}: proxied link failed${c.why ? ' (' + c.why + ')' : ''}, trying the upstream link directly`);
          const r2 = await verify(d, sg);
          if (r2) { c.url = d.url; c.direct = true; return r2; }
          if (d.why) c.why = (c.why || '') + ' | direct: ' + d.why;
        }
      }
      return r;
    };
    // 1) A saved link goes first, alone. Providers are only asked if it fails or is slow (3.5s), so replays cost no API calls.
    const saved = this.cacheGet(k);
    if (saved && !sg.aborted) {
      this.log('cache hit, trying saved link first');
      for (const s of saved.slice(0, 2)) {
        if (sg.aborted) break;
        await (cx || this).ready;
        const why = this.reject(s, t, q, cx || this, id);   // a saved link must still pass the episode/title/year checks
        if (why) { this.log(`saved link skipped (${why})`); continue; }
        const c = { ...s, cached: true }, cac = new AbortController(), stop = () => cac.abort();
        sg.addEventListener('abort', stop, { once: true });
        const timer = setTimeout(stop, 3500);
        const r = await vfy(c, cac.signal);
        clearTimeout(timer); sg.removeEventListener('abort', stop);
        if (r) { win = c; c.probe = r; break; }
        if (!sg.aborted) this.log('saved link no longer works' + (c.why ? ` (${c.why})` : ''));
      }
      if (!win) this.cacheDrop(k);
    }
    // 2) Otherwise ask the providers.
    if (win || sg.aborted) ended = true; else (async () => {
      for await (const c of this.candidates(t, id, q, sg, cx)) {
        const isPin = this.seed.includes(c.src);
        // A pinned candidate gets a head start: nothing else launches until it
        // either finishes or pinWindow runs out, so a faster-but-unpinned link
        // can never race it and win purely on timing.
        while (!sg.aborted && (active >= K || (pinBusy && !isPin && Date.now() - pinAt < pinWindow))) await wait();
        if (sg.aborted) break;
        if (isPin) { pinBusy = true; pinAt = Date.now(); }
        active++; this.log(`try ${c.src || 'cache'} ${c.quality || ''}${isPin ? ' (pinned)' : ''}`);
        vfy(c, sg).then(r => {
          active--; if (isPin) pinBusy = false;
          if (r && !win && !sg.aborted) { win = c; c.probe = r; ac.abort(); if (c.src) this.played(c.src, true); }
          else if (r) { r.kill(); if (c.src) this.played(c.src, true); }
          else if (!sg.aborted) { if (c.src && !deadSrc.has(c.src)) { deadSrc.add(c.src); this.played(c.src, false); } this.log(`${c.src || 'cache'} ${c.quality || ''}: link failed${c.why ? ' (' + c.why + ')' : ''}`); }
          poke();
        });
      }
      ended = true; poke();
    })();
    while (!win && !(ended && active === 0) && !(ext && ext.aborted)) await wait();
    if (win) { const { probe, ...plain } = win; this.cachePut(k, [plain]); }
    return win;
  }
}

if (typeof module !== 'undefined') module.exports = Resolver;