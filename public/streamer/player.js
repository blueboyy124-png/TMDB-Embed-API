/* MacStream — player.js
 * Thin wrapper around <video> + hls.js.
 *  - load(url, { startAt, autoplay })   switch source, preserving position
 *  - stall detection that only OFFERS (emits 'stall'); it never switches sources
 *  - best-effort English-first audio track selection
 * Events (via on/off): 'ready', 'fatal', 'stall', 'stallclear'
 */
(function () {
  'use strict';

  const HLS_MIME = 'application/vnd.apple.mpegurl';
  const isSafari = /^((?!chrome|android|crios|fxios).)*(safari|applewebkit)/i.test(navigator.userAgent) &&
    (/Apple/i.test(navigator.vendor || '') || /iPad|iPhone|iPod/.test(navigator.userAgent));

  const STALL_MIN_WAIT_MS = 8000;     // must be starved this long before we even look
  const STALL_WINDOW_MS = 20000;      // trailing window for the buffer-rate check
  const STALL_MIN_RATE = 0.35;        // < 0.35x real time == starved
  const STALL_COOLDOWN_MS = 60000;    // after an offer, stay quiet for a while

  function looksHls(url) {
    return /\.m3u8(\?|$)/i.test(url) || /m3u8-proxy/i.test(url);
  }

  function bufferedEnd(video) {
    const b = video.buffered;
    const t = video.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.25 && t <= b.end(i) + 0.25) return b.end(i);
    }
    return b.length ? b.end(b.length - 1) : 0;
  }

  class MacPlayer {
    constructor(video) {
      this.video = video;
      this.hls = null;
      this.listeners = {};
      this.generation = 0;
      this.samples = [];
      this.stalledSince = 0;
      this.offeredAt = 0;
      this.offerOpen = false;
      this.fatalRecoveries = 0;
      this._tick = setInterval(() => this._checkStall(), 1000);
      ['waiting', 'stalled'].forEach((ev) => video.addEventListener(ev, () => this._markStarved()));
      ['playing', 'canplay', 'seeked'].forEach((ev) => video.addEventListener(ev, () => this._maybeRecovered()));
      video.addEventListener('emptied', () => this._reset());
    }

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; }
    off(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); }
    emit(ev, data) { (this.listeners[ev] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

    get usingHls() { return !!this.hls; }

    load(url, opts) {
      const { startAt = 0, autoplay = true } = opts || {};
      const v = this.video;
      const gen = ++this.generation;
      this._teardown();
      this._reset();
      this.offeredAt = 0;
      this.fatalRecoveries = 0;

      const seekAndPlay = () => {
        if (gen !== this.generation) return;
        if (startAt > 0) {
          try { v.currentTime = startAt; } catch (_) { /* seek failed; start from 0 */ }
        }
        this.selectEnglishAudio();
        this.emit('ready');
        if (autoplay) v.play().catch(() => this.emit('blocked'));
      };

      const nativeHls = !!v.canPlayType(HLS_MIME);
      const hlsJs = typeof window.Hls !== 'undefined' && window.Hls.isSupported();
      // Spec: native HLS when the browser says it can, else hls.js. Chrome/Android answer "maybe"
      // without a reliable pipeline, so only trust native on Safari (or when hls.js is unavailable).
      const useNative = nativeHls && (isSafari || !hlsJs);

      if (looksHls(url) && !useNative) {
        if (!hlsJs) { this.emit('fatal', { reason: 'hls-unsupported' }); return; }
        const hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 60, backBufferLength: 30 });
        this.hls = hls;
        hls.on(window.Hls.Events.MANIFEST_PARSED, seekAndPlay);
        hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => this.selectEnglishAudio());
        hls.on(window.Hls.Events.ERROR, (_e, data) => this._onHlsError(hls, data));
        hls.loadSource(url);
        hls.attachMedia(v);
      } else {
        v.addEventListener('loadedmetadata', seekAndPlay, { once: true });
        v.addEventListener('error', () => {
          if (gen === this.generation) this.emit('fatal', { reason: 'media-error', code: v.error && v.error.code });
        }, { once: true });
        v.src = url;
        v.load();
      }
    }

    _onHlsError(hls, data) {
      if (hls !== this.hls || !data || !data.fatal) return;
      // Try cheap in-place recovery first, then OFFER (never auto-switch).
      if (this.fatalRecoveries < 2) {
        this.fatalRecoveries++;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); return; }
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
      }
      this.emit('fatal', { reason: data.details || 'hls-fatal' });
    }

    selectEnglishAudio() {
      const isEn = (t) => /^en/i.test(t.lang || t.language || '') || /english/i.test(t.name || t.label || '');
      try {
        if (this.hls && this.hls.audioTracks && this.hls.audioTracks.length > 1) {
          const idx = this.hls.audioTracks.findIndex(isEn);
          if (idx >= 0 && this.hls.audioTrack !== idx) this.hls.audioTrack = idx;
          return;
        }
        const at = this.video.audioTracks;
        if (at && at.length > 1) {
          let en = -1;
          for (let i = 0; i < at.length; i++) { if (isEn(at[i])) { en = i; break; } }
          if (en >= 0) for (let i = 0; i < at.length; i++) at[i].enabled = i === en;
        }
      } catch (_) { /* best effort only */ }
    }

    stop() {
      this.generation++;
      this._teardown();
      const v = this.video;
      v.pause();
      v.removeAttribute('src');
      v.load();
      this._reset();
    }

    _teardown() {
      if (this.hls) { try { this.hls.destroy(); } catch (_) { /* noop */ } this.hls = null; }
    }

    /* ---------- stall detection (offer only) ---------- */
    _reset() {
      this.samples = [];
      this.stalledSince = 0;
      if (this.offerOpen) { this.offerOpen = false; this.emit('stallclear'); }
    }

    _markStarved() {
      const v = this.video;
      if (v.paused || v.ended || !v.currentSrc && !this.hls) return;
      if (!this.stalledSince) this.stalledSince = performance.now();
    }

    _maybeRecovered() {
      const v = this.video;
      if (v.readyState >= 3 && !v.paused) {
        this.stalledSince = 0;
        this.samples = [];
        if (this.offerOpen) { this.offerOpen = false; this.emit('stallclear'); }
      }
    }

    dismissOffer() {
      this.offerOpen = false;
      this.offeredAt = performance.now();
      this.stalledSince = performance.now(); // restart the clock
      this.samples = [];
    }

    _checkStall() {
      const v = this.video;
      const now = performance.now();
      const starving = !v.paused && !v.ended && !v.seeking && v.readyState < 3 && (v.currentSrc || this.hls);
      if (!starving) {
        if (v.readyState >= 3) { this.stalledSince = 0; this.samples = []; }
        return;
      }
      if (!this.stalledSince) this.stalledSince = now;

      this.samples.push({ t: now, buf: bufferedEnd(v), pos: v.currentTime });
      this.samples = this.samples.filter((s) => now - s.t <= STALL_WINDOW_MS);

      if (this.offerOpen) return;
      if (this.offeredAt && now - this.offeredAt < STALL_COOLDOWN_MS) return;
      if (now - this.stalledSince < STALL_MIN_WAIT_MS) return;

      const first = this.samples[0];
      const elapsed = (now - first.t) / 1000;
      if (elapsed < 5) return;
      const grew = Math.max(0, bufferedEnd(v) - first.buf);       // seconds of media gained
      const rate = grew / elapsed;                                 // media seconds per real second
      const frozen = Math.abs(v.currentTime - first.pos) < 0.05;
      // Bytes are genuinely arriving fast enough -> the buffer is filling; stay quiet.
      if (rate >= STALL_MIN_RATE && !frozen) return;
      if (rate >= 1) return;
      this.offerOpen = true;
      this.emit('stall', { rate, frozen });
    }

    destroy() {
      clearInterval(this._tick);
      this.stop();
    }
  }

  window.MacPlayer = MacPlayer;
})();