/* MacStream — app.js
 * Routing, API calls, views, continue-watching, and the player controller.
 * Requires player.js (MacPlayer) and hls.js. No build step.
 */
(function () {
  'use strict';

  /* =====================================================================
   * Config — ONE constant decides the API origin. It always uses the same
   * host the page was opened on, so proxy URLs built from the Host header
   * stay consistent. Override with ?api=http://host:port if needed.
   * ===================================================================== */
  const API = (function () {
    // Optional: hard-code your hosted API here, e.g. 'https://your-project.vercel.app'. Leave '' to auto-detect.
    const API_URL = '';
    const KEY = 'macstream.api';
    const clean = (u) => String(u).trim().replace(/\/+$/, '').replace(/\/api$/i, '');
    const params = new URLSearchParams(location.search);
    const fromQuery = params.get('api');
    let saved = '';
    try {
      if (fromQuery === 'reset') localStorage.removeItem(KEY);
      else if (fromQuery) localStorage.setItem(KEY, clean(fromQuery));   // remembered, so ?api= is only needed once
      saved = localStorage.getItem(KEY) || '';
    } catch (_) { /* storage blocked: fall through */ }
    if (fromQuery && fromQuery !== 'reset') return clean(fromQuery);
    if (API_URL) return clean(API_URL);
    if (saved) return clean(saved);
    if (location.port === '8787') return location.origin;
    const local = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
    if (!local) return location.origin;                                   // hosted next to the API
    return `${location.protocol === 'https:' ? 'http:' : location.protocol}//${location.hostname}:8787`;
  })();

  /* ---------- tiny utilities ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function fmtRuntime(min) {
    if (!min || !isFinite(min)) return '';
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h ? `${h}h ${m ? m + 'm' : ''}`.trim() : `${m}m`;
  }
  const yearOf = (x) => x.year || (x.releaseDate ? String(x.releaseDate).slice(0, 4) : '');

  /* ---------- icons ---------- */
  const ICONS = {
    play: ['fill', '<path d="M8 5v14l11-7z"/>'],
    pause: ['fill', '<path d="M6.5 5h3.8v14H6.5zM13.7 5h3.8v14h-3.8z"/>'],
    close: ['', '<path d="M6 6l12 12M18 6L6 18"/>'],
    chevDown: ['', '<path d="M5 9l7 7 7-7"/>'],
    chevL: ['', '<path d="M15 5l-7 7 7 7"/>'],
    chevR: ['', '<path d="M9 5l7 7-7 7"/>'],
    rew10: ['', '<path d="M12 5V2L8 6l4 4V7a6.5 6.5 0 1 1-6.5 6.5"/><text x="12.2" y="16" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">10</text>'],
    fwd10: ['', '<path d="M12 5V2l4 4-4 4V7a6.5 6.5 0 1 0 6.5 6.5"/><text x="11.8" y="16" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">10</text>'],
    volume: ['', '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'],
    mute: ['', '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'],
    layers: ['', '<path d="M12 3.5l9 4.8-9 4.8-9-4.8z"/><path d="M3 12.4l9 4.8 9-4.8M3 16.6l9 4.8 9-4.8" opacity=".75"/>'],
    mini: ['', '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/>'],
    pip: ['', '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="11.5" y="10.5" width="7" height="5.5" rx="1.2" fill="currentColor"/><path d="M6.5 9.5h4.5M6.5 12.5h2.5"/>'],
    pipExit: ['', '<rect x="3" y="5" width="18" height="14" rx="2.5" opacity=".35"/><rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="11.5" y="10.5" width="7" height="5.5" rx="1.2" fill="currentColor"/>'],
    expand: ['', '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'],
    shrink: ['', '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'],
    search: ['', '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'],
    home: ['fill', '<path d="M12 3.2l9 7.6V21h-6v-6h-6v6H3V10.8z"/>'],
    film: ['', '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M8 4v16M16 4v16M3.5 9h4.5M3.5 15h4.5M16 9h4.5M16 15h4.5"/>'],
    tv: ['', '<rect x="3" y="6" width="18" height="12.5" rx="2.5"/><path d="M8.5 21h7M9 3l3 3 3-3"/>'],
    keyboard: ['', '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>'],
    next: ['fill', '<path d="M6 5l9 7-9 7zM17 5h2v14h-2z"/>'],
    star: ['fill', '<path d="M12 3.4l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.7l6-.8z"/>'],
    alert: ['', '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>'],
    restart: ['', '<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 4v4.5H9"/>'],
    info: ['', '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>'],
    cc: ['', '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.4 10.3a2.5 2.5 0 1 0 0 3.4M17.2 10.3a2.5 2.5 0 1 0 0 3.4"/>'],
    chevSel: ['', '<path d="M6 9l6 6 6-6"/>']
  };
  function icon(name, extra) {
    const d = ICONS[name] || ['', ''];
    return `<svg class="ic ${d[0]} ${extra || ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d[1]}</svg>`;
  }
  function hydrateIcons(root) {
    $$('[data-icon]', root || document).forEach((el) => { if (!el.firstElementChild) el.innerHTML = icon(el.dataset.icon); });
  }
  function setIcon(el, name) { el.dataset.icon = name; el.innerHTML = icon(name); }

  /* ---------- images: lazy-load with graceful fallbacks ---------- */
  function imgBox(url, label, cls, eager) {
    const img = url ? `<img src="${esc(url)}" alt="" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" draggable="false">` : '';
    return `<div class="img-wrap ${cls || ''} ${url ? '' : 'failed'}">${img}<span class="fb">${esc(label)}</span></div>`;
  }
  document.addEventListener('load', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG') t.classList.add('loaded');
  }, true);
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'IMG') return;
    if (t.classList.contains('hero-logo') && t.parentElement) {
      const h = t.parentElement;
      h.classList.add('hero-title');
      h.textContent = t.dataset.title || '';
      return;
    }
    const w = t.closest('.img-wrap');
    if (w) w.classList.add('failed');
    else t.style.visibility = 'hidden';
  }, true);
  function settleImages(root) {
    $$('img', root).forEach((img) => {
      if (!img.complete) return;
      if (img.naturalWidth > 0) img.classList.add('loaded');
      else { const w = img.closest('.img-wrap'); if (w) w.classList.add('failed'); }
    });
  }

  /* =====================================================================
   * Local storage: progress + preferences
   * ===================================================================== */
  const PROGRESS_KEY = 'macstream.progress.v1';
  const PREFS_KEY = 'macstream.prefs.v1';
  const store = {
    read(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (_) { return fallback; } },
    write(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* quota / private mode */ } }
  };
  const progressKey = (type, id) => `${type}:${id}`;
  const getAllProgress = () => store.read(PROGRESS_KEY, {});
  const getProgress = (type, id) => getAllProgress()[progressKey(type, id)] || null;
  function putProgress(entry) {
    const all = getAllProgress();
    all[progressKey(entry.type, entry.id)] = entry;
    store.write(PROGRESS_KEY, all);
  }
  function dropProgress(type, id) {
    const all = getAllProgress();
    delete all[progressKey(type, id)];
    store.write(PROGRESS_KEY, all);
  }
  const prefs = Object.assign({ autoNext: true, volume: 1, muted: false, animeTrack: 'dub' }, store.read(PREFS_KEY, {}));
  const savePrefs = () => store.write(PREFS_KEY, prefs);

  /* =====================================================================
   * API
   * ===================================================================== */
  async function api(path, opts) {
    const { timeout = 25000, signal } = opts || {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    try {
      const res = await fetch(API + path, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.success === false) throw new Error(json.error || 'The API reported an error');
      return json;
    } catch (err) {
      const cancelled = signal && signal.aborted;
      if (!cancelled && (err.name === 'TypeError' || err.name === 'AbortError')) { health.check(); }
      throw err;
    } finally { clearTimeout(timer); }
  }

  const health = {
    ok: null, timer: null,
    async check() {
      let ok = false;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(`${API}/api/health`, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(t);
        const j = await res.json();
        ok = !!(j && j.ok);
      } catch (_) { ok = false; }
      const was = this.ok;
      this.ok = ok;
      const dot = $('#statusDot');
      dot.className = 'status-dot ' + (ok ? 'ok' : 'down');
      dot.setAttribute('aria-label', ok ? 'Server online' : 'Server offline');
      dot.title = ok ? 'Server online' : 'Server offline';
      $('#offline').hidden = ok;
      $('#offlineHost').textContent = API;
      if (ok && was === false) route(true); // reconnect: refresh the current view
      return ok;
    },
    start() { this.check(); this.timer = setInterval(() => this.check(), 15000); }
  };

  const cache = new Map();
  function memo(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.p;
    const p = fn();
    cache.set(key, { at: Date.now(), p });
    p.catch(() => cache.delete(key));
    return p;
  }
  const getTrending = () => memo('trending', 5 * 60e3, () => api('/api/trending').then((j) => {
    const r = (j.results || []).filter((x) => x.type === 'movie' || x.type === 'series');
    MacSearch.learn(r);
    return r;
  }));
  const getMeta = (type, id) => memo(`meta:${type}:${id}`, 30 * 60e3, () => api(`/api/metadata/${type}/${id}`));
  const getEpisodes = (id, season) => memo(`eps:${id}:${season}`, 30 * 60e3, () => api(`/api/metadata/series/${id}/episodes?season=${season}`).then((j) => j.episodes || []));
  const seasonList = (meta) => {
    const ec = meta && meta.episodeCounts;
    if (ec && typeof ec === 'object' && Object.keys(ec).length) {
      const keys = Object.keys(ec).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
      if (keys.length) return keys;
    }
    const n = (meta && meta.seasonCount) || 1;
    return Array.from({ length: n }, (_, i) => i + 1);
  };

  /* =====================================================================
   * Components
   * ===================================================================== */
  const hrefOf = (it) => `#/title/${it.type}/${it.id}`;

  function cardHTML(it) {
    const y = yearOf(it);
    const r = it.rating ? Number(it.rating).toFixed(1) : '';
    return `<a class="card" href="${hrefOf(it)}" aria-label="${esc(it.title)}${y ? ', ' + esc(y) : ''}">
      ${imgBox(it.poster, it.title)}
      <div class="card-over" aria-hidden="true">
        <span class="play-chip">${icon('play')}</span>
        <strong>${esc(it.title)}</strong>
        <span>${esc(y)}${y && r ? '<i class="dot" style="width:3px;height:3px;border-radius:50%;background:#777;display:inline-block"></i>' : ''}${r ? icon('star', '') .replace('class="ic fill', 'style="width:12px;height:12px" class="ic fill') + r : ''}</span>
      </div>
      <div class="card-cap"><strong>${esc(it.title)}</strong><span>${esc(y)}${r ? ' · ★ ' + r : ''}</span></div>
    </a>`;
  }

  function continueCardHTML(e) {
    const pct = e.duration ? clamp((e.positionSeconds / e.duration) * 100, 0, 100) : 0;
    const left = e.duration ? Math.max(0, Math.round((e.duration - e.positionSeconds) / 60)) : 0;
    const label = e.type === 'series' ? `S${e.season} · E${e.episode}${e.episodeName ? ' · ' + e.episodeName : ''}` : (yearOf(e) || 'Movie');
    const sub = e.positionSeconds < 5 && e.type === 'series' ? `Up next · ${label}` : (left ? `${left} min left · ${label}` : label);
    return `<article class="ccard" data-key="${esc(e.type)}:${esc(e.id)}">
      <button type="button" class="cc-main" data-resume="${esc(e.type)}:${esc(e.id)}" aria-label="Resume ${esc(e.title)}">
        ${imgBox((e.type === 'series' && e.still) || e.backdrop || e.poster, e.title).replace(/<\/div>$/, `<span class="cc-play">${icon('play')}</span><span class="bar"><i style="width:${pct}%"></i></span></div>`)}
        <span class="cc-text"><strong>${esc(e.title)}</strong><span>${esc(sub)}</span></span>
      </button>
      <button type="button" class="cc-x" data-remove="${esc(e.type)}:${esc(e.id)}" aria-label="Remove ${esc(e.title)} from Continue Watching">${icon('close')}</button>
    </article>`;
  }

  function railHTML(title, kicker, inner, cls) {
    return `<section class="rail ${cls || ''}" aria-label="${esc(title)}">
      <div class="rail-head"><h2>${esc(title)}</h2>${kicker ? `<small>${esc(kicker)}</small>` : ''}</div>
      <button class="rail-arrow prev" aria-label="Scroll ${esc(title)} left" hidden>${icon('chevL')}</button>
      <div class="scroller">${inner}</div>
      <button class="rail-arrow next" aria-label="Scroll ${esc(title)} right">${icon('chevR')}</button>
    </section>`;
  }
  function wireRails(root) {
    $$('.rail', root).forEach((rail) => {
      const sc = $('.scroller', rail), prev = $('.prev', rail), next = $('.next', rail);
      if (!sc || !prev || !next) return;
      const update = () => {
        prev.hidden = sc.scrollLeft < 12;
        next.hidden = sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 12;
      };
      sc.addEventListener('scroll', update, { passive: true });
      new ResizeObserver(update).observe(sc);
      prev.addEventListener('click', () => sc.scrollBy({ left: -sc.clientWidth * 0.85, behavior: reduceMotion() ? 'auto' : 'smooth' }));
      next.addEventListener('click', () => sc.scrollBy({ left: sc.clientWidth * 0.85, behavior: reduceMotion() ? 'auto' : 'smooth' }));
      update();
    });
  }

  const stateHTML = (title, text, action) => `<div class="state"><strong>${esc(title)}</strong><span>${esc(text)}</span>${action || ''}</div>`;
  const skelCards = (n, w) => Array.from({ length: n }, () => `<div class="skeleton" style="width:${w};aspect-ratio:2/3;flex:none"></div>`).join('');

  /* =====================================================================
   * Views
   * ===================================================================== */
  const view = $('#view');
  let routeToken = 0;
  let heroTimer = null;

  function setView(html) {
    view.innerHTML = html;
    view.classList.remove('view-enter');
    void view.offsetWidth;
    view.classList.add('view-enter');
    settleImages(view);
  }

  /* ----- Home ----- */
  async function renderHome(token) {
    setView(`
      <section class="hero" aria-label="Featured">
        <div class="hero-skel"><div class="skeleton" style="height:16px;width:120px"></div><div class="skeleton" style="height:84px"></div><div class="skeleton" style="height:14px;width:80%"></div><div class="skeleton" style="height:52px;width:200px"></div></div>
      </section>
      <div class="rails" id="rails">
        <section class="rail"><div class="rail-head"><h2>Trending now</h2></div><div class="scroller">${skelCards(8, 'clamp(128px,13.2vw,212px)')}</div></section>
      </div>`);
    let items;
    try { items = await getTrending(); } catch (err) {
      if (token !== routeToken) return;
      setView(`<div class="page-pad">${stateHTML('We couldn’t load Trending', health.ok === false ? 'The MacStream API appears to be offline.' : (err.message || 'Something went wrong.'), '<button class="btn btn-light" data-retry>Try again</button>')}</div>`);
      return;
    }
    if (token !== routeToken) return;

    const hero = $('.hero', view);
    const prog = Object.values(getAllProgress()).filter((e) => e.positionSeconds > 10 || (e.type === 'series' && e.positionSeconds < 5 && e.upNext)).sort((a, b) => b.updatedAt - a.updatedAt);
    const movies = items.filter((i) => i.type === 'movie');
    const series = items.filter((i) => i.type === 'series');
    const rails = [];
    if (prog.length) rails.push(railHTML('Continue watching', 'Pick up where you left off', prog.map(continueCardHTML).join(''), 'rail-continue'));
    rails.push(railHTML('Trending now', 'This week', items.slice(0, 12).map(cardHTML).join('')));
    if (movies.length > 2) rails.push(railHTML('Movies', 'Trending', movies.map(cardHTML).join('')));
    if (series.length > 2) rails.push(railHTML('Series', 'Trending', series.map(cardHTML).join('')));
    const railsEl = $('#rails', view);
    railsEl.innerHTML = rails.join('');
    wireRails(railsEl);
    settleImages(railsEl);
    backfillStills(prog, token);

    buildHero(hero, items.slice(0, 5), token);
  }

  /** Older saved entries have no episode still; fetch it once from the episodes endpoint and remember it. */
  function backfillStills(entries, token) {
    entries.filter((e) => e.type === 'series' && !e.still && e.season && e.episode).forEach(async (e) => {
      try {
        const eps = await getEpisodes(e.id, e.season);
        const ep = eps.find((x) => x.episode === e.episode);
        if (!ep || !ep.still) return;
        const cur = getProgress(e.type, e.id);
        if (cur && cur.season === e.season && cur.episode === e.episode) putProgress(Object.assign({}, cur, { still: ep.still }));
        if (token !== routeToken) return;
        const wrap = $(`.ccard[data-key="${e.type}:${e.id}"] .img-wrap`, view);
        if (!wrap) return;
        let img = $('img', wrap);
        if (!img) { img = document.createElement('img'); img.alt = ''; img.decoding = 'async'; wrap.insertBefore(img, wrap.firstChild); }
        wrap.classList.remove('failed'); img.classList.remove('loaded'); img.src = ep.still;
      } catch (_) { /* keep the show backdrop */ }
    });
  }

  function heroSlideHTML(meta, idx) {
    const t = meta.title;
    const prog = getProgress(meta.type, meta.tmdbId);
    const bits = [];
    if (meta.voteAverage) bits.push(`<span class="score">${icon('star')}${Number(meta.voteAverage).toFixed(1)}</span>`);
    const y = yearOf(meta); if (y) bits.push(`<span>${esc(y)}</span>`);
    if (meta.type === 'movie' && meta.runtime) bits.push(`<span>${esc(fmtRuntime(meta.runtime))}</span>`);
    if (meta.type === 'series' && meta.seasonCount) bits.push(`<span>${meta.seasonCount} Season${meta.seasonCount > 1 ? 's' : ''}</span>`);
    bits.push(`<span class="tag">${meta.type === 'series' ? 'Series' : 'Movie'}</span>`);
    const genres = (meta.genres || []).slice(0, 3).join(' · ');
    return `<div class="hero-slide" data-i="${idx}" aria-hidden="true">
      <div class="hero-art"><img src="${esc(meta.backdrop)}" alt="" ${idx === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"></div>
      <div class="hero-content">
        <span class="hero-kicker">${idx === 0 ? 'Featured tonight' : 'Trending'}${genres ? ' · ' + esc(genres) : ''}</span>
        <h1 class="${meta.logo ? '' : 'hero-title'}">${meta.logo ? `<img class="hero-logo" src="${esc(meta.logo)}" alt="${esc(t)}" data-title="${esc(t)}">` : esc(t)}</h1>
        <div class="meta-line">${bits.join('<i class="dot"></i>')}</div>
        <p class="hero-overview">${esc(meta.tagline && !meta.overview ? meta.tagline : meta.overview)}</p>
        <div class="hero-actions">
          <button class="btn btn-light" data-play="${esc(meta.type)}:${esc(meta.tmdbId)}">${icon('play')}${prog && prog.positionSeconds > 10 ? 'Continue' : 'Play'}</button>
          <a class="btn btn-dark" href="#/title/${esc(meta.type)}/${esc(meta.tmdbId)}">${icon('info')}More info</a>
        </div>
      </div>
    </div>`;
  }

  function buildHero(hero, items, token) {
    const slides = []; // sparse by index
    let active = -1;
    const dots = document.createElement('div');
    dots.className = 'hero-dots';
    let paused = false;

    function show(i) {
      active = i;
      $$('.hero-slide', hero).forEach((s) => {
        const on = Number(s.dataset.i) === i;
        s.classList.toggle('active', on);
        s.setAttribute('aria-hidden', on ? 'false' : 'true');
        $$('a,button', s).forEach((b) => { b.tabIndex = on ? 0 : -1; });
      });
      $$('button', dots).forEach((d) => d.setAttribute('aria-current', Number(d.dataset.i) === i ? 'true' : 'false'));
    }
    function order() { return slides.map((s, i) => (s ? i : -1)).filter((i) => i >= 0); }
    function next() {
      const o = order(); if (o.length < 2) return;
      show(o[(o.indexOf(active) + 1) % o.length]);
    }
    function addSlide(i, meta) {
      if (token !== routeToken || !meta || !meta.backdrop) return;
      meta.type = meta.type || items[i].type;
      slides[i] = true;
      const tmp = document.createElement('div');
      tmp.innerHTML = heroSlideHTML(meta, i);
      const el = tmp.firstElementChild;
      const sk = $('.hero-skel', hero); if (sk) sk.remove();
      // keep DOM order stable by index
      const after = $$('.hero-slide', hero).find((s) => Number(s.dataset.i) > i);
      hero.insertBefore(el, after || dots.parentNode === hero ? (after || dots) : null);
      if (!dots.parentNode) hero.appendChild(dots);
      const b = document.createElement('button');
      b.dataset.i = i; b.setAttribute('aria-label', `Show featured title ${i + 1}`);
      b.addEventListener('click', () => { show(i); resetTimer(); });
      const nb = $$('button', dots).find((x) => Number(x.dataset.i) > i);
      dots.insertBefore(b, nb || null);
      settleImages(el);
      if (active < 0) show(i); else show(active);
      dots.hidden = order().length < 2;
    }
    function resetTimer() {
      clearInterval(heroTimer);
      if (reduceMotion()) return;
      heroTimer = setInterval(() => { if (!paused && !document.hidden && $('#player').hidden !== false) next(); else if (!paused && !document.hidden && $('#player').dataset.mode === 'mini') next(); }, 9000);
    }
    hero.addEventListener('pointerenter', () => { paused = true; });
    hero.addEventListener('pointerleave', () => { paused = false; });
    hero.addEventListener('focusin', () => { paused = true; });
    hero.addEventListener('focusout', () => { paused = false; });

    items.forEach((it, i) => {
      getMeta(it.type, it.id).then((m) => addSlide(i, Object.assign({ type: it.type }, m))).catch(() => { });
    });
    Promise.allSettled(items.map((it) => getMeta(it.type, it.id))).then((rs) => {
      if (token !== routeToken) return;
      if (!$('.hero-slide', hero)) {
        // No backdrops at all: collapse the hero instead of leaving an empty slab.
        hero.style.cssText = 'height:calc(var(--nav-h) + 24px);min-height:0';
        hero.innerHTML = '';
        $('#rails').style.marginTop = '0';
      } else resetTimer();
    });
  }

  /* ----- Browse (filtered trending) / Search ----- */
  async function renderBrowse(type, token) {
    const label = type === 'movie' ? 'Movies' : 'Series';
    setView(`<div class="page-pad"><h1 class="page-title">${label}</h1><p class="page-sub">Trending ${label.toLowerCase()} right now</p><div class="grid">${skelCards(12, '100%')}</div></div>`);
    try {
      const items = (await getTrending()).filter((i) => i.type === type);
      if (token !== routeToken) return;
      $('.grid', view).outerHTML = items.length ? `<div class="grid">${items.map(cardHTML).join('')}</div>` : stateHTML(`No ${label.toLowerCase()} trending`, 'Try searching instead.');
      settleImages(view);
    } catch (err) {
      if (token !== routeToken) return;
      $('.grid', view).outerHTML = stateHTML('We couldn’t load this list', err.message || '', '<button class="btn btn-light" data-retry>Try again</button>');
    }
  }

  let searchCtrl = null;
  const fetchSearchRows = (q, signal) => api(`/api/search?q=${encodeURIComponent(q)}`, { signal, timeout: 15000 })
    .then((j) => (j.results || []).filter((i) => i.type === 'movie' || i.type === 'series'));

  async function renderSearch(q, token) {
    const input = $('#searchInput');
    if (input.value !== q) input.value = q;
    syncSearchClear();
    openSearch(true);
    if (searchCtrl) searchCtrl.abort();                       // cancel the previous query's requests
    if (!q.trim()) {
      searchCtrl = null;
      setView(`<div class="page-pad"><h1 class="page-title">Search</h1>${stateHTML('Find something to watch', 'Search any movie or series. Typos and missing spaces are fine.')}</div>`);
      return;
    }
    const ctrl = searchCtrl = new AbortController();
    setView(`<div class="page-pad"><h1 class="page-title">Results for “${esc(q.trim())}”</h1><p class="page-sub" id="searchSub">Searching…</p><div class="grid">${skelCards(12, '100%')}</div></div>`);
    // Seed "did you mean" with what we know: trending + the user's own history.
    try { await getTrending(); } catch (_) { /* search still works without it */ }
    Object.values(getAllProgress()).forEach((e) => MacSearch.learn([e.title]));
    if (ctrl.signal.aborted || token !== routeToken) return;
    try {
      const out = await MacSearch.search(q, fetchSearchRows, ctrl.signal);
      if (ctrl.signal.aborted || token !== routeToken) return;
      const n = out.results.length;
      const sub = $('#searchSub');
      if (n && out.corrected) sub.innerHTML = `Showing results for <strong>${esc(out.corrected)}</strong> <span class="dim">· you searched “${esc(q.trim())}”</span>`;
      else sub.textContent = n ? `${n} result${n > 1 ? 's' : ''}` : '';
      $('.grid', view).outerHTML = n ? `<div class="grid">${out.results.map(cardHTML).join('')}</div>` : noMatchHTML(q);
      settleImages(view);
      if (!n) fillSuggestions();
    } catch (err) {
      if (err.name === 'AbortError' || ctrl.signal.aborted || token !== routeToken) return;
      $('#searchSub').textContent = '';
      $('.grid', view).outerHTML = stateHTML('Search failed', health.ok === false ? 'The MacStream API appears to be offline.' : 'Something went wrong while searching.', '<button class="btn btn-light" data-retry>Try again</button>');
    }
  }

  function noMatchHTML(q) {
    return `<div class="state"><strong>No matches for “${esc(q.trim())}”</strong><span>Check the spelling, or try fewer words.</span><div class="chips" id="sugChips" aria-label="Popular right now"></div></div>`;
  }
  /** Suggestion chips use real trending titles already fetched; nothing is invented. */
  async function fillSuggestions() {
    const box = $('#sugChips'); if (!box) return;
    try {
      const items = (await getTrending()).slice(0, 5);
      if (!$('#sugChips')) return;
      box.innerHTML = items.map((i) => `<button type="button" class="chip" data-q="${esc(i.title)}">${esc(i.title)}</button>`).join('');
    } catch (_) { /* no chips */ }
  }
  view.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-q]');
    if (chip) { searchInput.value = chip.dataset.q; location.hash = `#/search?q=${encodeURIComponent(chip.dataset.q)}`; }
  });

  /* ----- Title detail ----- */
  async function renderTitle(type, id, token) {
    setView(`<section class="d-hero"><div class="d-info" style="width:min(560px,100%)"><div class="skeleton" style="height:70px"></div><div class="skeleton" style="height:14px;width:60%"></div><div class="skeleton" style="height:70px"></div><div class="skeleton" style="height:52px;width:200px"></div></div></section>`);
    let meta;
    try { meta = await getMeta(type, id); } catch (err) {
      if (token !== routeToken) return;
      setView(`<div class="page-pad">${stateHTML('We couldn’t load this title', health.ok === false ? 'The MacStream API appears to be offline.' : (err.message || ''), '<button class="btn btn-light" data-retry>Try again</button>')}</div>`);
      return;
    }
    if (token !== routeToken) return;
    meta.type = meta.type || type;
    const prog = getProgress(type, id);
    const resumable = prog && prog.positionSeconds > 10;
    const pct = prog && prog.duration ? clamp((prog.positionSeconds / prog.duration) * 100, 0, 100) : 0;
    const bits = [];
    if (meta.voteAverage) bits.push(`<span class="score">${icon('star')}${Number(meta.voteAverage).toFixed(1)}</span>`);
    const y = yearOf(meta); if (y) bits.push(`<span>${esc(y)}</span>`);
    if (type === 'movie' && meta.runtime) bits.push(`<span>${esc(fmtRuntime(meta.runtime))}</span>`);
    if (type === 'series' && meta.seasonCount) bits.push(`<span>${meta.seasonCount} Season${meta.seasonCount > 1 ? 's' : ''}</span>`);
    if (meta.status) bits.push(`<span class="tag">${esc(meta.status)}</span>`);
    const playLabel = type === 'series' ? (prog ? `Continue S${prog.season} · E${prog.episode}` : 'Play S1 · E1') : (resumable ? 'Continue' : 'Play');
    const art = meta.backdrop || meta.poster;
    const seasons = type === 'series' ? seasonList(meta) : [];
    const startSeason = prog && seasons.includes(prog.season) ? prog.season : (seasons[0] || 1);

    const facts = [
      ['Original title', meta.originalTitle && meta.originalTitle !== meta.title ? meta.originalTitle : ''],
      ['Release date', meta.releaseDate], ['Status', meta.status],
      ['Runtime', type === 'movie' ? fmtRuntime(meta.runtime) : ''],
      ['Genres', (meta.genres || []).join(', ')],
      ['Rating', meta.voteAverage ? `${Number(meta.voteAverage).toFixed(1)} / 10` : '']
    ].filter((f) => f[1]);

    setView(`
      <section class="d-hero">
        <div class="d-art">${art ? `<img src="${esc(art)}" alt="" fetchpriority="high">` : ''}</div>
        <div class="d-info">
          <h1 class="${meta.logo ? '' : 'hero-title'}">${meta.logo ? `<img class="hero-logo" src="${esc(meta.logo)}" alt="${esc(meta.title)}" data-title="${esc(meta.title)}">` : esc(meta.title)}</h1>
          <div class="meta-line">${bits.join('<i class="dot"></i>')}</div>
          ${(meta.genres || []).length ? `<p class="d-genres">${esc(meta.genres.slice(0, 4).join(' · '))}</p>` : ''}
          ${meta.tagline ? `<p class="d-tagline">${esc(meta.tagline)}</p>` : ''}
          <p class="d-overview">${esc(meta.overview || 'No synopsis available.')}</p>
          ${resumable ? `<div class="d-progress"><span class="bar"><i style="width:${pct}%"></i></span><span>${prog.duration ? Math.max(1, Math.round((prog.duration - prog.positionSeconds) / 60)) + ' min left' : fmtTime(prog.positionSeconds) + ' watched'}</span></div>` : ''}
          <div class="hero-actions">
            <button class="btn btn-light" data-play="${esc(type)}:${esc(id)}" ${type === 'series' && prog ? `data-season="${prog.season}" data-episode="${prog.episode}"` : ''}>${icon('play')}${esc(playLabel)}</button>
            ${resumable ? `<button class="btn btn-dark" data-play="${esc(type)}:${esc(id)}" data-restart="1" ${type === 'series' ? `data-season="${prog.season}" data-episode="${prog.episode}"` : ''}>${icon('restart')}Restart</button>` : ''}
          </div>
        </div>
      </section>
      <div class="d-body">
        ${type === 'series' ? `<div class="sec-head"><h2>Episodes</h2>
          <label class="select-wrap"><span class="sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Season</span>
          <select id="seasonSel" aria-label="Season">${seasons.map((s) => `<option value="${s}" ${s === startSeason ? 'selected' : ''}>Season ${s}</option>`).join('')}</select>${icon('chevSel')}</label></div>
          <div id="epList" aria-live="polite"></div>` : ''}
        ${facts.length ? `<div class="sec-head"><h2>Details</h2></div><dl class="facts">${facts.map((f) => `<div><dt>${esc(f[0])}</dt><dd>${esc(f[1])}</dd></div>`).join('')}</dl>` : ''}
      </div>`);
    document.title = `${meta.title} — MacStream`;

    if (type === 'series') {
      const sel = $('#seasonSel');
      const load = () => renderEpisodes(id, Number(sel.value), token);
      sel.addEventListener('change', load);
      load();
    }
  }

  async function renderEpisodes(id, season, token) {
    const box = $('#epList');
    if (!box) return;
    box.innerHTML = Array.from({ length: 5 }, () => '<div class="skeleton" style="height:88px;margin:10px 0"></div>').join('');
    try {
      const eps = await getEpisodes(id, season);
      if (token !== routeToken || !$('#epList')) return;
      const prog = getProgress('series', id);
      if (!eps.length) { box.innerHTML = stateHTML('No episodes listed', 'This season has no episode data yet.'); return; }
      box.innerHTML = eps.map((e) => {
        const cur = prog && prog.season === e.season && prog.episode === e.episode && prog.positionSeconds > 10;
        const pct = cur && prog.duration ? clamp((prog.positionSeconds / prog.duration) * 100, 0, 100) : 0;
        return `<button type="button" class="ep" data-play="series:${esc(id)}" data-season="${e.season}" data-episode="${e.episode}" aria-label="Play episode ${e.episode}: ${esc(e.name)}">
          <span class="n">${e.episode}</span>
          ${imgBox(e.still, `E${e.episode}`).replace('</div>', `<span class="ep-play"><span>${icon('play')}</span></span>${pct ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}</div>`)}
          <span class="t"><strong>${e.episode}. ${esc(e.name || 'Episode ' + e.episode)}</strong><p>${esc(e.overview || '')}</p></span>
          <span class="rt">${e.runtime ? esc(fmtRuntime(e.runtime)) : ''}</span>
        </button>`;
      }).join('');
      settleImages(box);
    } catch (err) {
      if (token !== routeToken || !$('#epList')) return;
      box.innerHTML = stateHTML('We couldn’t load episodes', err.message || '', '<button class="btn btn-light" data-retry>Try again</button>');
    }
  }

  /* =====================================================================
   * Router
   * ===================================================================== */
  function route(force) {
    routeToken++;
    const token = routeToken;
    clearInterval(heroTimer);
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = raw.split('?');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    let navKey = 'home';
    document.title = 'MacStream';
    if (!force) window.scrollTo(0, 0);

    if (parts[0] === 'title' && (parts[1] === 'movie' || parts[1] === 'series') && parts[2]) {
      navKey = parts[1]; renderTitle(parts[1], parts[2], token);
    } else if (parts[0] === 'search') {
      navKey = ''; renderSearch(new URLSearchParams(qs || '').get('q') || '', token);
    } else if (parts[0] === 'browse' && (parts[1] === 'movie' || parts[1] === 'series')) {
      navKey = parts[1]; renderBrowse(parts[1], token);
    } else {
      if (!searchActive()) openSearch(false);
      renderHome(token);
    }
    $$('.nav-links a').forEach((a) => { if (a.dataset.nav === navKey && navKey) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (parts[0] !== 'search' && parts[0] !== undefined) { $('#searchInput').value = ''; openSearch(false); }
  }

  /* ---------- search box ---------- */
  const searchForm = $('#searchForm'), searchInput = $('#searchInput');
  const searchActive = () => location.hash.startsWith('#/search');
  function openSearch(open) {
    searchForm.classList.toggle('open', open);
    $('#searchToggle').setAttribute('aria-expanded', String(open));
  }
  $('#searchToggle').addEventListener('click', () => {
    const open = !searchForm.classList.contains('open');
    openSearch(open);
    if (open) searchInput.focus();
  });
  let searchDebounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      const q = searchInput.value.trim();
      const target = q ? `#/search?q=${encodeURIComponent(q)}` : '#/';
      if (searchActive() && q) { history.replaceState(null, '', target); route(true); }
      else location.hash = target;
    }, 320);
  });
  searchForm.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(searchDebounce); const q = searchInput.value.trim(); if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`; });
  searchInput.addEventListener('blur', () => { if (!searchInput.value.trim() && !searchActive()) openSearch(false); });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (searchInput.value) { clearSearch(); } else searchInput.blur(); } });
  const searchClear = $('#searchClear');
  function syncSearchClear() { searchClear.hidden = !searchInput.value; }
  function clearSearch() { searchInput.value = ''; syncSearchClear(); searchInput.focus(); if (searchActive()) location.hash = '#/search'; }
  searchClear.addEventListener('click', clearSearch);
  searchInput.addEventListener('input', syncSearchClear);

  window.addEventListener('hashchange', () => route(false));
  window.addEventListener('scroll', () => $('#nav').classList.toggle('scrolled', window.scrollY > 24), { passive: true });

  /* ---------- delegated clicks in the view ---------- */
  view.addEventListener('click', (e) => {
    const retry = e.target.closest('[data-retry]');
    if (retry) { cache.clear(); health.check(); route(true); return; }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const [t, id] = rm.dataset.remove.split(':');
      dropProgress(t, id);
      const art = rm.closest('.ccard'), rail = rm.closest('.rail');
      art.remove();
      if (!$('.ccard', rail)) rail.remove();
      return;
    }
    const res = e.target.closest('[data-resume]');
    if (res) { const [t, id] = res.dataset.resume.split(':'); startPlayback({ type: t, id }); return; }
    const pl = e.target.closest('[data-play]');
    if (pl) {
      const [t, id] = pl.dataset.play.split(':');
      startPlayback({
        type: t, id,
        season: pl.dataset.season ? Number(pl.dataset.season) : undefined,
        episode: pl.dataset.episode ? Number(pl.dataset.episode) : undefined,
        restart: !!pl.dataset.restart
      });
    }
  });

  /* =====================================================================
   * Player controller
   * ===================================================================== */
  const playerEl = $('#player');
  const video = $('#video');
  const mp = new MacPlayer(video);
  const P = {}; // element refs
  ['pTitle', 'pSub', 'pSpinner', 'pBigPlay', 'pStatus', 'tCur', 'tRem', 'timeline', 'tlBuf', 'tlFill', 'tlThumb', 'tlTip',
    'cMute', 'cVol', 'cBack', 'cPlay', 'cFwd', 'cNext', 'cStreams', 'cMini', 'cPip', 'cFull', 'mPlay', 'mFill', 'mTitle',
    'stall', 'stallTitle', 'upnext', 'unStill', 'unKicker', 'unTitle', 'unAuto', 'unPlay', 'unPlayLabel', 'toast',
    'drawer', 'drawerSub', 'drawerNote', 'drawerList', 'drawerMore', 'trackSeg'].forEach((id) => { P[id] = document.getElementById(id); });

  /** state of the current playback session */
  let S = null;
  let genCounter = 0;
  let controlsTimer = null;
  let lastSave = 0;
  let toastTimer = null;
  let sse = null;

  /** Higher = better. Real labels from the API: 2160p, 1080p, 720p, bare 1080/480/360, "Auto", and "ORG". */
  const qualityRank = (q) => {
    if (q == null || q === '') return 0;
    const t = String(q).trim().toUpperCase();
    if (t === 'ORG' || t === 'ORIGINAL' || t === 'SOURCE' || t === 'REMUX') return 100;   // untouched source: last resort
    if (t === 'AUTO' || t === 'ADAPTIVE') return 900;                                      // adaptive: just under an explicit 1080p
    if (/4K|UHD/.test(t)) return 2160;
    const m = t.match(/(\d{3,4})\s*P?/);
    return m ? Number(m[1]) : 0;
  };
  /** Per row: Febbox labels its adaptive playlists quality "ORG" but titles them "AUTO"; treat those as adaptive. */
  const rowQuality = (s) => {
    const q = qualityRank(s.quality);
    if (q === 100 && /\bauto\b/i.test(`${s.name || ''} ${s.sourceTitle || ''}`) && /m3u8/i.test(`${s.container || ''} ${s.url || ''}`)) return 900;
    return q;
  };
  const isPlayable = (s) => s && s.url && s.playableInBrowser !== false && s.linkDead !== true;
  const containerOf = (s) => String(s.container || (/\.mkv/i.test(s.url) ? 'mkv' : /\.mp4/i.test(s.url) ? 'mp4' : /m3u8/i.test(s.url) ? 'm3u8' : '')).toLowerCase();
  /** language: the API often leaves `language` null and only says "[Hindi]" in the row name. */
  const rowLang = (s) => {
    const l = String(s.language || '').toLowerCase();
    if (l) return l;
    const m = `${s.name || ''} ${s.sourceTitle || ''}`.match(/\[([A-Za-z ]{2,20})\]/);
    if (!m) return '';
    const w = m[1].trim().toLowerCase();
    return w === 'english' ? 'en' : w === 'japanese' ? 'ja' : w;
  };
  const rowTrack = (s) => (s.track === 'sub' || s.track === 'dub') ? s.track : (rowLang(s) === 'ja' && s.provider === 'anime' ? 'sub' : (rowLang(s).startsWith('en') && s.provider === 'anime' ? 'dub' : ''));
  const isEnglishish = (s) => { const l = rowLang(s); return !l || l.startsWith('en'); };
  const streamScore = (s) => {
    const c = containerOf(s);
    const lang = rowLang(s), track = rowTrack(s);
    let sc = rowQuality(s) * 10 + (c === 'm3u8' ? 6 : c === 'mp4' ? 3 : 0);
    if (track) sc += track === prefs.animeTrack ? 300 : 0;                                   // anime: honour sub/dub choice
    else if (lang && !lang.startsWith('en') && lang !== 'ja') sc -= 20000;                   // other-language dub: only if nothing else
    else if (isEnglishish(s)) sc += 3;
    return sc;
  };

  /** Playable rows, best first. Used for the automatic pick and for startup failover. */
  function rankStreams(streams) {
    return streams.filter(isPlayable).sort((x, y) => streamScore(y) - streamScore(x));
  }
  const selectBest = (streams) => rankStreams(streams)[0] || null;
  function sortStreams(streams) {
    return streams.slice().sort((a, b) => {
      const pa = isPlayable(a) ? 1 : 0, pb = isPlayable(b) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const q = rowQuality(b) - rowQuality(a);
      if (q) return q;
      return streamScore(b) - streamScore(a) || String(a.provider).localeCompare(String(b.provider));
    });
  }

  function toast(msg, ms) {
    P.toast.textContent = msg; P.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { P.toast.hidden = true; }, ms || 2200);
  }
  function setSpinner(on) { P.pSpinner.hidden = !on; }

  /* Pre-playback loading screen: title artwork + honest progress, replacing the bare spinner. */
  const L = { el: $('#pLoader'), text: $('#pLoaderText'), sub: $('#pLoaderSub'), title: $('#pLoaderTitle'), img: $('#pLoaderImg'), bar: $('#pLoaderBar'), actions: $('#pLoaderActions') };
  function showLoader(o) {
    L.el.hidden = false;
    L.el.classList.toggle('is-error', !!o.error);
    L.text.textContent = o.text || '';
    L.sub.textContent = o.sub || '';
    L.actions.hidden = !o.actions;
    L.bar.hidden = !!o.error;
    P.pSpinner.classList.add('under-loader');
    if (o.error) setSpinner(false); else setSpinner(true);
    paintLoaderArt();
  }
  function hideLoader() { L.el.hidden = true; P.pSpinner.classList.remove('under-loader'); hideSkip(); }
  function paintLoaderArt() {
    if (!S) return;
    L.title.textContent = S.title || '';
    const art = S.backdrop || S.poster || '';
    if (art && L.img.dataset.src !== art) { L.img.dataset.src = art; L.img.src = art; L.img.hidden = false; }
    else if (!art) L.img.hidden = true;
  }
  function updateLoaderProgress() {
    if (!S || L.el.hidden || S.started || L.el.classList.contains('is-error')) return;
    const st = Object.values(S.providerStatus || {});
    const done = st.filter((v) => v !== 'pending').length;
    const n = S.streams.filter(isPlayable).length;
    L.sub.textContent = st.length ? `${done} of ${st.length} sources checked${n ? ` · ${n} ready` : ''}` : '';
  }

  /* ---------- picture-in-picture (a real floating window over other apps) ---------- */
  // The in-page "mini player" only lives inside this tab. Native PiP hands the video to the OS as an
  // always-on-top window, so it keeps playing over other apps and screens -- the behaviour of a normal
  // player app. In-page mini stays as the fallback when PiP is unavailable.
  const pip = {
    get active() {
      return document.pictureInPictureElement === video
        || video.webkitPresentationMode === 'picture-in-picture';
    },
    get supported() {
      return (typeof video.requestPictureInPicture === 'function' && document.pictureInPictureEnabled !== false)
        || typeof video.webkitSetPresentationMode === 'function';
    },
    async enter(quiet) {
      if (!S || this.active) return false;
      const say = (m) => { if (!quiet) toast(m); };
      if (!this.supported) { say('Picture-in-Picture isn’t supported in this browser'); return false; }
      if (video.readyState < 2) { say('Video isn’t ready yet — try again in a moment'); return false; }
      try {
        if (typeof video.requestPictureInPicture === 'function' && document.pictureInPictureEnabled !== false) {
          await video.requestPictureInPicture();
        } else {
          video.webkitSetPresentationMode('picture-in-picture');
        }
        return true;
      } catch (e) {
        if (e && e.name === 'NotAllowedError') say('Play the video first, then open Picture-in-Picture');
        else if (e && e.name === 'NotSupportedError') say('This stream can’t float in Picture-in-Picture');
        else say('Picture-in-Picture unavailable');
        return false;
      }
    },
    async exit() {
      try {
        if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
        else if (typeof video.webkitSetPresentationMode === 'function' && video.webkitPresentationMode === 'picture-in-picture') video.webkitSetPresentationMode('inline');
      } catch (_) { /* ignore */ }
    },
    async toggle() { if (this.active) await this.exit(); else await this.enter(); }
  };

  /* ---------- opening / closing ---------- */
  function setMode(mode) {
    const prev = playerEl.dataset.mode;
    playerEl.dataset.mode = mode;
    document.body.classList.toggle('player-full', mode === 'full' && !playerEl.hidden);
    if (mode === 'mini' && document.fullscreenElement) document.exitFullscreen().catch(() => { });
    if (mode === 'full') { pip.exit(); bumpControls(); }
    else if (mode === 'mini' && prev !== 'mini') pip.enter(true);      // quiet: falls back to the in-page mini player
  }

  async function startPlayback(opts) {
    const type = opts.type, id = String(opts.id);
    // Tear down whatever was playing, saving its position first.
    if (S) { saveNow(true); abortStreams(); clearTimeout(S.startTimer); clearTimeout(S.animeTimer); }
    const gen = ++genCounter;

    // Resolve what to play (episode + resume position).
    const saved = getProgress(type, id);
    let season = opts.season, episode = opts.episode;
    if (type === 'series' && (season == null || episode == null)) {
      season = saved ? saved.season : 1; episode = saved ? saved.episode : 1;
    }
    let startAt = 0;
    const same = saved && (type === 'movie' || (saved.season === season && saved.episode === episode));
    if (!opts.restart && same && saved.positionSeconds > 10 && (!saved.duration || saved.positionSeconds < saved.duration - 45)) startAt = saved.positionSeconds;

    S = {
      gen, type, id, season, episode, startAt,
      title: (saved && saved.title) || '', poster: saved && saved.poster, backdrop: saved && saved.backdrop,
      episodeName: '', streams: [], payload: null, providerStatus: {}, activeUrl: null, started: false,
      next: null, upnextDismissed: false, earlyTimer: null, finished: false, meta: null,
      hasPlayed: false, autoPicked: false, userPicked: false, tried: new Set(), failovers: 0,
      recoveries: [], recovering: false, fatalPending: false, pausedAt: 0, startTimer: null,
      extra: [], animeWait: false, animeSettled: false, skipAnime: false, animeTimer: null, metaP: null
    };

    caps.reset({ clearFiles: true }); closeCapMenu();
    playerEl.hidden = false;
    playerEl.tabIndex = -1;
    setMode('full');
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    playerEl.focus({ preventScroll: true });
    setIcon(P.cPlay, 'pause'); setIcon(P.mPlay, 'pause');
    P.cNext.hidden = true;
    P.stall.hidden = true; P.upnext.hidden = true; P.pBigPlay.hidden = true;
    closeDrawer();
    showLoader({ text: 'Loading', sub: '' });
    updateTitleUI();
    updateTimeUI();
    video.volume = prefs.volume; video.muted = prefs.muted; syncVolumeUI();
    bumpControls();

    // Metadata for the title (don't block streams on it).
    S.metaP = getMeta(type, id).then((m) => {
      if (!S || S.gen !== gen) return;
      S.meta = m; S.title = m.title || S.title; S.poster = m.poster || S.poster; S.backdrop = m.backdrop || S.backdrop; S.year = yearOf(m);
      updateTitleUI(); paintLoaderArt();
      if (m.isAnime) startAnimeFetch(gen);
    }).catch(() => { });
    if (type === 'series') loadEpisodeContext(gen);

    openStreams(gen);
  }

  async function loadEpisodeContext(gen) {
    try {
      const eps = await getEpisodes(S.id, S.season);
      if (!S || S.gen !== gen) return;
      const cur = eps.find((e) => e.episode === S.episode);
      if (cur) { S.episodeName = cur.name || ''; S.episodeStill = cur.still; S.runtime = cur.runtime; }
      updateTitleUI();
      let next = eps.find((e) => e.season === S.season && e.episode > S.episode);
      if (!next) {
        const meta = S.meta || await getMeta(S.type, S.id).catch(() => null);
        const seasons = meta ? seasonList(meta) : [];
        const ns = seasons.find((s) => s > S.season);
        if (ns) { const e2 = await getEpisodes(S.id, ns).catch(() => []); next = e2[0]; }
      }
      if (!S || S.gen !== gen) return;
      if (next) { S.next = { season: next.season, episode: next.episode, name: next.name, still: next.still }; P.cNext.hidden = false; }
    } catch (_) { /* up-next simply won't be offered */ }
  }

  function updateTitleUI() {
    if (!S) return;
    P.pTitle.textContent = S.title || 'Loading…';
    P.pSub.textContent = S.type === 'series' ? `Season ${S.season} · Episode ${S.episode}${S.episodeName ? ' — ' + S.episodeName : ''}` : (S.year || '');
    P.pSub.hidden = !P.pSub.textContent;
    P.mTitle.textContent = S.title + (S.type === 'series' ? ` · S${S.season}E${S.episode}` : '');
    if (S.title) document.title = `${S.title} — MacStream`;
  }

  function stopPlayback() {
    if (!S) return;
    saveNow(true);
    abortStreams();
    clearTimeout(S.startTimer); clearTimeout(S.animeTimer);
    mp.stop(); hideLoader(); pip.exit();
    caps.reset({ clearFiles: true }); closeCapMenu();
    S = null; genCounter++;
    playerEl.hidden = true;
    document.body.classList.remove('player-full');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    closeDrawer();
    document.title = 'MacStream';
    // Refresh Continue Watching if we're looking at it.
    if (!location.hash || location.hash === '#/') route(true);
    else if (location.hash.startsWith('#/title/')) route(true);
  }

  /* ---------- streams (SSE first, polling fallback) ---------- */
  function abortStreams() {
    if (sse) { sse.close(); sse = null; }
    if (S && S.earlyTimer) { clearTimeout(S.earlyTimer); S.earlyTimer = null; }
  }
  const epQuery = () => (S.type === 'series' ? `?season=${S.season}&episode=${S.episode}` : '');

  function normalizeRows(payload) {
    let rows = [];
    if (Array.isArray(payload)) rows = payload;
    else if (payload && Array.isArray(payload.streams)) rows = payload.streams;
    else if (payload && payload.url) rows = [payload];
    return rows.filter((r) => r && r.url);
  }

  function openStreams(gen) {
    const base = `${API}/api/streams/${S.type}/${S.id}`;
    let finished = false;
    let fallbackWatch = null;
    const cleanup = () => { clearTimeout(fallbackWatch); if (sse) { sse.close(); sse = null; } };
    const fail = (reason) => {
      if (!S || S.gen !== gen || finished) return;
      finished = true; cleanup();
      pollStreams(gen, reason);
    };
    try { sse = new EventSource(`${base}/live${epQuery()}`); } catch (_) { pollStreams(gen); return; }
    const parse = (e) => { try { return JSON.parse(e.data); } catch (_) { return null; } };
    sse.addEventListener('status', (e) => {
      if (!S || S.gen !== gen) return;
      const d = parse(e); if (!d) return;
      if (d.provider && d.status) S.providerStatus[d.provider] = d.status;
      else if (d.providerStatus) Object.assign(S.providerStatus, d.providerStatus);
      renderDrawer();
    });
    sse.addEventListener('stream', (e) => {
      if (!S || S.gen !== gen) return;
      const rows = normalizeRows(parse(e));
      mergeRows(rows);
      renderDrawer();
      // Fast first frame: if something clearly playable arrives early, start in ~1.5s (a better row may still land).
      if (!S.started && !S.earlyTimer && rows.some((r) => isPlayable(r) && ['m3u8', 'mp4'].includes(String(r.container || '').toLowerCase()))) {
        // Only rush when a high-quality row is already in; otherwise give better sources a few seconds to land.
        const top = selectBest(S.streams);
        const fast = top && qualityRank(top.quality) >= 1080 && qualityRank(top.quality) !== 100;
        S.earlyTimer = setTimeout(() => { S && S.gen === gen && !S.started && autoPick(); }, fast ? 1500 : 6000);
      }
    });
    sse.addEventListener('done', (e) => {
      if (!S || S.gen !== gen || finished) return;
      const d = parse(e); finished = true; cleanup();
      if (d) ingestFinal(d, gen); else pollStreams(gen);
    });
    sse.addEventListener('error', () => fail('sse'));
    fallbackWatch = setTimeout(() => fail('timeout'), 40000);
  }

  async function pollStreams(gen, why) {
    try {
      const d = await api(`/api/streams/${S.type}/${S.id}${epQuery()}`, { timeout: 45000 });
      if (!S || S.gen !== gen) return;
      ingestFinal(d, gen);
    } catch (err) {
      if (!S || S.gen !== gen) return;
      showLoader({ error: true, text: health.ok === false ? 'Can’t reach the MacStream API' : 'Couldn’t load streams', sub: health.ok === false ? 'Check that the API is running, then try again.' : 'Something went wrong while looking for sources.', actions: true });
      P.drawerSub.textContent = 'Couldn’t load streams';
    }
  }

  /* ---- anime: the combined route often leaves before the (slow, ~20s+) anime provider answers ---- */
  const ANIME_MAX_WAIT_MS = 30000;
  function startAnimeFetch(gen) {
    if (!S || S.gen !== gen || S.animeWait || S.animeSettled) return;
    S.animeWait = true;
    const done = () => {
      if (!S || S.gen !== gen || S.animeSettled) return;
      S.animeSettled = true; S.animeWait = false; clearTimeout(S.animeTimer);
      renderDrawer(); hideSkip();
      if (!S.started && (S.payload || S.streams.length)) autoPick();
      else if (S.started) { const n = S.extra.length; if (n) toast(`${n} anime source${n > 1 ? 's' : ''} found — open Streams to switch`, 3500); }
    };
    S.animeTimer = setTimeout(done, ANIME_MAX_WAIT_MS);
    api(`/api/streams/anime/${S.type}/${S.id}${epQuery()}`, { timeout: ANIME_MAX_WAIT_MS + 5000 })
      .then((d) => { if (!S || S.gen !== gen) return; S.extra = normalizeRows(d); mergeRows(S.extra); })
      .catch(() => { })
      .then(done);
  }
  const skipBtn = $('#pLoaderSkip');
  function showSkip() { if (skipBtn) skipBtn.hidden = false; }
  function hideSkip() { if (skipBtn) skipBtn.hidden = true; }
  if (skipBtn) skipBtn.addEventListener('click', () => { if (!S) return; S.skipAnime = true; hideSkip(); autoPick(); });

  function mergeRows(rows) {
    const have = new Set(S.streams.map((s) => s.url));
    rows.forEach((r) => { if (!have.has(r.url)) { S.streams.push(r); have.add(r.url); } });
  }

  function ingestFinal(payload, gen) {
    if (!S || S.gen !== gen) return;
    S.payload = payload;
    if (payload.providerStatus) S.providerStatus = payload.providerStatus;
    // The `done` frame supersedes everything received early.
    const rows = normalizeRows(payload);
    S.streams = rows;
    mergeRows(S.extra);
    renderDrawer();
    if (!S.started) autoPick();
  }

  async function autoPick() {
    if (!S) return;
    const gen = S.gen;
    clearTimeout(S.earlyTimer); S.earlyTimer = null;
    // Anime titles: give the anime provider time to answer before choosing (it is slow, ~20s).
    if (S.metaP && !S.meta) { try { await Promise.race([S.metaP, new Promise((r) => setTimeout(r, 2500))]); } catch (_) { /* ignore */ } if (!S || S.gen !== gen || S.started) return; }
    if (S.animeWait && !S.animeSettled && !S.skipAnime) {
      showLoader({ text: 'Checking anime sources', sub: 'Anime sources can take up to 30 seconds' });
      if (S.streams.some(isPlayable)) showSkip();
      return;
    }
    const best = selectBest(S.streams);
    if (!best) {
      const only = S.streams.length;
      showLoader({ error: true, text: only ? 'Nothing here can play in a browser' : 'No streams found yet', sub: only ? 'Every source is MKV/HEVC, which browsers can’t decode. Open Streams to see them.' : 'Try again in a moment, or wait for slower providers.', actions: true });
      if (only) openDrawer();
      return;
    }
    S.autoUrl = best.url;
    activate(best, { startAt: S.startAt, autoplay: true, auto: true });
  }

  const STARTUP_TIMEOUT_MS = 25000;
  function activate(stream, o) {
    clearTimeout(S.startTimer);
    S.activeUrl = stream.url; S.started = true; S.upnextDismissed = false;
    hideSkip();
    S.activeStream = stream; S.tried.add(stream.url);
    S.autoPicked = !!o.auto; S.userPicked = !!o.manual;
    P.pBigPlay.hidden = true; P.stall.hidden = true;
    if (!S.hasPlayed) showLoader({ text: 'Starting playback', sub: `${stream.quality && String(stream.quality).toUpperCase() !== 'AUTO' ? stream.quality + ' · ' : ''}${stream.provider || ''}`.replace(/ · $/, '') });
    else setSpinner(true);
    caps.reset();
    caps.setExternal(MacCaptions.extractSubtitles(stream, S.payload, S.streams));
    mp.load(stream.url, { startAt: o.startAt || 0, autoplay: o.autoplay !== false, hls: containerOf(stream) === 'm3u8' ? true : containerOf(stream) === 'mp4' ? false : undefined });
    // A source that never produces a first frame is treated like a failed one (startup failover only).
    if (o.auto && !S.hasPlayed) { const gen = S.gen; S.startTimer = setTimeout(() => { if (S && S.gen === gen && !S.hasPlayed) failoverNext('timeout'); }, STARTUP_TIMEOUT_MS); }
    renderDrawer();
  }

  /** Before the first frame only: quietly try the next-best source. Never runs once playback has begun. */
  function failoverNext(reason) {
    if (!S || S.hasPlayed) return;
    clearTimeout(S.startTimer);
    const next = rankStreams(S.streams).find((r) => !S.tried.has(r.url));
    if (!next || S.failovers >= 6) {
      showLoader({ error: true, text: 'We couldn’t start any source', sub: 'Open Streams to pick one manually, or try again.', actions: true });
      openDrawer();
      return;
    }
    S.failovers++;
    showLoader({ text: 'That source didn’t respond', sub: `Trying another (${S.failovers}/6)…` });
    activate(next, { startAt: S.startAt, autoplay: true, auto: true });
  }

  /* ---- keep playing when links expire (long pause, tab asleep, network blip) ---- */
  const streamKey = (s) => [s.provider, s.quality, containerOf(s), s.sourceTitle || s.name || ''].join('|');
  function matchStream(rows, prev) {
    const ok = rows.filter(isPlayable);
    return ok.find((r) => streamKey(r) === streamKey(prev))
      || ok.find((r) => r.provider === prev.provider && String(r.quality) === String(prev.quality) && containerOf(r) === containerOf(prev))
      || null;
  }
  /** Re-fetch fresh links and reload the SAME source (same provider/quality) at the current position. */
  async function refreshActiveSource(reason) {
    if (!S || S.recovering || !S.activeStream) return false;
    const now = Date.now();
    S.recoveries = S.recoveries.filter((t) => now - t < 120000);
    if (S.recoveries.length >= 3) return false;                       // don't loop forever
    S.recoveries.push(now);
    S.recovering = true;
    const gen = S.gen, prev = S.activeStream;
    const pos = video.currentTime || S.startAt || 0, wasPaused = video.paused;
    setSpinner(true); toast('Reconnecting…', 4000);
    try {
      const isAnimeRow = prev.provider === 'anime';
      const d = await api(isAnimeRow ? `/api/streams/anime/${S.type}/${S.id}${epQuery()}` : `/api/streams/${S.type}/${S.id}${epQuery()}`, { timeout: 60000 });
      if (!S || S.gen !== gen) return true;
      const rows = normalizeRows(d);
      const match = matchStream(rows, prev);
      if (isAnimeRow) { S.extra = rows; S.streams = S.streams.filter((r) => r.provider !== 'anime'); mergeRows(rows); }
      else { S.payload = d; if (d.providerStatus) S.providerStatus = d.providerStatus; S.streams = rows; mergeRows(S.extra); }
      renderDrawer();
      if (!match) return false;
      S.startAt = pos; S.fatalPending = false;
      activate(match, { startAt: pos, autoplay: !wasPaused, manual: S.userPicked, auto: false });
      return true;
    } catch (_) {
      return false;
    } finally {
      if (S && S.gen === gen) S.recovering = false;
    }
  }
  async function handleFatal(info) {
    if (!S || !S.started) return;
    if (!S.hasPlayed) {
      if (S.autoPicked) return failoverNext(info && info.reason);       // startup: fall through to the next candidate
      offerSwitch('This stream couldn’t start'); return;                // user chose it: offer, never override
    }
    S.fatalPending = true;
    const ok = await refreshActiveSource(info && info.reason);
    if (!ok && S) { S.fatalPending = true; offerSwitch('This stream stopped working'); }
  }

  /** Manual override: switch source and keep the current position. */
  function switchStream(stream) {
    if (!S || stream.url === S.activeUrl) return;
    const pos = video.currentTime || 0;
    const wasPaused = video.paused;
    S.startAt = pos;
    activate(stream, { startAt: pos, autoplay: !wasPaused, manual: true });
    toast(`Switched to ${stream.provider || 'stream'} · ${stream.quality || ''}`.trim());
  }

  /* ---------- streams drawer ---------- */
  function openDrawer() { closeCapMenu(); P.drawer.classList.add('open'); P.drawer.setAttribute('aria-hidden', 'false'); P.stall.hidden = true; renderDrawer(); bumpControls(); setTimeout(() => { const a = $('.stream.active', P.drawer) || $('.stream:not([aria-disabled="true"])', P.drawer) || $('#drawerClose'); a && a.focus({ preventScroll: true }); }, 380); }
  function closeDrawer() { P.drawer.classList.remove('open'); P.drawer.setAttribute('aria-hidden', 'true'); }
  const drawerOpen = () => P.drawer.classList.contains('open');

  function renderDrawer() {
    if (!S) return;
    const list = sortStreams(S.streams);
    const st = S.providerStatus || {};
    const vals = Object.values(st);
    const pending = vals.filter((v) => v === 'pending').length;
    const ok = vals.filter((v) => v === 'ok').length;
    updateLoaderProgress();
    if (S.payload || list.length) {
      P.drawerSub.textContent = `${list.length} source${list.length === 1 ? '' : 's'}${vals.length ? ` · ${ok} of ${vals.length} providers` : ''}${S.payload ? '' : ' · still searching…'}`;
    }
    const hasTracks = S.streams.some((r) => rowTrack(r));
    P.trackSeg.hidden = !hasTracks;
    P.trackSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.track === prefs.animeTrack)));
    P.drawerMore.hidden = !(S.payload && pending > 0);
    if (!P.drawerMore.hidden && !P.drawerMore.disabled) P.drawerMore.textContent = `Wait for slower providers (${pending})`;
    if (!list.length) {
      P.drawerList.innerHTML = S.payload ? '<li class="empty-streams">No streams were found for this title.</li>' : '<li class="stream-skel skeleton"></li><li class="stream-skel skeleton"></li><li class="stream-skel skeleton"></li>';
      return;
    }
    P.drawerList.innerHTML = list.map((s, i) => {
      const playable = isPlayable(s), c = containerOf(s);
      const active = s.url === S.activeUrl;
      const badges = [];
      if (active) badges.push('<span class="badge hi">Playing</span>');
      else if (s.url === S.autoUrl) badges.push('<span class="badge hi">Auto pick</span>');
      if (c) badges.push(`<span class="badge">${esc(c)}</span>`);
      if (s.size && !/n\/a/i.test(s.size)) badges.push(`<span class="badge">${esc(s.size)}</span>`);
      if (s.languageLabel || s.language) badges.push(`<span class="badge">${esc(s.languageLabel || s.language)}</span>`);
      if (s.linkDead) badges.push('<span class="badge warn">Dead link</span>');
      else if (s.playableInBrowser === false) badges.push(`<span class="badge warn">${esc((c || 'This format').toUpperCase())} · not playable in browser</span>`);
      return `<li><button type="button" class="stream ${active ? 'active' : ''}" data-i="${i}" ${playable ? '' : 'aria-disabled="true"'} ${active ? 'aria-current="true"' : ''} aria-label="${esc((s.provider || 'Stream') + ', ' + (s.quality || 'unknown quality') + (playable ? '' : ', not playable in browser'))}">
        <span class="q">${esc(s.quality || '—')}</span>
        <span class="s-main"><strong>${esc(s.provider || 'Unknown provider')}</strong><small>${esc(s.sourceTitle || s.title || s.name || '')}</small><span class="badges">${badges.join('')}</span></span>
      </button></li>`;
    }).join('');
    P.drawerList._sorted = list;
  }

  P.drawerList.addEventListener('click', (e) => {
    const b = e.target.closest('.stream'); if (!b || !S) return;
    const s = (P.drawerList._sorted || [])[Number(b.dataset.i)];
    if (!s) return;
    if (!isPlayable(s)) { toast(s.linkDead ? 'That link is dead.' : 'This format can’t play in a browser.'); return; }
    switchStream(s);
  });
  P.trackSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-track]'); if (!b || !S) return;
    prefs.animeTrack = b.dataset.track; savePrefs();
    renderDrawer();
    toast(prefs.animeTrack === 'dub' ? 'Anime audio: English dub' : 'Anime audio: Japanese with subtitles');
  });

  /** Start the source search over (used by the loader's "Try again"). */
  function retryStreams() {
    if (!S) return;
    abortStreams();
    clearTimeout(S.startTimer);
    S.started = false; S.hasPlayed = false; S.streams = []; S.payload = null; S.providerStatus = {};
    S.tried = new Set(); S.failovers = 0; S.activeUrl = null; S.autoUrl = null;
    clearTimeout(S.animeTimer); S.extra = []; S.animeWait = false; S.animeSettled = false; S.skipAnime = false; hideSkip();
    if (S.meta && S.meta.isAnime) startAnimeFetch(S.gen);
    mp.stop();
    closeDrawer();
    showLoader({ text: 'Loading', sub: '' });
    renderDrawer();
    openStreams(S.gen);
  }
  $('#pLoaderRetry').addEventListener('click', retryStreams);
  $('#pLoaderStreams').addEventListener('click', openDrawer);
  P.drawerMore.addEventListener('click', async () => {
    if (!S) return;
    const gen = S.gen; P.drawerMore.disabled = true; P.drawerMore.textContent = 'Waiting for providers…';
    try {
      const d = await api(`/api/streams/${S.type}/${S.id}${epQuery()}${epQuery() ? '&' : '?'}deadline=45000`, { timeout: 60000 });
      if (!S || S.gen !== gen) return;
      const before = S.streams.length;
      S.payload = d; if (d.providerStatus) S.providerStatus = d.providerStatus;
      mergeRows(normalizeRows(d));
      toast(S.streams.length > before ? `${S.streams.length - before} more source${S.streams.length - before > 1 ? 's' : ''} found` : 'No additional sources');
    } catch (_) { toast('Couldn’t reach slower providers'); }
    P.drawerMore.disabled = false; renderDrawer();
  });
  $('#drawerClose').addEventListener('click', closeDrawer);
  P.cStreams.addEventListener('click', () => (drawerOpen() ? closeDrawer() : openDrawer()));

  /* ---------- subtitles ---------- */
  const caps = new MacCaptions({
    video, overlay: $('#captions'), apiBase: API, getHls: () => mp.hls,
    getPrefs: () => prefs, savePrefs,
    onChange: () => renderCapMenu(),
    onError: (e, err) => toast(err && err.message ? err.message : 'Couldn’t load those subtitles')
  });
  mp.on('subtitletracks', () => caps.refresh());
  const capMenu = $('#capMenu');
  const capOpen = () => !capMenu.hidden;
  function openCapMenu() { closeDrawer(); P.stall.hidden = true; capMenu.hidden = false; $('#cCaptions').setAttribute('aria-expanded', 'true'); renderCapMenu(); bumpControls(); const a = $('.cap-item[aria-checked="true"]', capMenu) || $('.cap-item', capMenu); a && a.focus({ preventScroll: true }); }
  function closeCapMenu() { capMenu.hidden = true; $('#cCaptions').setAttribute('aria-expanded', 'false'); }
  function renderCapMenu() {
    const list = caps.entries(), act = caps.active;
    $('#cCaptions').classList.toggle('on', !!act);
    $('#cCaptions').setAttribute('aria-pressed', act ? 'true' : 'false');
    $('#capEmpty').hidden = list.length > 0;
    const rows = [`<button type="button" class="cap-item" role="menuitemradio" aria-checked="${act ? 'false' : 'true'}" data-id="">Off</button>`]
      .concat(list.map((e) => `<button type="button" class="cap-item" role="menuitemradio" aria-checked="${act && act.id === e.id ? 'true' : 'false'}" data-id="${esc(e.id)}">${esc(e.label)}${e.lang && e.label.toLowerCase() !== e.lang ? `<small>${esc(e.lang.toUpperCase())}</small>` : ''}${e.loading ? '<small>Loading…</small>' : ''}${e.kind === 'file' ? '<small>Your file</small>' : ''}</button>`));
    $('#capList').innerHTML = rows.join('');
    const syncable = act && (act.kind === 'ext' || act.kind === 'file');
    $('#capSync').hidden = !syncable;
    $('#capOffset').textContent = `${caps.offset > 0 ? '+' : ''}${caps.offset.toFixed(1)}s`;
  }
  $('#cCaptions').addEventListener('click', () => (capOpen() ? closeCapMenu() : openCapMenu()));
  $('#capClose').addEventListener('click', closeCapMenu);
  $('#capList').addEventListener('click', async (e) => {
    const b = e.target.closest('.cap-item'); if (!b) return;
    await caps.select(b.dataset.id || null);
    renderCapMenu();
  });
  $('#capAdd').addEventListener('click', () => $('#capFile').click());
  $('#capFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { await caps.addFile(f); toast('Subtitles added'); } catch (_) { toast('Couldn’t read that file'); }
    renderCapMenu();
  });
  $('#capEarlier').addEventListener('click', () => caps.setOffset(caps.offset - 0.5));
  $('#capLater').addEventListener('click', () => caps.setOffset(caps.offset + 0.5));
  function toggleCaptions() {
    if (!S) return;
    if (caps.active) { caps.select(null); toast('Subtitles off'); return; }
    const all = caps.entries();
    if (!all.length) { openCapMenu(); return; }
    const want = (prefs.captionLang || 'en').toLowerCase();
    const pick = all.find((x) => x.lang && x.lang.startsWith(want)) || all.find((x) => /^en/.test(x.lang)) || all[0];
    caps.select(pick.id).then(() => toast(`Subtitles: ${pick.label}`));
  }

  /* ---------- stall offers (offer, never auto-switch) ---------- */
  function offerSwitch(title) {
    if (!S || playerEl.dataset.mode === 'mini' && false) return;
    P.stallTitle.textContent = title;
    P.stall.hidden = false;
    setSpinner(false);
    bumpControls();
  }
  mp.on('stall', () => offerSwitch('Playback looks stuck'));
  mp.on('fatal', (info) => handleFatal(info));
  mp.on('stallclear', () => { P.stall.hidden = true; });
  mp.on('blocked', () => { setSpinner(false); P.pBigPlay.hidden = false; });
  $('#stallDismiss').addEventListener('click', () => { mp.dismissOffer(); P.stall.hidden = true; });
  $('#stallSwitch').addEventListener('click', () => { P.stall.hidden = true; openDrawer(); });

  /* ---------- video events ---------- */
  const on = (ev, fn) => video.addEventListener(ev, fn);
  on('loadstart', () => { if (S) setSpinner(true); });
  on('waiting', () => { if (S) setSpinner(true); });
  on('seeking', () => { if (S && !video.paused) setSpinner(true); });
  on('canplay', () => { if (S && !video.paused) setSpinner(false); });
  on('playing', () => { setSpinner(false); hideLoader(); if (S) { S.hasPlayed = true; S.fatalPending = false; S.pausedAt = 0; clearTimeout(S.startTimer); } P.pBigPlay.hidden = true; setIcon(P.cPlay, 'pause'); setIcon(P.mPlay, 'pause'); bumpControls(); });
  on('pause', () => { if (S && !S.pausedAt && S.hasPlayed) S.pausedAt = Date.now(); setIcon(P.cPlay, 'play'); setIcon(P.mPlay, 'play'); bumpControls(); });
  const STALE_AFTER_MS = 20 * 60 * 1000;
  on('play', () => {
    setIcon(P.cPlay, 'pause'); setIcon(P.mPlay, 'pause');
    if (S && S.hasPlayed && S.pausedAt && Date.now() - S.pausedAt > STALE_AFTER_MS) refreshActiveSource('stale');
    if (S) S.pausedAt = 0;
  });
  // Waking the tab or regaining the network: retry anything that failed while we were away.
  function wake() {
    if (!S || !S.hasPlayed) return;
    if (S.fatalPending) { S.recoveries = []; refreshActiveSource('wake').then((ok) => { if (!ok) offerSwitch('This stream stopped working'); }); }
    else mp.kick();
  }
  window.addEventListener('online', () => { health.check(); wake(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  on('loadedmetadata', updateTimeUI);
  on('durationchange', updateTimeUI);
  on('progress', updateBuffer);
  on('volumechange', () => { prefs.volume = video.volume; prefs.muted = video.muted; savePrefs(); syncVolumeUI(); });
  on('timeupdate', () => {
    updateTimeUI();
    if (!S) return;
    const now = Date.now();
    if (now - lastSave > 5000) { lastSave = now; saveNow(); }
    maybeUpNext();
  });
  on('ended', () => {
    if (!S) return;
    onFinished();
  });

  function updateBuffer() {
    const d = video.duration;
    if (!d || !isFinite(d)) { P.tlBuf.style.width = '0'; return; }
    let end = 0; const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) if (t >= video.buffered.start(i) - 0.3 && t <= video.buffered.end(i) + 0.3) end = video.buffered.end(i);
    P.tlBuf.style.width = `${clamp((end / d) * 100, 0, 100)}%`;
  }
  let scrubbing = false, scrubPct = 0;
  function updateTimeUI() {
    const d = video.duration, t = scrubbing && d ? scrubPct * d : video.currentTime;
    const pct = d && isFinite(d) ? clamp((t / d) * 100, 0, 100) : 0;
    P.tlFill.style.width = pct + '%'; P.tlThumb.style.left = pct + '%'; P.mFill.style.width = pct + '%';
    P.tCur.textContent = fmtTime(t);
    P.tRem.textContent = d && isFinite(d) ? '-' + fmtTime(d - t) : '--:--';
    P.timeline.setAttribute('aria-valuenow', String(Math.round(pct)));
    P.timeline.setAttribute('aria-valuetext', `${fmtTime(t)} of ${d && isFinite(d) ? fmtTime(d) : 'unknown'}`);
    updateBuffer();
  }

  /* ---------- timeline scrubbing ---------- */
  function pctFromEvent(e) { const r = P.timeline.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); }
  P.timeline.addEventListener('pointerdown', (e) => {
    if (!video.duration) return;
    scrubbing = true; P.timeline.classList.add('scrubbing'); P.timeline.setPointerCapture(e.pointerId);
    scrubPct = pctFromEvent(e); updateTimeUI();
  });
  P.timeline.addEventListener('pointermove', (e) => {
    const d = video.duration; if (!d) return;
    const p = pctFromEvent(e);
    P.tlTip.hidden = false; P.tlTip.style.left = `${p * 100}%`; P.tlTip.textContent = fmtTime(p * d);
    if (scrubbing) { scrubPct = p; updateTimeUI(); }
  });
  P.timeline.addEventListener('pointerleave', () => { if (!scrubbing) P.tlTip.hidden = true; });
  P.timeline.addEventListener('pointerup', (e) => {
    if (!scrubbing) return;
    scrubbing = false; P.timeline.classList.remove('scrubbing'); P.tlTip.hidden = true;
    seekTo(pctFromEvent(e) * video.duration);
  });
  P.timeline.addEventListener('pointercancel', () => { scrubbing = false; P.timeline.classList.remove('scrubbing'); });
  function seekTo(t) { if (!isFinite(t)) return; video.currentTime = clamp(t, 0, video.duration || t); S && (S.upnextDismissed = S.upnextDismissed); updateTimeUI(); }
  function seekBy(dt) { seekTo(video.currentTime + dt); bumpControls(); }

  /* ---------- transport buttons ---------- */
  function togglePlay() { if (!S) return; if (video.paused) video.play().catch(() => { P.pBigPlay.hidden = false; }); else video.pause(); }
  P.cPlay.addEventListener('click', togglePlay);
  P.mPlay.addEventListener('click', togglePlay);
  P.pBigPlay.addEventListener('click', () => { P.pBigPlay.hidden = true; video.play().catch(() => { }); });
  P.cBack.addEventListener('click', () => seekBy(-10));
  P.cFwd.addEventListener('click', () => seekBy(10));
  P.cMute.addEventListener('click', () => { video.muted = !video.muted; });
  P.cVol.addEventListener('input', () => { video.volume = Number(P.cVol.value); video.muted = video.volume === 0; });
  function syncVolumeUI() {
    const m = video.muted || video.volume === 0;
    setIcon(P.cMute, m ? 'mute' : 'volume');
    P.cMute.setAttribute('aria-label', m ? 'Unmute (m)' : 'Mute (m)');
    P.cVol.value = m ? 0 : video.volume;
  }
  function toggleFullscreen() {
    if (!S) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    else {
      if (playerEl.dataset.mode === 'mini') setMode('full');
      (playerEl.requestFullscreen || playerEl.webkitRequestFullscreen || function () { return Promise.reject(); }).call(playerEl);
    }
  }
  P.cFull.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => setIcon(P.cFull, document.fullscreenElement ? 'shrink' : 'expand'));
  video.addEventListener('dblclick', toggleFullscreen);
  video.addEventListener('click', () => { if (playerEl.dataset.mode === 'full') { if (matchMedia('(hover: none)').matches) { playerEl.dataset.controls = playerEl.dataset.controls === 'visible' ? 'hidden' : 'visible'; if (playerEl.dataset.controls === 'visible') bumpControls(); } else togglePlay(); } });

  /* ---------- mini / close ---------- */
  $('#pBack').addEventListener('click', () => setMode('mini'));
  P.cMini.addEventListener('click', () => setMode('mini'));
  $('#pClose').addEventListener('click', stopPlayback);
  $('#mClose').addEventListener('click', stopPlayback);
  $('#mExpand').addEventListener('click', () => setMode('full'));

  /* ---------- picture-in-picture button + state sync ---------- */
  P.cPip.addEventListener('click', () => pip.toggle());
  const syncPip = () => {
    const on = pip.active;
    setIcon(P.cPip, on ? 'pipExit' : 'pip');
    P.cPip.setAttribute('aria-label', on ? 'Exit Picture-in-Picture' : 'Picture-in-Picture (floats over other apps)');
    P.cPip.classList.toggle('active', on);
    caps.setNative(on);          // our caption overlay is not part of the floating window, so let the browser draw cues there
  };
  video.addEventListener('enterpictureinpicture', syncPip);
  video.addEventListener('leavepictureinpicture', () => { syncPip(); if (S && playerEl.dataset.mode === 'mini') setMode('full'); });
  video.addEventListener('webkitpresentationmodechanged', syncPip);

  /* ---------- controls auto-hide ---------- */
  function bumpControls() {
    playerEl.dataset.controls = 'visible';
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => {
      const hovering = $('.p-bottom:hover, .p-top:hover', playerEl);
      if (video.paused || drawerOpen() || capOpen() || hovering || !P.stall.hidden || scrubbing) { bumpControls(); return; }
      playerEl.dataset.controls = 'hidden';
    }, 3000);
  }
  ['pointermove', 'pointerdown', 'touchstart'].forEach((ev) => playerEl.addEventListener(ev, () => { if (S && playerEl.dataset.mode === 'full') bumpControls(); }, { passive: true }));

  /* ---------- progress persistence ---------- */
  function saveNow(force) {
    if (!S || !S.title && !S.meta) return;
    const d = video.duration, t = video.currentTime;
    if (!isFinite(t) || t < 1 || S.finished) return;
    putProgress({
      type: S.type, id: S.id, season: S.season || null, episode: S.episode || null, episodeName: S.episodeName || '',
      positionSeconds: Math.floor(t), duration: d && isFinite(d) ? Math.floor(d) : (getProgress(S.type, S.id) || {}).duration || 0,
      updatedAt: Date.now(), title: S.title, poster: S.poster || null, backdrop: S.backdrop || null, year: S.year || '',
      still: S.type === 'series' ? (S.episodeStill || prevStill(S.type, S.id, S.season, S.episode)) : null
    });
  }
  // Reuse a stored still when it belongs to the same episode (episode context may not have loaded yet).
  function prevStill(type, id, season, episode) {
    const old = getProgress(type, id);
    return old && old.season === season && old.episode === episode ? (old.still || null) : null;
  }
  window.addEventListener('pagehide', () => saveNow(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(true); });

  function onFinished() {
    if (!S || S.finished) return;
    S.finished = true;
    if (S.type === 'series' && S.next) {
      // Point Continue Watching at the next episode.
      putProgress({ type: S.type, id: S.id, season: S.next.season, episode: S.next.episode, episodeName: S.next.name || '', still: S.next.still || null, positionSeconds: 0, duration: 0, upNext: true, updatedAt: Date.now(), title: S.title, poster: S.poster || null, backdrop: S.backdrop || null, year: S.year || '' });
      if (prefs.autoNext) { playNext(); return; }
      showUpNext(0);
    } else {
      dropProgress(S.type, S.id);
      bumpControls();
    }
  }

  /* ---------- up next ---------- */
  function maybeUpNext() {
    if (!S || S.type !== 'series' || !S.next || S.upnextDismissed || S.finished) return;
    const d = video.duration, t = video.currentTime;
    if (!d || !isFinite(d) || d < 120) return;
    const rem = d - t;
    if (rem < 30 && rem > 0) showUpNext(rem);
    else if (rem >= 32 && !P.upnext.hidden) P.upnext.hidden = true;
  }
  function showUpNext(rem) {
    if (!S || !S.next || playerEl.dataset.mode === 'mini') return;
    const n = S.next;
    P.upnext.hidden = false;
    P.unTitle.textContent = `S${n.season} · E${n.episode}${n.name ? ' — ' + n.name : ''}`;
    P.unKicker.textContent = prefs.autoNext && rem > 0 ? `Up next · starts in ${Math.ceil(rem)}s` : 'Up next';
    P.unAuto.checked = prefs.autoNext;
    if (n.still) { P.unStill.src = n.still; P.unStill.hidden = false; } else P.unStill.hidden = true;
  }
  P.unAuto.addEventListener('change', () => { prefs.autoNext = P.unAuto.checked; savePrefs(); });
  P.unPlay.addEventListener('click', playNext);
  $('#unCancel').addEventListener('click', () => { if (S) S.upnextDismissed = true; P.upnext.hidden = true; });
  P.cNext.addEventListener('click', playNext);
  function playNext() {
    if (!S || !S.next) return;
    const n = S.next, id = S.id, type = S.type;
    // Mark the current episode as done so resume doesn't send us back here.
    S.finished = true;
    putProgress({ type, id, season: n.season, episode: n.episode, episodeName: n.name || '', still: n.still || null, positionSeconds: 0, duration: 0, upNext: true, updatedAt: Date.now(), title: S.title, poster: S.poster || null, backdrop: S.backdrop || null, year: S.year || '' });
    startPlayback({ type, id, season: n.season, episode: n.episode });
  }

  /* =====================================================================
   * Keyboard
   * ===================================================================== */
  const shortcuts = $('#shortcuts');
  const openShortcuts = (o) => { shortcuts.hidden = !o; if (o) $('#shortcutsClose').focus(); };
  $('#shortcutsBtn').addEventListener('click', () => openShortcuts(true));
  $('#shortcutsClose').addEventListener('click', () => openShortcuts(false));
  shortcuts.addEventListener('click', (e) => { if (e.target === shortcuts) openShortcuts(false); });

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' && e.target.type !== 'range' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

    if (e.key === 'Escape') {
      if (!shortcuts.hidden) { openShortcuts(false); return; }
      if (typing) return;
      if (S) {
        e.preventDefault();
        if (!P.stall.hidden) { mp.dismissOffer(); P.stall.hidden = true; return; }       // 1. stall banner
        if (capOpen()) { closeCapMenu(); $('#cCaptions').focus(); return; }
        if (drawerOpen()) { closeDrawer(); return; }                                     // (drawer behaves like a dialog)
        if (playerEl.dataset.mode === 'full') { setMode('mini'); return; }               // 2. full -> mini
        stopPlayback();                                                                  // 3. mini -> stop + save
      }
      return;
    }
    if (typing) return;
    if (e.key === '?') { e.preventDefault(); openShortcuts(shortcuts.hidden); return; }
    if (e.key === '/' && !S) { e.preventDefault(); openSearch(true); searchInput.focus(); return; }
    if (!S || playerEl.dataset.mode !== 'full') return;

    const inPlayer = playerEl.contains(e.target);
    const isBtn = inPlayer && (tag === 'button' || tag === 'a' || tag === 'input');
    switch (e.key) {
      case ' ': if (isBtn) return; e.preventDefault(); togglePlay(); bumpControls(); break;
      case 'k': togglePlay(); bumpControls(); break;
      case 'ArrowLeft': e.preventDefault(); seekBy(-10); break;
      case 'ArrowRight': e.preventDefault(); seekBy(10); break;
      case 'f': case 'F': e.preventDefault(); toggleFullscreen(); break;
      case 'c': case 'C': e.preventDefault(); toggleCaptions(); bumpControls(); break;
      case 'm': case 'M': e.preventDefault(); video.muted = !video.muted; bumpControls(); break;
      default: return;
    }
  });

  /* ---------- offline banner retry ---------- */
  $('#offlineRetry').addEventListener('click', () => health.check());

  /* =====================================================================
   * Boot
   * ===================================================================== */
  hydrateIcons();
  syncVolumeUI();
  health.start();
  route(false);
})();