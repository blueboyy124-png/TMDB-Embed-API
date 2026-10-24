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

  // iPadOS reports itself as a Mac; touch points give it away. iPad Safari has MSE, so hls.js works there.
  const isIPad = /iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const NATIVE_STARVE_MS = 7000;      // native playback starved this long -> quietly reload at the same spot
  const NATIVE_RESUME_MAX = 4;        // at most this many silent reloads ...
  const NATIVE_RESUME_WINDOW_MS = 10 * 60 * 1000;   // ... per 10 minutes, then fall back to the stall offer

  const STALL_MIN_WAIT_MS = 12000;    // must be starved this long before we even look
  const STALL_WINDOW_MS = 20000;      // trailing window for the buffer-rate check
  const STALL_MIN_RATE = 0.25;        // < 0.25x real time == starved
  const STALL_COOLDOWN_MS = 60000;    // after an offer, stay quiet for a while

  /** `hint` is the stream row's container when the API knows it (true = HLS, false = progressive). */
  function looksHls(url, hint) {
    if (hint === true) return true;
    if (hint === false) return false;
    if (/\.m3u8(\?|$)/i.test(url) || /m3u8-proxy/i.test(url)) return true;
    // Hosts like anixo serve playlists from extensionless paths (/api/stream/m3u8?t=...).
    return /m3u8/i.test(url) && !/ts-proxy/i.test(url);
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
      this.url = null;
      this.usingNative = false;
      this.playedOnce = false;
      this.lastPos = 0;
      this.nativeRecoveries = 0;
      this.silentResumes = [];
      this._tick = setInterval(() => this._checkStall(), 1000);
      ['waiting', 'stalled'].forEach((ev) => video.addEventListener(ev, () => this._markStarved()));
      ['playing', 'canplay', 'seeked'].forEach((ev) => video.addEventListener(ev, () => this._maybeRecovered()));
      video.addEventListener('emptied', () => this._reset());
      video.addEventListener('playing', () => { this.fatalRecoveries = 0; this.nativeRecoveries = 0; });
      video.addEventListener('timeupdate', () => {
        // A dead element (lock screen, sleep) or a reload resets currentTime to 0 and fires timeupdate: that must not
        // overwrite the last real position, or the recovery would restart the video from the beginning.
        const t = video.currentTime || 0;
        if (t > 0.5 || video.readyState >= 2) this.lastPos = t;
        if (this.lastPos > 0.5) this.playedOnce = true;
      });
      video.addEventListener('error', () => this._onNativeError());
    }

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; }
    off(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); }
    emit(ev, data) { (this.listeners[ev] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

    get usingHls() { return !!this.hls; }

    load(url, opts) {
      const { startAt = 0, autoplay = true, hls: hlsHint } = opts || {};
      const v = this.video;
      const gen = ++this.generation;
      this._teardown();
      this._reset();
      this.offeredAt = 0;
      this.fatalRecoveries = 0;
      this.url = url;
      this.hint = hlsHint;
      this._expiredSent = false;
      this.silentResumes = [];
      this.usingNative = false;
      this.playedOnce = startAt > 0.5;
      this.lastPos = startAt || 0;
      this.nativeRecoveries = 0;

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
      const useNative = nativeHls && ((isSafari && !isIPad) || !hlsJs);

      if (looksHls(url, hlsHint) && !useNative) {
        if (!hlsJs) { this.emit('fatal', { reason: 'hls-unsupported' }); return; }
        const hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 60, backBufferLength: 30 });
        this.hls = hls;
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          if (gen !== this.generation) return;
          if (!this._codecsOk(hls)) { this.emit('fatal', { reason: 'unsupported-codec' }); return; }
          seekAndPlay();
        });
        hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => this.selectEnglishAudio());
        hls.subtitleDisplay = false;   // captions.js draws the cues itself
        hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, () => this.emit('subtitletracks'));
        hls.on(window.Hls.Events.ERROR, (_e, data) => this._onHlsError(hls, data));
        hls.loadSource(url);
        hls.attachMedia(v);
      } else {
        this.usingNative = true;
        v.addEventListener('loadedmetadata', seekAndPlay, { once: true });
        v.src = url;
        v.load();
      }
    }

    /** False when every rendition uses a codec this browser can't decode (typically HEVC/H.265). */
    _codecsOk(hls) {
      const levels = hls.levels || [];
      if (!levels.length || typeof window.MediaSource === 'undefined') return true;
      return levels.some((l) => {
        const c = l.videoCodec;
        if (!c) return true;
        try { return window.MediaSource.isTypeSupported(`video/mp4;codecs="${c}"`); } catch (_) { return true; }
      });
    }

    _onHlsError(hls, data) {
      if (hls !== this.hls || !data) return;
      const status = data.response && data.response.code;
      if (!data.fatal) {
        // hls.js retries a refused segment on its own for about a minute (6 tries, doubling delay), which is a frozen
        // picture for a link that will never work again. A 401/403/410 means the token expired: report it NOW so the
        // app can fetch a fresh link at the same position. (Subtitle files are optional, so they never count.)
        const d = data.details || '';
        const refused = status === 401 || status === 403 || status === 410 || (status === 404 && /manifest|level/i.test(d));
        if (refused && /^(fragLoadError|levelLoadError|manifestLoadError|keyLoadError|audioTrackLoadError)$/.test(d) && !this._expiredSent) {
          this._expiredSent = true;
          this.emit('fatal', { reason: d, status, expired: true });
        }
        return;
      }
      // 401/403/404/410 mean the link itself is dead or expired: retrying the same URL can't help,
      // so hand it to the app immediately (it re-fetches fresh links for the same source).
      const gone = status === 401 || status === 403 || status === 404 || status === 410;
      if (gone && this._expiredSent) return;                      // already handed to the app
      // Before the first frame a dead/unreachable source should fail fast so the app can try the next one;
      // once playing, a network blip is worth the longer backoff.
      const maxRetries = this.playedOnce ? 3 : 1;
      if (!gone && this.fatalRecoveries < maxRetries) {
        this.fatalRecoveries++;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          // startLoad() does not re-request a master playlist that failed to load: reload the source instead.
          const manifestFail = /^manifest/i.test(data.details || '');
          if (manifestFail && !this.playedOnce) { this.emit('fatal', { reason: data.details, status, expired: false }); return; }
          const wait = 800 * Math.pow(2, this.fatalRecoveries - 1);       // 0.8s, 1.6s, 3.2s
          setTimeout(() => { if (hls === this.hls) { try { manifestFail ? hls.loadSource(this.url) : hls.startLoad(); } catch (_) { /* noop */ } } }, wait);
          return;
        }
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
      }
      this.emit('fatal', { reason: data.details || 'hls-fatal', status, expired: gone });
    }

    // Native playback (progressive files, Safari's own HLS) has no hls.js to retry with: when the element
    // errors, playback is simply over. Reload the same source at the last position a couple of times
    // (a transient blip), then hand it to the app, which re-fetches fresh links or offers another source.
    _onNativeError() {
      if (!this.usingNative || !this.url) return;
      if (this._tryNativeRecover()) return;
      const v = this.video;
      this.emit('fatal', { reason: 'media-error', code: v.error && v.error.code });
    }

    _tryNativeRecover() {
      if (!this.playedOnce && this.lastPos < 1) return false;   // never painted: the first-frame path owns that
      if (this.nativeRecoveries >= 2) return false;
      if (this.linkStale && this.linkStale()) return false;     // an old link will not come back by asking again
      const v = this.video;
      const pos = (v.currentTime && isFinite(v.currentTime)) ? v.currentTime : this.lastPos;
      const gen = this.generation;
      const url = this.url;
      const attempt = ++this.nativeRecoveries;
      this.emit('recovering', { attempt, position: pos });
      const onMeta = () => {
        if (gen !== this.generation) return;
        try { if (pos > 0) v.currentTime = pos; } catch (_) { /* continue from 0 */ }
        v.play().catch(() => { });
      };
      setTimeout(() => {
        if (gen !== this.generation) return;
        v.addEventListener('loadedmetadata', onMeta, { once: true });
        try { v.src = url; v.load(); } catch (_) { /* ignore */ }
      }, 800 * attempt);
      return true;
    }

    /** Nudge a stalled loader (after the tab wakes or the network returns). */
    kick() { if (this.hls) { try { this.hls.startLoad(-1); } catch (_) { /* noop */ } } }

    /**
     * True when the element has lost its media for good (what a lock screen or a sleeping laptop leaves behind,
     * especially on iPad: no error event, just a black frame that never plays). The app answers with a reload.
     */
    isDead() {
      const v = this.video;
      if (!this.url) return false;
      if (v.error) return true;
      if (this.hls && !this.hls.media) return true;
      if (v.networkState === 3 && (v.currentSrc || this.hls)) return true;                  // NETWORK_NO_SOURCE
      return this.playedOnce && v.readyState === 0 && v.networkState !== 2;                  // nothing loaded, nothing loading
    }

    /** Resolves true when the picture was supposed to be playing but did not move for `ms`. */
    watchProgress(ms) {
      return new Promise((resolve) => {
        const v = this.video, t0 = v.currentTime, gen = this.generation;
        setTimeout(() => resolve(gen === this.generation && !v.paused && !v.ended && v.readyState < 3 && Math.abs(v.currentTime - t0) < 0.2), ms);
      });
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
      this.usingNative = false;
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
      // A seek whose data never arrives stays `seeking` forever, so it must count as starving too.
      const starving = !v.paused && !v.ended && v.readyState < 3 && (v.currentSrc || this.hls);
      if (!starving) {
        if (v.readyState >= 3) { this.stalledSince = 0; this.samples = []; }
        return;
      }
      if (!this.stalledSince) this.stalledSince = now;

      this.samples.push({ t: now, buf: bufferedEnd(v), pos: v.currentTime });
      this.samples = this.samples.filter((s) => now - s.t <= STALL_WINDOW_MS);

      if (this.offerOpen) return;
      if (this._silentResume(now)) return;
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

    /**
     * Native playback (Safari's own player: MP4 files, and HLS on iPhone) gives us no error when the server cuts the
     * connection mid-file: the picture just starves for good until the page is reopened. Re-requesting the same URL at
     * the same position is exactly what reopening does, so do it automatically after a short starve.
     */
    _silentResume(now) {
      const v = this.video;
      if (!this.usingNative || !this.url || !this.playedOnce) return false;
      if (!this.stalledSince || now - this.stalledSince < NATIVE_STARVE_MS) return false;
      if (v.seeking) return false;                                   // a seek the user just made is not a dead connection
      if (this.linkStale && this.linkStale()) return false;          // old link: the app fetches a fresh one instead
      this.silentResumes = this.silentResumes.filter((t) => now - t < NATIVE_RESUME_WINDOW_MS);
      if (this.silentResumes.length >= NATIVE_RESUME_MAX) return false;
      this.silentResumes.push(now);
      const pos = (v.currentTime && isFinite(v.currentTime)) ? v.currentTime : this.lastPos;
      const gen = this.generation, url = this.url;
      this.stalledSince = now; this.samples = [];
      this.emit('recovering', { attempt: this.silentResumes.length, position: pos, silent: true });
      const onMeta = () => {
        if (gen !== this.generation) return;
        try { if (pos > 0) v.currentTime = pos; } catch (_) { /* continue from 0 */ }
        v.play().catch(() => { });
      };
      v.addEventListener('loadedmetadata', onMeta, { once: true });
      try { v.src = url; v.load(); } catch (_) { /* ignore */ }
      return true;
    }

    destroy() {
      clearInterval(this._tick);
      this.stop();
    }
  }

  window.MacPlayer = MacPlayer;
})();