/* MacStream — account.js
 * Optional sign-in with just an email and a password, backed by Supabase (no server code of our own).
 * Keeps My List + watch progress in step across devices: one row per user in the `user_data` table,
 * protected by row-level security so a signed-in user can only ever read or write their own row.
 * Works fully signed-out too (everything stays on this device exactly as before).
 *
 *   MacAccount.init({ button, toast })   once at boot
 *   MacAccount.open()                    show the account dialog
 *   MacAccount.touch()                   "local data changed": schedule a sync (no-op when signed out)
 *   MacAccount.forget(coll, key)         record a deletion ('progress' | 'list') so it syncs too
 *
 * Needs supabase-config.js (project URL + publishable/anon key; both are safe to ship in a web page).
 * Copy public/streamer/supabase-config.example.js to supabase-config.js; the real file is gitignored.
 * Fires window events:  'macstream:synced' {detail:{progress,list}}  when another device changed something
 *                       'macstream:list'                              when the list changed (existing app event)
 */
(function () {
  'use strict';

  const SESSION_KEY = 'macstream.account.v1';
  const TOMB_KEY = 'macstream.tomb.v1';
  const KEYS = { progress: 'macstream.progress.v1', list: 'macstream.list.v1' };
  const TOMB_MS = 60 * 24 * 3600 * 1000;
  const MAX_ITEMS = 600;
  const SYNC_EVERY_MS = 2000;
  const KEEPALIVE_MAX = 60000;                       // browsers cap keepalive bodies at 64 KB

  const CFG = window.MACSTREAM_SUPABASE || {};
  const SB_URL = String(CFG.url || '').trim().replace(/\/+$/, '');
  const SB_KEY = String(CFG.anonKey || '').trim();
  const configured = /^https?:\/\//.test(SB_URL) && SB_KEY.length > 20;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* quota / private mode */ } };

  let btn = null, toast = () => { };
  let session = read(SESSION_KEY, null);             // { access_token, refresh_token, expires_at, user_id, email }
  if (!session || !session.access_token || !session.refresh_token || !session.user_id) session = null;
  let status = { state: 'idle', at: 0, msg: '' };    // idle | syncing | ok | error
  let dirty = false, running = null, rerun = false, timer = null;
  let known = null;                                  // { data, version } as last seen on the server

  /* ---------- local data + merge (same rules as the server) ---------- */
  const stampOf = { progress: (e) => (e && e.updatedAt) || 0, list: (e) => (e && e.addedAt) || 0 };
  const getTomb = () => { const t = read(TOMB_KEY, {}); return { progress: (t && t.progress) || {}, list: (t && t.list) || {} }; };
  function collect() { return { progress: read(KEYS.progress, {}), list: read(KEYS.list, {}), tomb: getTomb() }; }

  function mergeState(a, b) {
    const out = { progress: {}, list: {}, tomb: { progress: {}, list: {} } };
    const now = Date.now();
    ['progress', 'list'].forEach((coll) => {
      const A = (a && a[coll]) || {}, B = (b && b[coll]) || {};
      const tomb = {};
      [(a && a.tomb && a.tomb[coll]) || {}, (b && b.tomb && b.tomb[coll]) || {}].forEach((t) => Object.keys(t).forEach((k) => { const v = Number(t[k]); if (v > 0 && now - v < TOMB_MS) tomb[k] = Math.max(tomb[k] || 0, v); }));
      const stamp = stampOf[coll];
      new Set([...Object.keys(A), ...Object.keys(B)]).forEach((k) => {
        const x = A[k], y = B[k];
        const pick = !x ? y : !y ? x : (stamp(y) > stamp(x) ? y : x);
        if ((tomb[k] || 0) >= stamp(pick)) return;
        out[coll][k] = pick; delete tomb[k];
      });
      const keys = Object.keys(out[coll]);
      if (keys.length > MAX_ITEMS) keys.sort((p, q) => stamp(out[coll][q]) - stamp(out[coll][p])).slice(MAX_ITEMS).forEach((k) => delete out[coll][k]);
      out.tomb[coll] = tomb;
    });
    return out;
  }
  const sig = (s, coll) => Object.keys(s[coll]).sort().map((k) => k + '@' + stampOf[coll](s[coll][k]) + ((s[coll][k] && s[coll][k].episode) || '')).join('|');

  /** Merge what the server sent into what is on this device NOW (not when the request started). */
  function applyRemote(remote) {
    const local = collect();
    const merged = mergeState(local, remote);
    const changed = { progress: sig(local, 'progress') !== sig(merged, 'progress'), list: sig(local, 'list') !== sig(merged, 'list') };
    if (changed.progress) write(KEYS.progress, merged.progress);
    if (changed.list) write(KEYS.list, merged.list);
    write(TOMB_KEY, merged.tomb);
    if (changed.list) window.dispatchEvent(new CustomEvent('macstream:list'));
    if (changed.progress || changed.list) window.dispatchEvent(new CustomEvent('macstream:synced', { detail: changed }));
    return changed;
  }

  function forget(coll, key) {
    const t = getTomb();
    t[coll][key] = Date.now();
    Object.keys(t[coll]).forEach((k) => { if (Date.now() - t[coll][k] > TOMB_MS) delete t[coll][k]; });
    write(TOMB_KEY, t);
    touch();
  }

  /* ---------- network (Supabase REST) ---------- */
  function friendly(status, json) {
    const code = String((json && (json.error_code || json.code)) || '');
    const raw = String((json && (json.msg || json.error_description || json.message || json.error)) || '');
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(raw)) return 'Wrong email or password.';
    if (code === 'user_already_exists' || /already registered/i.test(raw)) return 'That email already has an account. Try signing in.';
    if (code === 'weak_password') return 'That password is too easy to guess. Try 8+ characters with a mix of letters and numbers.';
    if (code === 'email_not_confirmed') return 'Confirm your email first (check your inbox), then sign in.';
    if (code === 'signup_disabled') return 'Sign-ups are turned off in this Supabase project.';
    if (code === 'validation_failed' || /valid email|unable to validate email/i.test(raw)) return 'Enter a valid email address.';
    if (status === 429 || /rate limit/i.test(code + raw)) return 'Too many attempts. Wait a minute and try again.';
    return raw || `Server error (${status})`;
  }
  async function sb(path, o) {
    o = o || {};
    const ctrl = new AbortController();
    const timerId = setTimeout(() => ctrl.abort(), o.timeout || 20000);
    try {
      const headers = { apikey: SB_KEY };
      if (o.token) headers.Authorization = 'Bearer ' + o.token;     // publishable keys aren't JWTs: only send this for a real user token
      if (o.body !== undefined) headers['Content-Type'] = 'application/json';
      if (o.prefer) headers.Prefer = o.prefer;
      const text = o.body !== undefined ? JSON.stringify(o.body) : undefined;
      const res = await fetch(SB_URL + path, { method: o.method || 'GET', headers, body: text, signal: ctrl.signal, cache: 'no-store', keepalive: !!(o.keepalive && text && text.length < KEEPALIVE_MAX) });
      let json = null;
      try { const t = await res.text(); json = t ? JSON.parse(t) : null; } catch (_) { /* empty or not JSON */ }
      if (!res.ok) { const e = new Error(friendly(res.status, json)); e.status = res.status; e.code = json && (json.error_code || json.code); throw e; }
      return json;
    } catch (err) {
      if (err.name === 'AbortError') { const e = new Error('Supabase took too long to answer.'); e.code = 'TIMEOUT'; throw e; }
      if (err.name === 'TypeError') { const e = new Error('Can’t reach Supabase. Check your connection.'); e.code = 'OFFLINE'; throw e; }
      throw err;
    } finally { clearTimeout(timerId); }
  }

  /* ---------- session ---------- */
  function sessionFrom(r) {
    if (!r || !r.access_token) return null;
    return { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: r.expires_at || Math.floor(Date.now() / 1000) + (r.expires_in || 3600), user_id: r.user && r.user.id, email: (r.user && r.user.email) || '' };
  }
  function setSession(s) {
    session = s; known = null;
    if (s) write(SESSION_KEY, s); else { try { localStorage.removeItem(SESSION_KEY); } catch (_) { /* ignore */ } }
    paintButton(); renderDialog();
  }
  function expired() { setSession(null); status = { state: 'idle', at: 0, msg: '' }; toast('Your session ended. Sign in again to keep syncing.'); }

  let refreshing = null;
  function freshToken() {
    if (!session) return Promise.reject(new Error('Not signed in'));
    if (session.expires_at * 1000 - Date.now() > 60000) return Promise.resolve(session.access_token);
    if (refreshing) return refreshing;
    const mine = session.refresh_token;
    refreshing = (async () => {
      try {
        const r = await sb('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: mine } });
        const s = sessionFrom(r);
        if (!s) throw new Error('Session refresh failed');
        if (session && session.refresh_token === mine) { s.email = s.email || session.email; s.user_id = s.user_id || session.user_id; session = s; write(SESSION_KEY, s); }
        return s.access_token;
      } catch (err) {
        if (err.status === 400 || err.status === 401 || err.status === 403) { const e = new Error('Your session ended.'); e.status = 401; throw e; }
        throw err;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }
  const userCall = async (path, o) => sb(path, Object.assign({}, o, { token: await freshToken() }));

  async function signIn(email, password) {
    const r = await sb('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: String(email).trim(), password } });
    const s = sessionFrom(r); if (!s) throw new Error('Sign-in did not return a session.');
    setSession(s); await sync({ force: true }); return s;
  }
  /** Resolves { confirm: true } when the project wants the email confirmed first (no session yet). */
  async function signUp(email, password) {
    const r = await sb('/auth/v1/signup', { method: 'POST', body: { email: String(email).trim(), password } });
    const s = sessionFrom(r);
    if (!s) return { confirm: true };
    setSession(s); await sync({ force: true }); return { confirm: false, session: s };
  }
  async function resetPassword(email) {
    const back = encodeURIComponent(location.origin + location.pathname);
    await sb(`/auth/v1/recover?redirect_to=${back}`, { method: 'POST', body: { email: String(email).trim() } });
  }
  async function changePassword(next) { await userCall('/auth/v1/user', { method: 'PUT', body: { password: next } }); }

  async function signOut() {
    if (!session) return true;
    const ok = await sync({ force: true });
    if (!ok && !window.confirm('Your latest changes couldn’t be synced. Sign out anyway? Anything changed since the last sync on this device will be lost.')) return false;
    try { await userCall('/auth/v1/logout?scope=local', { method: 'POST', timeout: 4000 }); } catch (_) { /* the token expires on its own */ }
    // The account keeps everything; clear this device so the next person starts clean.
    [KEYS.progress, KEYS.list, TOMB_KEY, SESSION_KEY].forEach((k) => { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } });
    session = null;
    location.reload();
    return true;
  }

  /* ---------- sync ---------- */
  function touch() {
    if (!session) return;
    dirty = true;
    clearTimeout(timer);
    // Save progress every 2 seconds during playback for real-time cross-device sync
    timer = setTimeout(() => sync(), 2000);
  }

  const tombSig = (s, c) => Object.keys(s.tomb[c]).sort().map((k) => k + '@' + s.tomb[c][k]).join('|');
  const differs = (a, b) => sig(a, 'progress') !== sig(b, 'progress') || sig(a, 'list') !== sig(b, 'list') || tombSig(a, 'progress') !== tombSig(b, 'progress') || tombSig(a, 'list') !== tombSig(b, 'list');
  const normalise = (d) => ({ progress: (d && d.progress) || {}, list: (d && d.list) || {}, tomb: { progress: (d && d.tomb && d.tomb.progress) || {}, list: (d && d.tomb && d.tomb.list) || {} } });

  /** Read the row, merge it with this device, write back only if something changed. Optimistic version check so two
   *  devices syncing at the same moment can't overwrite each other: the loser just re-reads and merges again. */
  async function pushPull() {
    const uid = encodeURIComponent(session.user_id);
    for (let attempt = 0; attempt < 4; attempt++) {
      const rows = await userCall(`/rest/v1/user_data?select=data,version&user_id=eq.${uid}`);
      const row = rows && rows[0];
      const remote = normalise(row && row.data);
      const merged = mergeState(collect(), remote);
      let version = row ? row.version : 0;
      if (!row || differs(merged, remote)) {
        if (!row) {
          try { await userCall('/rest/v1/user_data', { method: 'POST', body: { user_id: session.user_id, data: merged, version: 1 }, prefer: 'return=minimal' }); version = 1; }
          catch (err) { if (err.status === 409) continue; throw err; }
        } else {
          const done = await userCall(`/rest/v1/user_data?user_id=eq.${uid}&version=eq.${row.version}`, { method: 'PATCH', body: { data: merged, version: row.version + 1, updated_at: new Date().toISOString() }, prefer: 'return=representation' });
          if (!done || !done.length) continue;                      // someone else wrote first: merge again
          version = row.version + 1;
        }
      }
      known = { data: merged, version };
      return merged;
    }
    throw new Error('Another device is syncing right now. Will retry.');
  }

  /** Page is going away: one conditional write, no read. If it loses a race the next session simply re-merges. */
  function flush() {
    if (!session || !dirty || !known || session.expires_at * 1000 < Date.now()) return;
    try {
      const merged = mergeState(collect(), known.data);
      const uid = encodeURIComponent(session.user_id);
      sb(`/rest/v1/user_data?user_id=eq.${uid}&version=eq.${known.version}`, { method: 'PATCH', token: session.access_token, body: { data: merged, version: known.version + 1 }, prefer: 'return=minimal', keepalive: true, timeout: 8000 }).catch(() => { });
    } catch (_) { /* best effort */ }
  }

  function sync() {
    if (!session) return Promise.resolve(false);
    if (running) { rerun = true; return running; }
    clearTimeout(timer);
    setStatus({ state: 'syncing' });
    const mine = session.user_id;
    running = (async () => {
      try {
        const merged = await pushPull();
        if (!session || session.user_id !== mine) return false;
        applyRemote(merged);
        dirty = false;
        setStatus({ state: 'ok', at: Date.now() });
        return true;
      } catch (err) {
        if (err.status === 401) { expired(); return false; }
        setStatus({ state: 'error', msg: err.message });
        return false;
      } finally {
        running = null;
        if (rerun) { rerun = false; setTimeout(() => sync(), 800); }
      }
    })();
    return running;
  }

  function setStatus(s) { status = Object.assign({}, status, s); paintButton(); paintStatus(); }

  /* ---------- nav button ---------- */
  const initialOf = () => (session && session.email ? session.email.charAt(0).toUpperCase() : '?');
  let btnOriginal = '';
  function paintButton() {
    if (!btn) return;
    if (!btnOriginal) btnOriginal = btn.innerHTML;
    if (session) {
      btn.innerHTML = `<span class="acct-avatar" aria-hidden="true">${esc(initialOf())}</span>`;
      btn.setAttribute('aria-label', `Account: ${session.email}`); btn.title = `Signed in as ${session.email}`;
      btn.classList.toggle('acct-warn', status.state === 'error');
    } else {
      btn.innerHTML = btnOriginal; btn.setAttribute('aria-label', 'Sign in'); btn.title = 'Sign in to sync across devices'; btn.classList.remove('acct-warn');
    }
  }

  /* ---------- dialog ---------- */
  let dlg = null, mode = 'in', formError = '', formNotice = '', busy = false, lastFocus = null, recovery = false;

  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 10) return 'just now'; if (s < 60) return `${s} seconds ago`;
    const m = Math.round(s / 60); if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
    const h = Math.round(m / 60); return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  function statusText() {
    if (status.state === 'syncing') return 'Syncing…';
    if (status.state === 'error') return `Not synced: ${status.msg || 'will retry'}`;
    if (status.at) return `Synced ${ago(status.at)}`;
    return 'Ready to sync';
  }
  function paintStatus() { const el = dlg && dlg.querySelector('[data-sync-status]'); if (el) { el.textContent = statusText(); el.dataset.state = status.state; } }

  function build() {
    dlg = document.createElement('div');
    dlg.className = 'modal acct-modal'; dlg.hidden = true;
    dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-label', 'Account');
    dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(); });
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('submit', onSubmit);
    document.body.appendChild(dlg);
  }

  function open(opts) {
    if (!dlg) build();
    lastFocus = document.activeElement;
    formError = ''; formNotice = ''; busy = false;
    recovery = !!(opts && opts.recovery);
    dlg.hidden = false; document.body.classList.add('acct-open');
    renderDialog();
    if (session) sync();
    setTimeout(() => { const f = dlg.querySelector('input, button.btn'); if (f) f.focus({ preventScroll: true }); }, 30);
  }
  function close() {
    if (!dlg) return;
    dlg.hidden = true; document.body.classList.remove('acct-open'); recovery = false;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (_) { /* gone */ } }
  }

  const field = (label, name, type, extra) => `<label class="acct-field"><span>${label}</span><input name="${name}" type="${type}" ${extra || ''}></label>`;

  function renderDialog() {
    if (!dlg || dlg.hidden) return;
    const body = !configured ? renderSetup() : session ? renderSignedIn() : renderSignedOut();
    dlg.innerHTML = `<div class="modal-card acct-card">${body}</div>`;
    paintStatus();
  }

  const closeBtn = '<button type="button" class="icon-btn" data-act="close" aria-label="Close">✕</button>';

  function renderSetup() {
    return `<div class="acct-head"><div><h3>Accounts aren’t set up yet</h3><p class="acct-sub">One quick step to turn on sync.</p></div>${closeBtn}</div>
      <p class="acct-note">Open <code>supabase-config.js</code> and paste in your Supabase project URL and publishable key, then reload. The steps are in <code>docs/SUPABASE-SETUP.md</code>.</p>`;
  }

  function renderSignedIn() {
    const pw = `<form data-form="password" class="acct-form" autocomplete="off">
          ${field(recovery ? 'Choose a new password' : 'New password (8+ characters)', 'next', 'password', 'autocomplete="new-password" minlength="8" required')}
          <p class="acct-error" role="alert">${esc(formError)}</p>
          ${formNotice ? `<p class="acct-ok" role="status">${esc(formNotice)}</p>` : ''}
          <button class="btn btn-ghost" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Update password'}</button>
        </form>`;
    return `
      <div class="acct-head">
        <span class="acct-avatar lg" aria-hidden="true">${esc(initialOf())}</span>
        <div><h3>${esc(session.email || 'Signed in')}</h3><p class="acct-sub" data-sync-status aria-live="polite"></p></div>
        ${closeBtn}
      </div>
      ${recovery ? '<p class="acct-note">You’re signed in. Pick a new password below.</p>' : '<p class="acct-note">Your My List and watch progress follow you to every device you sign in on.</p>'}
      ${recovery ? '' : `<div class="acct-actions">
        <button type="button" class="btn btn-light" data-act="sync-now">Sync now</button>
        <button type="button" class="btn btn-ghost" data-act="signout">Sign out</button>
      </div>`}
      <details class="acct-more" ${recovery || formNotice || formError ? 'open' : ''}>
        <summary>Change password</summary>
        ${pw}
      </details>`;
  }

  function renderSignedOut() {
    const head = `<div class="acct-head"><div><h3>Sync across devices</h3><p class="acct-sub">Sign in to keep your list and progress on every screen.</p></div>${closeBtn}</div>`;
    const up = mode === 'up';
    return `${head}
      <div class="acct-tabs" role="tablist">
        <button type="button" role="tab" aria-selected="${!up}" data-act="mode-in">Sign in</button>
        <button type="button" role="tab" aria-selected="${up}" data-act="mode-up">Create account</button>
      </div>
      <form data-form="${up ? 'up' : 'in'}" class="acct-form">
        ${field('Email', 'email', 'email', 'autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="email" required')}
        ${field('Password', 'password', 'password', `autocomplete="${up ? 'new-password' : 'current-password'}" required ${up ? 'minlength="8"' : ''}`)}
        <p class="acct-error" role="alert">${esc(formError)}</p>
        ${formNotice ? `<p class="acct-ok" role="status">${esc(formNotice)}</p>` : ''}
        <button class="btn btn-light acct-submit" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'One moment…' : up ? 'Create account' : 'Sign in'}</button>
        ${up ? '' : '<button type="button" class="acct-link" data-act="forgot">Forgot password?</button>'}
      </form>
      <p class="acct-note">Optional. Without an account everything stays on this device, as before. Anything already saved here is added to your account when you sign in.</p>`;
  }

  function onClick(e) {
    const t = e.target.closest('[data-act]'); if (!t) return;
    const act = t.dataset.act;
    if (act === 'close') close();
    else if (act === 'mode-in' || act === 'mode-up') { mode = act === 'mode-up' ? 'up' : 'in'; formError = ''; formNotice = ''; renderDialog(); const f = dlg.querySelector('input'); if (f) f.focus(); }
    else if (act === 'sync-now') sync({ force: true });
    else if (act === 'signout') { t.disabled = true; signOut().then((done) => { if (!done) t.disabled = false; }); }
    else if (act === 'forgot') forgot();
  }

  async function forgot() {
    const input = dlg.querySelector('input[name="email"]');
    const email = input ? input.value.trim() : '';
    if (!email) { formError = 'Type your email above first, then tap “Forgot password?”.'; formNotice = ''; renderDialog(); const f = dlg.querySelector('input[name="email"]'); if (f) f.focus(); return; }
    busy = true; formError = ''; formNotice = ''; renderDialog();
    try { await resetPassword(email); formNotice = 'If that email has an account, a reset link is on its way. Open it on this device.'; }
    catch (err) { formError = err.message; }
    finally { busy = false; renderDialog(); const f = dlg && dlg.querySelector('input[name="email"]'); if (f) f.value = email; }
  }

  async function onSubmit(e) {
    e.preventDefault();
    const form = e.target.closest('form[data-form]'); if (!form || busy) return;
    const kind = form.dataset.form, d = Object.fromEntries(new FormData(form).entries());
    busy = true; formError = ''; formNotice = ''; renderDialog();
    try {
      if (kind === 'in') { const s = await signIn(d.email, d.password); close(); toast(`Signed in as ${s.email}`); }
      else if (kind === 'up') {
        const r = await signUp(d.email, d.password);
        if (r.confirm) { mode = 'in'; formNotice = 'Almost there: we emailed you a link. Confirm your email, then sign in here.'; }
        else { close(); toast('Account created. You’re signed in.'); }
      }
      else if (kind === 'password') { await changePassword(d.next); formNotice = 'Password updated.'; recovery = false; toast('Password updated.'); }
    } catch (err) {
      if (err.status === 401 && session) return;       // expired(): dialog already switched to signed-out
      formError = err.message;
    } finally {
      busy = false; renderDialog();
      const em = dlg && dlg.querySelector('input[name="email"]'); if (em && d.email) em.value = d.email;
      if (formError && dlg) { const p = dlg.querySelector('input[type="password"]'); if (p) p.focus(); }
    }
  }

  /* ---------- links from Supabase emails (confirm / reset arrive as #access_token=...&type=...) ---------- */
  async function consumeAuthLink() {
    const h = location.hash || '';
    if (!/access_token=|error_description=/.test(h)) return;
    const p = new URLSearchParams(h.replace(/^#\/?/, ''));
    try { history.replaceState(null, '', location.pathname + location.search + '#/'); } catch (_) { /* ignore */ }
    if (p.get('error_description')) { toast(p.get('error_description').replace(/\+/g, ' ')); return; }
    if (!configured || !p.get('access_token')) return;
    try {
      const user = await sb('/auth/v1/user', { token: p.get('access_token') });
      const s = { access_token: p.get('access_token'), refresh_token: p.get('refresh_token') || '', expires_at: Number(p.get('expires_at')) || Math.floor(Date.now() / 1000) + (Number(p.get('expires_in')) || 3600), user_id: user.id, email: user.email || '' };
      setSession(s);
      if (p.get('type') === 'recovery') open({ recovery: true });
      else { toast('Email confirmed. You’re signed in.'); sync(); }
    } catch (err) { toast(err.message); }
  }

  /* ---------- boot ---------- */
  function init(o) {
    btn = o && o.button; if (o && o.toast) toast = o.toast;
    if (btn) { btn.addEventListener('click', () => open()); paintButton(); }
    consumeAuthLink();
    if (session && configured) setTimeout(() => sync(), 400);
    setInterval(() => { if (session && !document.hidden) sync(); }, SYNC_EVERY_MS);
    document.addEventListener('visibilitychange', () => {
      if (!session) return;
      if (document.hidden) flush(); else sync();
    });
    window.addEventListener('pagehide', flush);
    window.addEventListener('online', () => sync());
    window.addEventListener('storage', (e) => { if (e.key === SESSION_KEY) { const s = read(SESSION_KEY, null); session = s && s.access_token ? s : null; paintButton(); renderDialog(); } });
  }

  window.MacAccount = { init, open, close, touch, forget, sync, signIn, signUp, signOut, changePassword, resetPassword, get user() { return session ? session.email : null; }, _mergeState: mergeState };
})();