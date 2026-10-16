/* MacStream — captions.js
 * Subtitle/caption support for the player. Handles every source we can reach without touching the backend:
 *   hls     — SUBTITLES renditions declared in an HLS playlist (via hls.js)
 *   ext     — subtitle URLs attached to a stream row (fetched through the existing /sub-proxy when needed)
 *   file    — a .srt / .vtt the viewer loads from disk
 *   native  — text tracks already embedded in the media (e.g. Safari's native HLS, MP4 mov_text)
 * Cues are rendered into our own overlay (tracks run in "hidden" mode) so styling and position stay consistent
 * with the player controls.
 */
(function () {
  'use strict';

  const SUB_KINDS = ['subtitles', 'captions'];

  /* ---------- helpers ---------- */
  const langName = (code) => {
    try { return code ? (new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code) : ''; } catch (_) { return code || ''; }
  };

  function decodeText(buf) {
    let t = new TextDecoder('utf-8').decode(buf);
    if (t.includes('�')) { try { t = new TextDecoder('windows-1252').decode(buf); } catch (_) { /* keep utf-8 */ } }
    return t.replace(/^﻿/, '');
  }

  /** SRT -> WebVTT (VTT passes through). Browsers only accept VTT in <track>. */
  function toVtt(text) {
    let t = String(text).replace(/\r\n?/g, '\n').trim();
    if (/^WEBVTT/.test(t)) return t;
    t = t.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, (_, a, b) => `${a}.${b.padEnd(3, '0')}`)
         .replace(/(\d{1,2}:\d{2}),(\d{1,3})(?=\s*-->|\s*$)/g, (_, a, b) => `${a}.${b.padEnd(3, '0')}`);
    return 'WEBVTT\n\n' + t + '\n';
  }

  /** Normalise whatever a stream row calls its subtitles into [{url,lang,label}]. */
  function extractSubtitles(stream, payload, allRows) {
    const out = [];
    const seen = new Set();
    const seenLang = new Set();
    const push = (it) => {
      if (!it) return;
      if (typeof it === 'string') it = { url: it };
      const url = it.url || it.file || it.src || it.link || it.uri;
      if (!url || seen.has(url)) return;
      seen.add(url);
      const lang = String(it.lang || it.language || it.code || it.srclang || '').toLowerCase();
      const label = it.label || it.name || it.languageLabel || it.display || langName(lang) || 'Subtitles';
      out.push({ url, lang, label });
    };
    const scan = (obj) => {
      if (!obj) return;
      ['subtitles', 'subtitle', 'captions', 'subs', 'textTracks'].forEach((k) => {
        const v = obj[k];
        if (Array.isArray(v)) v.forEach(push); else if (v) push(v);
      });
    };
    scan(stream); scan(payload);
    // Subtitles are only attached to some provider rows; offer them for any source, one per language
    // (the active stream's own tracks come first, so they win).
    if (Array.isArray(allRows)) {
      const have = new Set(out.map((o) => o.lang || o.url));
      allRows.forEach((row) => {
        if (row === stream) return;
        const tmp = extractSubtitles(row, null);
        tmp.forEach((t) => { const k = t.lang || t.url; if (!have.has(k) && !seen.has(t.url)) { have.add(k); seen.add(t.url); out.push(t); } });
      });
    }
    return out;
  }

  /** Render cue text into `el` safely: only <i>, <b>, <u> survive; everything else becomes plain text. */
  function renderCueText(el, text) {
    el.textContent = '';
    const clean = String(text).replace(/\{\\[^}]*\}/g, '');
    const parts = clean.split(/(<\/?(?:i|b|u)>)/i);
    let cur = el;
    const stack = [];
    parts.forEach((p) => {
      const m = p.match(/^<(\/?)(i|b|u)>$/i);
      if (m) {
        if (!m[1]) { const n = document.createElement(m[2].toLowerCase()); cur.appendChild(n); stack.push(cur); cur = n; }
        else if (stack.length) cur = stack.pop();
      } else if (p) cur.appendChild(document.createTextNode(p.replace(/<[^>]*>/g, '')));
    });
  }

  /* ---------- controller ---------- */
  class MacCaptions {
    /**
     * @param {object} o  { video, overlay, getHls(), apiBase, getPrefs(), savePrefs(), onChange() }
     */
    constructor(o) {
      Object.assign(this, o);
      this.ext = [];            // from stream rows
      this.files = [];          // user-supplied
      this.activeId = null;
      this.offset = 0;          // seconds, applied to ext/file tracks
      this._seq = 0;
      this._watched = new WeakSet();
      this._stale = new WeakSet();   // text tracks left behind by a previous source (hls.js never removes its own)
      this.video.textTracks.addEventListener('addtrack', () => { this._watchAll(); this.refresh(); });
      this.video.textTracks.addEventListener('removetrack', () => this.refresh());
    }

    /* ----- entries ----- */
    entries() {
      const list = [];
      const hls = this.getHls && this.getHls();
      if (hls && hls.subtitleTracks && hls.subtitleTracks.length) {
        hls.subtitleTracks.forEach((t, i) => list.push({ id: `hls:${i}`, kind: 'hls', index: i, lang: (t.lang || '').toLowerCase(), label: t.name || langName(t.lang) || `Track ${i + 1}` }));
      } else {
        const ours = new Set([...this.ext, ...this.files].map((e) => e.el && e.el.track).filter(Boolean));
        Array.from(this.video.textTracks).forEach((t, i) => {
          if (ours.has(t) || this._stale.has(t) || !SUB_KINDS.includes(t.kind)) return;
          list.push({ id: `native:${i}`, kind: 'native', track: t, lang: (t.language || '').toLowerCase(), label: t.label || langName(t.language) || `Track ${i + 1}` });
        });
      }
      return list.concat(this.ext, this.files);
    }
    get(id) { return this.entries().find((e) => e.id === id) || null; }
    get active() { return this.activeId ? this.get(this.activeId) : null; }

    /* ----- source management ----- */
    reset(o) {
      const keepFiles = !(o && o.clearFiles);
      this.select(null, { silent: true });
      // Anything on the element that isn't ours belongs to the source we're leaving.
      const ours = new Set([...this.ext, ...this.files].map((e) => e.el && e.el.track).filter(Boolean));
      Array.from(this.video.textTracks).forEach((t) => { if (!ours.has(t)) { this._stale.add(t); t.mode = 'disabled'; } });
      [...this.ext, ...(keepFiles ? [] : this.files)].forEach((e) => { if (e.el) e.el.remove(); });
      this.ext.forEach((e) => { e.el = null; });
      this.ext = [];
      if (!keepFiles) { this.files.forEach((e) => { if (e.blobUrl) URL.revokeObjectURL(e.blobUrl); }); this.files = []; this.offset = 0; }
      else this.files.forEach((e) => { if (e.el) { e.el.remove(); e.el = null; } });
      this.activeId = null;
      this._render();
      this.onChange && this.onChange();
    }

    setExternal(subs) {
      this.ext = (subs || []).map((s) => ({ id: `ext:${++this._seq}`, kind: 'ext', url: s.url, lang: s.lang, label: s.label, el: null, loading: false, error: null }));
      this.autoSelect();
      this.onChange && this.onChange();
    }

    async addFile(file) {
      const buf = await file.arrayBuffer();
      const vtt = toVtt(decodeText(buf));
      const blobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      const entry = { id: `file:${++this._seq}`, kind: 'file', lang: '', label: file.name.replace(/\.(srt|vtt)$/i, ''), blobUrl, el: null, isFile: true };
      this.files.push(entry);
      await this.select(entry.id);
      return entry;
    }

    refresh() { this.autoSelect(); this.onChange && this.onChange(); }

    /** Turn captions on automatically only if the viewer had them on last time. */
    autoSelect() {
      const prefs = this.getPrefs();
      if (this.activeId && this.get(this.activeId)) return;
      this.activeId = null;
      if (!prefs.captionsOn) return;
      const all = this.entries();
      if (!all.length) return;
      const want = (prefs.captionLang || 'en').toLowerCase();
      const pick = all.find((e) => e.lang && e.lang.startsWith(want)) || all.find((e) => /^en/.test(e.lang)) || all[0];
      this.select(pick.id, { auto: true });
    }

    /* ----- selection ----- */
    async select(id, opts) {
      const o = opts || {};
      const hls = this.getHls && this.getHls();
      Array.from(this.video.textTracks).forEach((t) => { if (t.mode !== 'disabled') t.mode = 'disabled'; });
      if (hls) { try { hls.subtitleTrack = -1; } catch (_) { /* noop */ } }
      this.activeId = id;
      if (!id) {
        this._render();
        if (!o.silent) { const p = this.getPrefs(); p.captionsOn = false; this.savePrefs(); this.onChange && this.onChange(); }
        return;
      }
      const e = this.get(id);
      if (!e) { this.activeId = null; return; }
      try {
        if (e.kind === 'hls') {
          hls.subtitleDisplay = false;           // we render the cues ourselves
          hls.subtitleTrack = e.index;
          setTimeout(() => this._hideHlsTracks(), 50);
          setTimeout(() => this._hideHlsTracks(), 600);
        } else if (e.kind === 'native') {
          e.track.mode = 'hidden';
        } else {
          await this._ensureTrack(e);
          if (this.activeId !== id) return;      // user picked something else while it loaded
          e.el.track.mode = 'hidden';
          this._applyOffset(e);
        }
      } catch (err) {
        e.error = err;
        this.activeId = null;
        this.onError && this.onError(e, err);
      }
      if (!o.auto && !o.silent) {
        const p = this.getPrefs(); p.captionsOn = true; if (e.lang) p.captionLang = e.lang; this.savePrefs();
      }
      this._watchAll();
      this._render();
      this.onChange && this.onChange();
    }

    _hideHlsTracks() {
      Array.from(this.video.textTracks).forEach((t) => { if (t.mode === 'showing') t.mode = 'hidden'; });
      this._watchAll(); this._render();
    }

    async _ensureTrack(e) {
      if (e.el) return;
      let src = e.blobUrl;
      if (!src) {
        const isLocal = e.url.startsWith(this.apiBase + '/');
        const fetchUrl = isLocal ? e.url : `${this.apiBase}/sub-proxy?url=${encodeURIComponent(e.url)}`;
        e.loading = true; this.onChange && this.onChange();
        const res = await fetch(fetchUrl);
        if (!res.ok) throw new Error(`Subtitle download failed (${res.status})`);
        const vtt = toVtt(decodeText(await res.arrayBuffer()));
        e.blobUrl = src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
        e.loading = false;
      }
      const el = document.createElement('track');
      el.kind = 'subtitles'; el.label = e.label; if (e.lang) el.srclang = e.lang; el.src = src; el.default = false;
      this.video.appendChild(el);
      e.el = el;
      el.track.mode = 'hidden';
      await new Promise((resolve, reject) => {
        el.addEventListener('load', resolve, { once: true });
        el.addEventListener('error', () => reject(new Error('Could not read this subtitle file')), { once: true });
        setTimeout(resolve, 4000);
      });
      el.addEventListener('load', () => this._applyOffset(e));
    }

    /* ----- native display (Picture-in-Picture draws cues itself; our DOM overlay isn't in that window) ----- */
    setNative(on) {
      if (!this._nativeFlipped) this._nativeFlipped = new Set();
      Array.from(this.video.textTracks).forEach((t) => {
        if (!SUB_KINDS.includes(t.kind)) return;
        if (on && t.mode === 'hidden') { t.mode = 'showing'; this._nativeFlipped.add(t); }
        else if (!on && this._nativeFlipped.has(t)) { if (t.mode === 'showing') t.mode = 'hidden'; this._nativeFlipped.delete(t); }
      });
      this._render();
    }

    /* ----- timing offset (seconds; positive = subtitles appear later) ----- */
    setOffset(sec) {
      this.offset = Math.round(sec * 100) / 100;
      const e = this.active;
      if (e && (e.kind === 'ext' || e.kind === 'file')) this._applyOffset(e);
      this.onChange && this.onChange();
    }
    _applyOffset(e) {
      const cues = e.el && e.el.track && e.el.track.cues;
      if (!cues) return;
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        if (!c._o) c._o = [c.startTime, c.endTime];
        c.startTime = Math.max(0, c._o[0] + this.offset);
        c.endTime = Math.max(c.startTime + 0.05, c._o[1] + this.offset);
      }
      this._render();
    }

    /* ----- rendering ----- */
    _watchAll() {
      Array.from(this.video.textTracks).forEach((t) => {
        if (this._watched.has(t)) return;
        this._watched.add(t);
        t.addEventListener('cuechange', () => this._render());
      });
    }
    _render() {
      const lines = [];
      Array.from(this.video.textTracks).forEach((t) => {
        if (t.mode !== 'hidden' || !SUB_KINDS.includes(t.kind) || !t.activeCues) return;
        Array.from(t.activeCues).forEach((c) => { if (c.text) lines.push(c.text); });
      });
      const el = this.overlay;
      if (!lines.length) { el.hidden = true; el.textContent = ''; return; }
      el.textContent = '';
      lines.join('\n').split('\n').filter((l) => l.trim()).forEach((l) => {
        const row = document.createElement('div');
        row.className = 'cap-line';
        renderCueText(row, l);
        el.appendChild(row);
      });
      el.hidden = false;
    }
  }

  window.MacCaptions = MacCaptions;
  window.MacCaptions.extractSubtitles = extractSubtitles;
  window.MacCaptions.toVtt = toVtt;
})();