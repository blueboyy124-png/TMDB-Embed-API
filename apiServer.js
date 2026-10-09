require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const os = require('os');
const { config, saveConfigPatch, OVERRIDE_PATH, overrideStatus } = require('./utils/config');
const { authenticate, issueSession, requireAuth, getSession, updatePassword } = require('./utils/auth');
const path = require('path');
const { listProviders, getProvider, getCookieStats, getAdmissionStatus } = require('./providers/registry');
const { createProxyRoutes, processStreamsForProxy } = require('./proxy/proxyServer');
const { resolveImdbId } = require('./utils/tmdb');
const { applyFilters } = require('./utils/streamFilters');
const { applyTmdbTags, tagCounts } = require('./utils/streamTags');
const { enrichStreams, classifyForPlayback } = require('./utils/streamMeta');
const { runWithRequestContext } = require('./utils/requestContext');
const { isEnough, hasVerifiedHighQuality, qualityValue, DEFAULT_ENOUGH_STREAMS, DEFAULT_ENOUGH_PROVIDERS } = require('./utils/earlyExit');
const linkHealth = require('./utils/linkHealth');

const app = express();
app.set('trust proxy', 1);

// Compress responses. A stream list for a busy episode is ~34KB of JSON, and it is the single most-requested
// payload here; over a LAN or a phone that is real bandwidth for no benefit, and JSON compresses very well
// (typically 80%+). Segment and playlist traffic is excluded: the proxy already sets its own content types and
// re-compressing media would burn CPU for nothing, which is exactly the kind of waste this server was just
// cleaned up for. Mounted before the routes so it applies to everything.
app.use(compression({
  filter: (req, res) => {
    // Leave media alone. ts-proxy/m3u8-proxy already stream bytes; the HLS playlist is small text and does
    // benefit, so only the segment endpoints are skipped.
    if (/\/ts-proxy/.test(req.path)) return false;
    if (res.getHeader('Content-Type') && !/json|text|javascript|svg/.test(String(res.getHeader('Content-Type')))) {
      return /^application\/(vnd\.apple\.mpegurl|x-mpegurl)/.test(String(res.getHeader('Content-Type')));
    }
    return compression.filter(req, res);
  },
  threshold: 1024      // below 1KB the CPU is not worth it
}));

// Last-resort backstop only. Well-behaved providers bound their own upstream calls, so this is not what
// normally ends a request. It has to sit above the slowest real provider's worst case or it turns a slow
// answer into a failure: anime legitimately spikes to ~27s when several anixo hosts are slow at once, and
// an earlier 30s cap here started rejecting anime mid-flight. Override with PROVIDER_TIMEOUT_MS, or
// per provider with PROVIDER_TIMEOUT_<NAME>_MS (e.g. PROVIDER_TIMEOUT_ANIME_MS).
const DEFAULT_PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 45000;
const providerTimeoutMs = (name) =>
  Number(process.env[`PROVIDER_TIMEOUT_${String(name).toUpperCase()}_MS`]) || DEFAULT_PROVIDER_TIMEOUT_MS;

// The aggregate endpoint is bounded by the slowest provider it asks, and measured cold-cache runs put that
// at 19-26s (4khdhub, zxcstreams, anime) even though the other dozen providers were done in under 10s. A
// client can render 20 streams now far better than 25 streams in 45s, so after this much time the response
// leaves with whatever has arrived: `partial: true`, and the providers still working are reported as
// 'pending' rather than silently missing. Raise it with AGGREGATE_SOFT_DEADLINE_MS, or per request with
// ?deadline=ms (clamped to [2s, the hard per-provider ceiling]), and a client that wants everything can ask
// for the full budget. A provider that hangs is still bounded by providerTimeoutMs() above.
const DEFAULT_AGGREGATE_DEADLINE_MS = Number(process.env.AGGREGATE_SOFT_DEADLINE_MS) || 20000;
const MIN_AGGREGATE_DEADLINE_MS = 2000;

// "Enough" — leave early once the answer is already good. See utils/earlyExit.js for why the provider
// threshold is as important as the stream one. Kept here as a module-level constant so the route can hand
// `req.query.wait` past it without a lookup.
const ENOUGH_STREAMS = Number(process.env.AGGREGATE_ENOUGH_STREAMS) || DEFAULT_ENOUGH_STREAMS;
const ENOUGH_PROVIDERS = Number(process.env.AGGREGATE_ENOUGH_PROVIDERS) || DEFAULT_ENOUGH_PROVIDERS;

// How long the quality gate may hold an otherwise-finished response open, waiting for a 4K stream. Sized
// against the real 4K sources: showbox delivers 2160p at ~2.9s and 4khdhub at ~12s, so 6s catches the common
// case while capping the penalty on titles that have no 4K at all.
const QUALITY_WAIT_MS = Number(process.env.AGGREGATE_QUALITY_WAIT_MS) || 6000;

// Reject with a TimeoutError once `ms` has passed. The underlying work is not cancelled (providers own
// their own AbortSignals), but it is detached so a slow promise can no longer hold up the response.
function withDeadline(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded ${ms}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), guard]);
}

// Conditionally mount proxy routes early so downstream handlers can use them
if (config.enableProxy) {
  console.log('[startup] enableProxy flag active: mounting proxy routes');
  createProxyRoutes(app);
} else {
  console.log('[startup] enableProxy flag disabled: proxy routes not mounted');
}

// --- Simple In-Memory Rate Limiting for /auth/login ---
const loginAttempts = new Map(); // key: ip, value: { count, first, last, lockedUntil }
const MAX_ATTEMPTS_WINDOW = 5; // attempts allowed
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes window
const BASE_LOCK_MS = 5 * 60 * 1000; // 5 minutes base lock
// Bound on tracked IPs. An entry is only removed when the SAME ip comes back after its window, so a scan
// from many source addresses grew this map forever -- a slow memory leak on a publicly reachable login.
const MAX_TRACKED_IPS = 10000;
function sweepLoginAttempts() {
  if (loginAttempts.size <= MAX_TRACKED_IPS) return;
  // Evict the oldest windows first; `first` is the window anchor, so it is the correct key here.
  const byWindow = Array.from(loginAttempts.entries()).sort((a, b) => a[1].first - b[1].first);
  for (const [ip] of byWindow.slice(0, loginAttempts.size - MAX_TRACKED_IPS)) loginAttempts.delete(ip);
}

function getClientIp(req){
  return (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
}

function recordLoginFailure(ip){
  const now = Date.now();
  sweepLoginAttempts();   // keep the map bounded before it grows by one more entry
  let entry = loginAttempts.get(ip);
  if (!entry) {
    entry = { count:1, first: now, last: now, lockedUntil:0 };
    loginAttempts.set(ip, entry);
    return entry;
  }
  // Reset window if outside timeframe and not locked
  if (now - entry.first > WINDOW_MS && now > entry.lockedUntil) {
    entry.count = 1;
    entry.first = now;
  } else {
    entry.count++;
  }
  entry.last = now;
  if (entry.count > MAX_ATTEMPTS_WINDOW) {
    // Exponential backoff lock: base * 2^(count - limit)
    const over = entry.count - MAX_ATTEMPTS_WINDOW;
    const lockMs = BASE_LOCK_MS * Math.min(8, Math.pow(2, over-1));
    entry.lockedUntil = now + lockMs;
  }
  return entry;
}

function canAttempt(ip){
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed:true };
  const now = Date.now();
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed:false, retryAfter: Math.ceil((entry.lockedUntil - now)/1000) };
  }
  if (now - entry.first > WINDOW_MS) {
    // Window passed; reset
    loginAttempts.delete(ip);
    return { allowed:true };
  }
  return { allowed:true };
}

function recordLoginSuccess(ip){
  // On success clear state to avoid lingering count
  loginAttempts.delete(ip);
}

// Guard against premature process.exit from imported legacy modules, but allow controlled restarts
const realProcessExit = process.exit.bind(process);
let allowControlledExit = false;
process.exit = function(code){
  if (allowControlledExit) return realProcessExit(code);
  console.warn('[diagnostic] Intercepted process.exit with code', code, new Error('exit trace').stack);
  // keep process alive for debugging
};
setImmediate(()=>console.log('[diagnostic] post-start setImmediate fired'));
app.use(cors());
app.use(express.json());

// --- Auth Routes (login before static serving) ---
app.post('/auth/login', (req,res) => {
  const { username, password } = req.body || {};
  const ip = getClientIp(req);
  const attemptState = canAttempt(ip);
  if (!attemptState.allowed) {
    res.setHeader('Retry-After', String(attemptState.retryAfter));
    return res.status(429).json({ success:false, error:'TOO_MANY_ATTEMPTS', retryAfter: attemptState.retryAfter });
  }
  if (!username || !password) return res.status(400).json({ success:false, error:'MISSING_CREDENTIALS' });
  if (!authenticate(username, password)) {
    const entry = recordLoginFailure(ip);
    if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
      const retryAfter = Math.ceil((entry.lockedUntil - Date.now())/1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ success:false, error:'LOCKED', retryAfter });
    }
    return res.status(401).json({ success:false, error:'INVALID_CREDENTIALS', remaining: Math.max(0, MAX_ATTEMPTS_WINDOW - entry.count) });
  }
  recordLoginSuccess(ip);
  const token = issueSession(username);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12*60*60}`);
  res.json({ success:true, username });
});

app.post('/auth/logout', (req,res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ success:true });
});

app.get('/auth/session', (req,res) => {
  const sess = getSession(req);
  if (!sess) return res.json({ authenticated:false });
  res.json({ authenticated:true, username: sess.u });
});

app.post('/auth/change-password', requireAuth, (req,res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ success:false, error:'MISSING_FIELDS' });
  const sess = req.session;
  if (!authenticate(sess.u, oldPassword)) return res.status(401).json({ success:false, error:'INVALID_OLD_PASSWORD' });
  if (newPassword.length < 8) return res.status(400).json({ success:false, error:'PASSWORD_TOO_SHORT' });
  if (!updatePassword(sess.u, newPassword)) return res.status(500).json({ success:false, error:'UPDATE_FAILED' });
  res.json({ success:true, message:'PASSWORD_UPDATED' });
});

// Protect config panel (HTML) explicitly before static middleware
app.get('/config.html', (req,res,next) => {
  const sess = getSession(req);
  if (!sess) return res.redirect(302, '/');
  res.setHeader('Cache-Control','no-store, must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.sendFile(path.join(process.cwd(),'public','config.html'));
});

// Explicit root handler for login page to ensure no-store
app.get('/', (req,res) => {
  res.setHeader('Cache-Control','no-store, must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.sendFile(path.join(process.cwd(),'public','index.html'));
});

// Diagnostics for unexpected exits
process.on('beforeExit', (code) => {
  console.log('[diagnostic] beforeExit code=', code);
});
process.on('exit', (code) => {
  console.log('[diagnostic] exit code=', code);
});
process.on('uncaughtException', (err) => {
  console.error('[diagnostic] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[diagnostic] unhandledRejection', reason);
});
// Periodic heartbeat to confirm event loop activity (can be removed later)
let hbCount = 0;
setInterval(()=>{
  hbCount++;
  if (hbCount % 6 === 0) { // every 60s if interval is 10s
    console.log('[diagnostic] heartbeat 60s elapsed, process alive');
  }
}, 10_000).unref();


// --- Metrics (in-memory) ---
const metrics = {
  startTime: Date.now(),
  requestsTotal: 0,
  streamRequests: 0,
  providerCalls: {},
  lastRequestAt: null,
  lastError: null,
  streamsReturned: 0,
  tmdbToImdbLookups: 0
};

app.use((req,res,next)=>{ metrics.requestsTotal++; metrics.lastRequestAt = Date.now(); next(); });

// Give every request its own context for per-request provider state (currently the showbox cookie choice).
// AsyncLocalStorage keeps it attached to THIS request's async chain, so concurrent users cannot read or
// overwrite each other's state, and it is discarded automatically when the request ends -- no cleanup path
// to forget on an error or a timeout. Mounted before static so nothing below can be missed.
app.use((req, res, next) => {
  runWithRequestContext(() => next());
});

// Serve static UI (login page at /)
app.use(express.static(path.join(process.cwd(),'public')));

// Secrets that must never leave the process over HTTP.
//
// /api/config was readable by anyone who could reach the server and returned the merged config verbatim,
// which included the TMDB API key and the FebBox cookie. It also echoed them back on every write. A config
// view is legitimate; handing out credentials with it is not. So the real values are replaced by a mask plus
// a `has*` flag: a UI can still show "a key is set" and replace it, but cannot read what is already there.
const SECRET_KEYS = ['tmdbApiKeys', 'febboxCookies'];

// Shows enough to recognise a value (so you can tell which of several keys is configured) and never enough to
// use. 6 characters is enough to identify, useless as a credential.
const mask = value => (typeof value === 'string' && value.length > 8) ? `${value.slice(0, 6)}…` : '•••';

function redactConfig(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of SECRET_KEYS) {
    if (!(key in out)) continue;
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = value.map(v => mask(v));                 // keep the shape, drop the value
      out[`has${key.charAt(0).toUpperCase()}${key.slice(1)}`] = value.length > 0;
      out[`${key}Count`] = value.length;
    } else if (value) {
      out[key] = mask(value);
      out[`has${key.charAt(0).toUpperCase()}${key.slice(1)}`] = true;
    }
  }
  return out;
}

// Season/episode validation.
//
// `Number('abc')` is NaN, and NaN is FALSY, so the `seasonNum || 1` fallbacks inside the providers turned a
// nonsense request into season 1 episode 1. `?season=abc&episode=xyz` therefore returned 16 streams for a
// completely different episode, with success:true and no warning -- the exact wrong-episode failure the
// numbering work exists to prevent, arriving through the front door instead.
//
// So they are validated here, once, and rejected loudly. Season 0 is allowed (it is the specials bucket
// TMDB uses); episode numbers start at 1.
function parseSeasonEpisode(req) {
  const rawSeason = req.query.season;
  const rawEpisode = req.query.episode;
  const bad = { success: false, error: 'INVALID_SEASON_EPISODE' };
  const parse = (raw, { min, name }) => {
    if (raw === undefined || raw === null || raw === '') return null;
    // A strict integer test: Number() would accept '', ' ', '0x10', '1e3' and other surprises.
    if (!/^\d+$/.test(String(raw).trim())) return bad;
    const n = Number(String(raw).trim());
    if (!Number.isSafeInteger(n) || n < min) return bad;
    return n;
  };
  const season = parse(rawSeason, { min: 0, name: 'season' });
  if (season === bad) return { error: bad.error };
  const episode = parse(rawEpisode, { min: 1, name: 'episode' });
  if (episode === bad) return { error: bad.error };
  // Half an episode is never meaningful; asking for one and not the other was previously tolerated and is
  // how a UI ends up rendering S2 with no episode.
  if ((season === null) !== (episode === null)) return { error: 'SEASON_AND_EPISODE_TOGETHER' };
  return { season, episode };
}

// Config API
// Read stays open (the dashboard needs it to render) but secrets are redacted.
app.get('/api/config', (req,res) => {
  const fs = require('fs');
  let override = {};
  try { if (fs.existsSync(OVERRIDE_PATH)) override = JSON.parse(fs.readFileSync(OVERRIDE_PATH,'utf8')); } catch (e) {
    // ignore JSON parse or fs errors reading override; return base config
  }
  res.json({ success:true, merged: redactConfig(config), override: redactConfig(override), overridePath: OVERRIDE_PATH });
});

// Write requires a session. This was completely open, and saveConfigPatch merges the patch with no key
// whitelist, so anyone who could reach the server could set enableProxy:false or minQualities:"2160p" and
// silently break playback for everybody using it.
app.post('/api/config', requireAuth, (req,res) => {
  const patch = req.body || {};
  if (patch.port) {
    const p = Number(patch.port); if (!Number.isFinite(p) || p<=0 || p>65535) return res.status(400).json({ success:false, error:'INVALID_PORT'});
    patch.port = p;
  }
  if (patch.defaultProviders && !Array.isArray(patch.defaultProviders)) return res.status(400).json({ success:false, error:'DEFAULT_PROVIDERS_NOT_ARRAY'});
  const ok = saveConfigPatch(patch);
  // Redacted here too: the write response used to echo the keys back as well.
  res.json({ success: ok, merged: redactConfig(config) });
});

// Browse and search.
//
// The API was streams-only until now: a client had to already know a TMDB id, which is not something a person
// can do, so there was no front door to build an app on. This is that door. Shaped for a remote-controlled
// client (a Roku), so the payload is trimmed to what a grid row and a detail screen actually render -- on a
// TV, unused bytes are dropped frames.
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ success: false, error: 'QUERY_REQUIRED' });
  if (q.length > 200) return res.status(400).json({ success: false, error: 'QUERY_TOO_LONG' });
  const pageRaw = req.query.page || '1';
  if (!/^\d+$/.test(String(pageRaw))) return res.status(400).json({ success: false, error: 'INVALID_PAGE' });
  const page = Math.min(Math.max(1, Number(pageRaw)), 10);   // TMDB caps deep paging anyway
  try {
    const data = await require('./utils/tmdb').search(q, page);
    res.json({ success: true, ...data });
  } catch (e) {
    // A TMDB rate limit is not a client error and must not look like "no results" -- a client rendering an
    // empty grid looks like "nothing matches", which sends the user looking for a typo that is not there.
    const limited = /rate limit|cooling down|429/i.test(e.message || '');
    console.error('[api] search failed:', e.message);
    res.status(limited ? 503 : 500).json({ success: false, error: limited ? 'UPSTREAM_RATE_LIMITED' : 'SEARCH_FAILED', detail: e.message });
  }
});

app.get('/api/trending', async (req, res) => {
  const window = req.query.window || 'week';
  try {
    const data = await require('./utils/tmdb').trending(window);
    res.json({ success: true, ...data });
  } catch (e) {
    if (/must be/.test(e.message || '')) return res.status(400).json({ success: false, error: 'INVALID_WINDOW' });
    const limited = /rate limit|cooling down|429/i.test(e.message || '');
    console.error('[api] trending failed:', e.message);
    res.status(limited ? 503 : 500).json({ success: false, error: limited ? 'UPSTREAM_RATE_LIMITED' : 'TRENDING_FAILED', detail: e.message });
  }
});

// Everything a client needs to label a title and an episode, from TMDB and AniList together, so it no
// longer has to call TMDB itself and every provider answers with the same names. Works for movies and for
// series, and works for every provider because it is not tied to any of them.
app.get('/api/metadata/:type/:tmdbId', async (req, res) => {
  const { type, tmdbId } = req.params;
  if (!['movie', 'series', 'tv'].includes(type)) return res.status(400).json({ success: false, error: 'INVALID_TYPE' });
  const tmdbType = type === 'movie' ? 'movie' : 'tv';
  const parsed = parseSeasonEpisode(req);
  if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
  const { season, episode } = parsed;
  try {
    const { getMetadata } = require('./utils/metadata');
    const meta = await getMetadata(tmdbType, tmdbId, { season, episode });
    if (!meta) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    res.json({ success: true, ...meta });
  } catch (e) {
    // Metadata is supplementary: report the failure, but never as a hard error the client must handle.
    res.status(200).json({ success: true, tmdbId, type, metadataError: e.message });
  }
});

// Episode list for a season, so a client can draw an episode picker without a second integration.
app.get('/api/metadata/:type/:tmdbId/episodes', async (req, res) => {
  const { type, tmdbId } = req.params;
  if (!['series', 'tv'].includes(type)) return res.status(400).json({ success: false, error: 'INVALID_TYPE' });
  // Season list: a single season, defaulting to 1. Strictly validated for the same reason as everywhere else.
  const seasonRaw = req.query.season === undefined || req.query.season === '' ? 1 : req.query.season;
  if (!/^\d+$/.test(String(seasonRaw).trim())) return res.status(400).json({ success: false, error: 'INVALID_SEASON' });
  const season = Number(String(seasonRaw).trim());
  if (!Number.isSafeInteger(season) || season < 1) return res.status(400).json({ success: false, error: 'INVALID_SEASON' });
  try {
    const { getDetails } = require('./utils/tmdb');
    const episodeNumbering = require('./utils/episodeNumbering');
    const anilist = require('./utils/anilist');
    // The season payload and the show's season list are both needed: the first gives the episodes, the
    // second gives the counts that place the season in the show's run.
    const [s, show, al] = await Promise.all([
      getDetails('tv', tmdbId, `season/${season}`),
      getDetails('tv', tmdbId).catch(() => null),
      anilist.getForTmdb('tv', tmdbId).catch(() => null)
    ]);
    const eps = (s && s.episodes) || [];
    const counts = episodeNumbering.countsFromSeasons(show && show.seasons);
    // Decided once for the whole season rather than per episode: every entry shares the season's scheme.
    const probe = episodeNumbering.resolveNumbering({
      episodes: eps, counts, season, episode: 1,
      anilistTotalEpisodes: al && al.episodes
    });
    res.json({
      success: true,
      tmdbId: String(tmdbId),
      season,
      seasonName: (s && s.name) || null,
      // 'absolute' when TMDB continues numbering across seasons (One Piece S21 starts at 892), 'relative'
      // when it restarts at 1 (Attack on Titan S2). A client must not assume one or the other.
      numbering: probe.seasonNumbering,
      numberingSource: probe.source,
      // The season's first episode number, i.e. its base. Only meaningful together with `numbering`.
      numberingBase: probe.numberingBase,
      totalEpisodes: probe.totalEpisodes,
      anilistTotalEpisodes: probe.anilistTotalEpisodes,
      warnings: probe.warnings,
      count: eps.length,
      episodes: eps.map((e, i) => {
        // Reuse the same resolver per entry so an irregular season still gets a per-episode answer, while
        // a uniform season takes the cheap path of offsetting the first episode's result.
        const n = probe.seasonNumbering === 'irregular'
          ? episodeNumbering.resolveNumbering({ episodes: eps, counts, season, episode: i + 1, anilistTotalEpisodes: al && al.episodes })
          : probe;
        const abs = n.absoluteEpisode == null ? null : (n === probe ? probe.absoluteEpisode + i : n.absoluteEpisode);
        return {
          season,
          episode: i + 1,                            // position is the season-relative number
          absoluteEpisode: abs,                      // the running number the stream sites use
          seasonRelativeEpisode: i + 1,
          name: e.name || null,
          overview: e.overview || null,
          airDate: e.air_date || null,
          runtime: e.runtime ?? (s.episode_run_time && s.episode_run_time[0]) ?? null,
          rating: e.vote_average ?? null,
          still: e.still_path ? `https://image.tmdb.org/t/p/w300${e.still_path}` : null
        };
      })
    });
  } catch (e) {
    res.status(200).json({ success: true, tmdbId: String(tmdbId), season, episodes: [], metadataError: e.message });
  }
});

// Restart endpoint (requires auth via session cookie on /config.html UI)
app.post('/api/restart', (req,res) => {
  const sess = getSession(req);
  if(!sess) return res.status(401).json({ success:false, error:'UNAUTHORIZED' });
  res.json({ success:true, message:'RESTARTING' });
  // Give the response a moment to flush
  setTimeout(()=>{
    try {
      const fs = require('fs');
      const restartMarker = require('path').join(process.cwd(), 'restart.trigger');
      fs.writeFileSync(restartMarker, String(Date.now()));
      console.warn('[control] wrote restart.trigger to notify nodemon');
    } catch (e) {
      console.warn('[control] failed to write restart marker:', e.message);
    }
    console.warn('[control] restarting process by exit(0)');
    // Let nodemon detect the file change and restart the app
    allowControlledExit = true;
    realProcessExit(0);
  }, 300);
});

// --- Basic informational endpoints ---
// This also reports whether the proxy layer is actually mounted, which is the one fact that silently breaks
// playback: a corrupt override file flips enableProxy off, the URLs keep coming out proxied, and every stream
// 404s in the player. The startup log line alone does not protect against that.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'tmdb-embed-api',
    time: new Date().toISOString(),
    proxy: { enabled: !!config.enableProxy, mounted: !!config.enableProxy },
    config: { overrideOk: overrideStatus().ok, overrideError: overrideStatus().error },
    // TMDB state, so "the API was slow / streams were empty" can be attributed to rate limiting instead of
    // guessed at. cooloffRemainingMs > 0 means TMDB has refused us recently and calls are being held back.
    tmdb: require('./utils/tmdb').status(),
    // How much provider work is running vs waiting. `pending` > 0 means users are queueing (intended, bounded)
    // rather than the process trying to do everything at once and stalling.
    admission: getAdmissionStatus(),
    // How late timers are actually firing. This is the honest measure of "glitchy": while this is high, every
    // timeout and deadline in the process is late by the same amount.
    eventLoop: require('./utils/eventLoopLag').status()
  });
});

// Metrics endpoint
app.get('/api/metrics', (req,res) => {
  res.json({
    uptimeSeconds: Math.round((Date.now()-metrics.startTime)/1000),
    requestsTotal: metrics.requestsTotal,
    streamRequests: metrics.streamRequests,
    providerCalls: metrics.providerCalls,
    streamsReturned: metrics.streamsReturned,
    tmdbToImdbLookups: metrics.tmdbToImdbLookups,
    lastRequestAt: metrics.lastRequestAt,
    memoryMB: Math.round(process.memoryUsage().rss/1024/1024),
    loadAvg: os.loadavg ? os.loadavg() : [],
    nodeVersion: process.version,
    configDefaults: {
      region: config.defaultRegion,
      providers: config.defaultProviders,
      minQualities: config.minQualities ? Object.keys(config.minQualities).length : 0,
      excludeCodecs: config.excludeCodecs ? Object.keys(config.excludeCodecs).filter(k=>config.excludeCodecs[k]).length : 0,
      febboxCookies: config.febboxCookies.length
    }
  });
});

// Consolidated status (metrics + providers + endpoints)
app.get('/api/status', (req,res) => {
  const endpoints = [
    'GET /api/health',
    'GET /api/metrics',
    'GET /api/status',
    'GET /api/providers',
    'GET /api/providers/:name',
    'GET /api/streams/:type/:tmdbId',
    'GET /api/streams/:provider/:type/:tmdbId',
    'POST /api/config',
    'GET /api/config'
  ];
  // Determine cookie requirement heuristically (currently Showbox / PStream)
  const cookieRequiredProviders = new Set(['showbox']);
  const providers = listProviders().map(p => {
    const cookieRequired = cookieRequiredProviders.has(p.name);
    const cookieOk = !cookieRequired || (config.febboxCookies && config.febboxCookies.length > 0);
    return { name: p.name, enabled: p.enabled, cookieRequired, cookieOk };
  });
  res.json({ success:true, providerCheckTmdbId: config.providerCheckTmdbId, metrics: {
    uptimeSeconds: Math.round((Date.now()-metrics.startTime)/1000),
    requestsTotal: metrics.requestsTotal,
    streamRequests: metrics.streamRequests,
    providerCalls: metrics.providerCalls,
    streamsReturned: metrics.streamsReturned,
    tmdbToImdbLookups: metrics.tmdbToImdbLookups,
    lastRequestAt: metrics.lastRequestAt,
    memoryMB: Math.round(process.memoryUsage().rss/1024/1024)
  }, endpoints, providers });
});

// Providers list
app.get('/api/providers', (req,res) => {
  res.json({ success: true, providers: listProviders() });
});

// Debug environment/config endpoint.
// Was open to anyone and included a slice of the selected FebBox cookie. A cookie prefix is not a usable
// credential, but there is no reason to hand one out on a route whose own comment says not to expose it
// publicly. Now a session is required, and the token preview is masked.
app.get('/api/debug/env', requireAuth, (req,res) => {
  const cookieStats = getCookieStats ? getCookieStats() : null;
  res.json({
    port: config.port,
    defaultProviders: config.defaultProviders,
    febboxCookieCount: config.febboxCookies.length,
    showboxCacheDir: process.env.SHOWBOX_CACHE_DIR || '(os tmp)',
    nodeVersion: process.version,
    cookieStats: cookieStats ? { ...cookieStats, selected: mask(cookieStats.selected) } : null
  });
});

// Single provider info
app.get('/api/providers/:name', (req,res) => {
  const p = getProvider(req.params.name);
  if (!p) return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOUND' });
  res.json({ success:true, provider:{ name: p.name, enabled: p.enabled } });
});

// Aggregate streams across all enabled providers
// Aggregate across providers.
//
// `onEvent` is what makes the live feed possible: when supplied, the handler PUSHES provider results as they
// settle instead of buffering them, and never writes to `res`. The JSON route passes nothing and gets the
// original single-response behaviour, so every existing client and test keeps working unchanged.
async function aggregateStreams(req, res, onEvent) {
  const { type, tmdbId } = req.params;
  if (!['movie','series'].includes(type)) return res.status(400).json({ success:false, error:'INVALID_TYPE' });

  const parsed = parseSeasonEpisode(req);
  if (parsed.error) return res.status(400).json({ success:false, error: parsed.error });
  const { season, episode } = parsed;

  // Deep diagnostics to debug missing title/overview for movies
  if (process.env.TMDB_DEBUG_WATCH === '1') {
    console.log('[tmdb-debug] /api/streams hit', {
      type,
      tmdbId,
      season: req.query.season,
      episode: req.query.episode,
      query: req.query,
      apiKeyPresent: !!process.env.TMDB_API_KEY,
      tmdbApiKeysPresent: !!(config && Array.isArray(config.tmdbApiKeys) && config.tmdbApiKeys.length),
    });
  }

  try {
    metrics.streamRequests++;
    const startedAt = Date.now();

    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    // The IMDb id is resolved alongside the providers rather than before them. Nothing in the provider
    // pipeline reads it from the context -- registry.createFetchFunction calls every provider with
    // (tmdbId, type, season, episode), and a provider that needs an IMDb id asks for it itself through the
    // same cached utils/tmdb lookup -- so it only has to be ready before the response body is built. Awaiting
    // it here put a TMDB round trip in front of every provider call, on every request, for nothing.
    let imdbMs = null;
    const imdbPromise = Promise.resolve()
      .then(() => resolveImdbId(tmdbType, tmdbId))
      .then(v => { imdbMs = Date.now() - startedAt; if (v) metrics.tmdbToImdbLookups++; return v; })
      .catch(() => null);

    // Title/episode metadata used to be fetched for movies only, so a series client had to call TMDB
    // itself to label anything. It is now fetched for both, from the shared service (which also folds in
    // AniList for anime), and it is cached, so after the first request this is a cache hit. It must never
    // delay the streams, so it runs in parallel with the providers and is only awaited at the end. It is also
    // what classifies every non-anime-provider stream into a tag below.
    let details = null;
    let metadataMs = null;
    const metaPromise = (async () => {
      try {
        const { getMetadata } = require('./utils/metadata');
        return await getMetadata(tmdbType, tmdbId, { season, episode });
      } catch (e) {
        if (process.env.TMDB_DEBUG_WATCH === '1') console.error('[tmdb-debug] metadata failed', e?.message || e);
        return null;
      }
    })().then(v => { metadataMs = Date.now() - startedAt; return v; });
    if (process.env.TMDB_DEBUG_WATCH === '1') {
      console.log('[tmdb-debug] /api/streams metadata requested', { type, tmdbId, season, episode });
    }

    const selectedProviders = (config.defaultProviders.length ? config.defaultProviders : listProviders().map(p=>p.name))
      // A provider proven to be serving nothing usable is skipped before it costs a request. Its
      // streams were dead on every probe, so asking again wastes latency to hand out links that 403 --
      // and its dead 4K entries sat at the top of the list looking like the best options.
      .filter(name => !linkHealth.isTripped(name));
    const providerTimings = {};
    const providerStatus = {};
    let linkCheck = null;
    // When the answer first became "enough" but had no verified 4K yet. null = not yet waiting.
    let qualityWaitStartedAt = null;

    // One slow provider must never hold up the whole response. This used to be a bare Promise.all, so the
    // aggregate was bounded by the slowest provider rather than the fastest useful one: a single stalling
    // provider turned a 5s answer into a 50s one. Each provider now gets its own deadline and reports a
    // status, so a timeout is visible instead of silently looking like "no streams".
    //
    // On top of that, each provider writes into its own slot the moment it settles, so this response can also
    // leave before the slowest one has finished (the soft deadline). `slots[i] === undefined` therefore means
    // "still working", which is exactly the 'pending' status reported below.
    const deadlineMs = Math.max(
      MIN_AGGREGATE_DEADLINE_MS,
      Math.min(Number(req.query.deadline) || DEFAULT_AGGREGATE_DEADLINE_MS, DEFAULT_PROVIDER_TIMEOUT_MS)
    );
    // AbortController for cancelling provider work when aggregate deadline fires or "enough" is reached
    const abortController = new AbortController();
    const abortSignal = abortController.signal;
    const slots = new Array(selectedProviders.length);
    const providersStartedAt = Date.now();
    // Resolved as soon as the response is already good enough to be worth returning. Checked after every
    // provider settles, so the win is realised the moment the last required provider reports.
    let signalEnough;
    const enoughPromise = new Promise(r => { signalEnough = r; });
    const t0 = Date.now();
        // Emitted the instant each provider settles, so the client can render a growing list instead of
        // staring at nothing. No-op unless the caller asked for the live feed.
        const emit = (event, data) => { if (typeof onEvent === 'function') onEvent(event, data); };
        emit('meta', { tmdbId, type, season, episode, providers: selectedProviders, startedAt: Date.now() });
        const providerTasks = selectedProviders.map(async (name, i) => {
      const prov = getProvider(name);
      if (!prov || !prov.enabled) { providerStatus[name] = 'disabled'; slots[i] = []; emit('status', { provider: name, status: 'disabled' }); return; }
      metrics.providerCalls[name] = (metrics.providerCalls[name]||0)+1;
      try {
        console.log(`[api] invoking provider ${name} for tmdbId=${tmdbId}`);
        const t0 = Date.now();
        const r = await withDeadline(
          prov.fetch({ tmdbId, type, season, episode, filters:{ } }, abortSignal),
          providerTimeoutMs(name), name
        );
        providerTimings[name] = Date.now()-t0;
        const n = Array.isArray(r) ? r.length : 0;
        providerStatus[name] = n ? 'ok' : 'empty';
        console.log(`[api] provider ${name} returned ${n} streams`);
        slots[i] = Array.isArray(r) ? r : [];
        // Enough already? Stop waiting on the rest -- UNLESS nothing above 1080p has turned up yet.
        //
        // This is the quality gate. 4khdhub is the only large 4K source and it needs ~10s (it validates a
        // dozen links), so returning the moment the stream count is met threw away every 2160p: Backrooms
        // came back at 1.4s with `Auto, 1080, 480, 360` while 4khdhub had 6× 2160p in flight. So we keep
        // waiting while the best we have is 1080p or worse, and the instant a 4K stream lands we leave
        // immediately -- showbox usually delivers 2160p at ~2.5s, which keeps this fast AND 4K instead of
        // trading one for the other. `&wait=1` still waits for everything.
        // Enough already? Stop waiting on the rest -- unless nothing above 1080p has turned up yet.
        //
        // This is the quality gate, and it is deliberately BOUNDED. 4khdhub is the only large 4K source and
        // needs ~12s (it validates a dozen links), so an unbounded gate simply waits out the whole soft
        // deadline: it restored 4K (Backrooms went from 4 streams / bestQuality 1080 to 40 streams / 8× 2160p)
        // but pushed the median from 2.2s to ~20s, and made One Piece wait 10.6s for a title with no 4K
        // anywhere. Waiting longer than this buys nothing, because the only thing still running is either
        // already known to have nothing or genuinely does not carry the title.
        //
        // `&wait=1` still waits for everything and ignores the gate entirely.
        // Push this provider's streams out now rather than making the client wait for the slowest one.
        // The raw provider output is emitted, not the enriched final shape -- enrichment (tags, episode
        // metadata, playback flags) needs the whole response and is applied in the `done` event instead.
        emit('stream', {
          provider: name,
          status: n ? 'ok' : 'empty',
          arrivalMs: Date.now() - providersStartedAt,
          count: n,
          streams: Array.isArray(r) ? r : []
        });

        // Incremental link health filtering for this provider's streams so the quality gate
        // can see verified verdicts immediately. Only direct-file streams are probed; manifests
        // are skipped and always kept. This runs bounded concurrency (PROBE_CONCURRENCY=8).
        if (config.verifyLinkHealth !== false && n > 0) {
          const providerStreams = Array.isArray(r) ? r : [];
          const checked = await linkHealth.filterDeadLinks(providerStreams, { probe: true });
          if (checked.dead) {
            console.log(`[api] ${name}: dropped ${checked.dead} dead link(s) of ${checked.checked} probed`);
          }
          // Replace the provider's slot with filtered streams
          slots[i] = checked.streams;
        }

        // Quality gate: now checks verified verdicts from cache (populated above).
        // If we have enough streams AND verified 4K, we can stop early.
        if (n > 0 && req.query.wait !== '1' && isEnough(slots, ENOUGH_STREAMS, ENOUGH_PROVIDERS)) {
          if (await hasVerifiedHighQuality(slots, { verifyDeadLinks: linkHealth })) {
            signalEnough('enough');
          } else if (qualityWaitStartedAt === null) {
            // First time the answer was good enough but nothing above 1080p had arrived. Start the clock.
            qualityWaitStartedAt = Date.now();
          } else if (Date.now() - qualityWaitStartedAt >= QUALITY_WAIT_MS) {
            console.log(`[api] quality gate held ${QUALITY_WAIT_MS}ms with no verified 4K — returning anyway`);
            signalEnough('enough');
          }
        }
      } catch (e) {
        const timedOut = e && e.name === 'TimeoutError';
        console.error(`[api] provider ${name} failed:`, e.message);
        providerTimings[name] = null;
        providerStatus[name] = timedOut ? 'timeout' : 'error';
        metrics.providerTimeouts = (metrics.providerTimeouts || 0) + (timedOut ? 1 : 0);
        slots[i] = [];
      }
    });

    // Three ways out, in order of preference: every provider settled (complete),
    // the response is already good enough (enough -- the common case now), or the soft
    // deadline passed (deadline). The first two are 'enough'/false as before; 'deadline' is the only one that
    // means we genuinely ran out of time.
    const outcome = await Promise.race([
      Promise.all(providerTasks).then(() => 'complete'),
      enoughPromise,
      new Promise(r => setTimeout(() => r('deadline'), deadlineMs))
    ]);
    const stopReason = outcome === 'complete' ? 'complete' : outcome === 'enough' ? 'enough' : 'deadline';
    const partial = stopReason !== 'complete';
    const providersMs = Date.now() - providersStartedAt;
    let pendingNames = [];
    if (partial) {
      // Slots left empty by the deadline. Cancel the in-flight provider work so we don't waste resources.
      pendingNames = selectedProviders.filter((name, i) => slots[i] === undefined && providerStatus[name] !== 'disabled');
      for (const name of pendingNames) { providerStatus[name] = 'pending'; providerTimings[name] = null; }
      console.log(`[api] aggregate stopped after ${providersMs}ms (${stopReason}); still working: ${pendingNames.join(', ') || 'none'}`);
      // Abort in-flight provider work (they should respect the signal)
      abortController.abort();
    } else {
      // All providers completed, no need to keep the signal armed
      // (AbortController will be GC'd)
    }

    let streams = slots.filter(Array.isArray).flat();
    streams = applyFilters(streams, 'aggregate', config.minQualities, config.excludeCodecs);

    // Final link health pass for any providers that completed after the deadline (pending -> settled).
    // Providers that settled before the deadline were already filtered incrementally above.
    // filterDeadLinks reads from cache, so this is fast (only probes new/unknown links).
    if (config.verifyLinkHealth !== false) {
      const checked = await linkHealth.filterDeadLinks(streams);
      if (checked.dead) {
        console.log(`[api] final pass: dropped ${checked.dead} dead link(s) of ${checked.checked} probed (${checked.cached} from cache)`);
      }
      streams = checked.streams;
      linkCheck = { checked: checked.checked, dead: checked.dead, cached: checked.cached, byProvider: checked.deadByProvider };
    }
    metrics.streamsReturned += streams.length;

    if (config.enableProxy) {
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      streams = processStreamsForProxy(streams, serverUrl);
      // Omit original headers when proxying to avoid leaking upstream requirements
      streams = streams.map(s => { if (s && typeof s === 'object') { const { headers, ...rest } = s; return rest; } return s; });
    }

    // Awaited only now: the streams are already gathered, so neither of these adds wall-clock time unless it
    // is still running (both started in parallel with the providers). The metadata wait is capped so a slow
    // metadata source can never hold a finished stream request open.
    const imdbId = await imdbPromise;
    details = await Promise.race([metaPromise, new Promise(r => setTimeout(() => r(null), 4000))]);
    const totalMs = Date.now() - startedAt;

    // Tag every stream: the anime provider's are 'anime' already (stamped in the registry, tagSource
    // 'provider'); the rest are classified through TMDB here. When TMDB has not answered, only the media type
    // can be claimed, so that is all that is written (tagSource 'request') -- an untagged stream is better than
    // a guessed one. Done after the proxy rewrite because that rebuilds each stream object.
    streams = applyTmdbTags(streams, { type, isAnime: details ? details.isAnime : undefined });
    // Give every stream the same episode metadata, from TMDB, whatever provider produced it. Replaces the
    // title with the real episode name when we have one and keeps the provider's own wording in `sourceTitle`.
    // Applied after tagging so the tag survives; runs off metadata already in hand, so it costs nothing.
    // The repeated per-episode fields are omitted by default (they are 28% of the payload and identical on
    // every stream) and are served once below as `episode`; ?perStreamMeta=1 restores the verbose shape.
    streams = enrichStreams(streams, details, { perStreamMeta: req.query.perStreamMeta === '1' });
    // Label every stream with its container and whether a browser/Roku can actually decode it. Last, so it
    // runs on the final URL after proxy rewriting -- otherwise it would classify the proxy wrapper, not the file.
    streams = streams.map(classifyForPlayback);

    // Best quality actually present in the returned streams, so "did I get 4K?" is answerable without
// eyeballing every row. Reported after link-health filtering, so it reflects something playable.
const bestQ = streams.reduce((best, s) => {
  if (!s || s.playableInBrowser === false) return best;
  const v = qualityValue(s.quality);
  return v > best.value ? { value: v, label: s.quality || null, provider: s.provider || null } : best;
}, { value: 0, label: null, provider: null });

const payload = {
      success:true,
      tmdbId,
      imdbId,
      count: streams.length,
      providerTimings,
      // 'ok' | 'empty' | 'timeout' | 'error' | 'disabled' | 'pending' per provider, so a client can tell
      // "this site has nothing" and "this site did not answer" apart from a bare 0. 'pending' additionally
      // means the soft deadline expired first: the streams are simply not in this response, so re-ask with a
      // larger ?deadline= to collect them.
      providerStatus,
      // true when this response left before every provider had answered; `pending` below names those.
      partial,
      // Why it left. 'enough' means it was already a good answer and we stopped early on purpose -- NOT a
      // timeout, and a client should not treat it as one. 'deadline' is the real "ran out of time".
      stopReason,
      // The best quality actually returned. `value` is numeric (2160 = 4K, 1080 = Full HD) so a client can
      // compare without parsing labels; `label`/`provider` say which one won.
      bestQuality: bestQ,
      // How many links were probed and dropped as dead. `dead` > 0 is normal and healthy: it means the
      // API is not handing out links that 403. `byProvider` names who, which is how a provider being down
      // is told apart from a provider simply not carrying this title.
      ...(linkCheck ? { linkCheck } : {}),
      ...(pendingNames.length ? { pending: pendingNames } : {}),
      // Wall-clock breakdown, so "the API is slow" can be answered with numbers instead of a guess.
      // imdbMs/metadataMs are counted from the start of the request, in parallel with the providers.
      timings: {
        totalMs,
        providersMs,
        imdbMs,
        metadataMs,
        deadlineMs,
        providerCount: selectedProviders.length,
        settled: selectedProviders.length - pendingNames.length
      },
      // { anime: n, tv: n, movie: n } -- a summary so a client can draw sections without walking the array.
      tagCounts: tagCounts(streams),
      streams,
      // Merged TMDB + AniList metadata, now for series as well as movies. Everything under `metadata` is
      // optional: a client should treat a missing field as unknown, never as a failure.
      ...(details ? {
        title: details.title,
        overview: details.overview,
        release_date: details.releaseDate,
        poster_path: details.poster,
        metadata: {
          title: details.title,
          originalTitle: details.originalTitle,
          alternativeTitles: details.alternativeTitles,
          overview: details.overview,
          tagline: details.tagline,
          status: details.status,
          genres: details.genres,
          year: details.year,
          runtime: details.runtime,
          isAnime: details.isAnime,
          poster: details.poster,
          backdrop: details.backdrop,
          banner: (details.anilist && details.anilist.bannerImage) || null,
          seasonCount: details.seasonCount,
          // Absolute number for the requested episode: what anime sites call it, so a client can match a
          // stream title to the right episode without recomputing anything.
          absoluteEpisode: details.absoluteEpisode ?? null,
          // How the season is numbered and whether TMDB and AniList agree; see utils/episodeNumbering.js.
          numbering: details.numbering || null,
          numberingWarning: details.numberingWarning || null,
          anilist: details.anilist || null,
          episode: details.episode || null
        }
      } : {}),
    };

    if (process.env.TMDB_DEBUG_WATCH === '1') {
      console.log('[tmdb-debug] movie payload metadata presence', {
        titlePresent: !!payload?.title,
        overviewPresent: !!payload?.overview,
        posterPathPresent: !!payload?.poster_path,
        releaseDatePresent: !!payload?.release_date,
        streamCount: payload.count,
      });
    }

    // Live feed: hand the same payload to an SSE listener when there is one, otherwise answer as JSON.
// The final event carries the COMPLETE, enriched, link-checked response -- the per-provider `stream` events
// are raw provider output, emitted early so the list fills in, and are superseded by this.
if (typeof onEvent === 'function') {
  emit('done', payload);
} else {
  res.json(payload);
}
  } catch (e) {
    metrics.lastError = e.message;
    if (typeof onEvent === 'function') onEvent('error', { success:false, error:'INTERNAL_ERROR', message:e.message });
    else res.status(500).json({ success:false, error:'INTERNAL_ERROR', message:e.message });
  }
}

// The original JSON route. Unchanged behaviour: one response after the deadline.
app.get('/api/streams/:type/:tmdbId', async (req, res) => {
  await aggregateStreams(req, res, null);
});

// Live feed. Streams arrive as each provider settles, so a client can start playing at ~2.5s on whatever has
// landed and still receive the slow 4K provider when it finishes ~10s later -- no re-request, no polling,
// nothing to miss. This is the transport the seamless quality upgrade needs.
//
// Event order: meta -> (status|stream)* -> done. `stream` events carry RAW provider output for speed; the
// final `done` carries the complete enriched, link-checked payload, which supersedes them.
app.get('/api/streams/:type/:tmdbId/live', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');      // stop any reverse proxy buffering the whole stream
  res.flushHeaders?.();

  let closed = false;
  const send = (event, data) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Comment lines stop intermediaries closing an idle connection -- 4khdhub can be silent for ~10s.
  const beat = setInterval(() => { if (!closed && !res.writableEnded) res.write(': ping\n\n'); }, 15000);

  const onClose = () => { closed = true; clearInterval(beat); };
  req.on('close', onClose);
  res.on('close', onClose);

  try {
    await aggregateStreams(req, res, (event, data) => {
      if (closed) return;
      send(event, data);
      if (event === 'done' || event === 'error') {
        // Close only after the frame has flushed, or the client loses the final payload.
        setTimeout(() => { clearInterval(beat); res.end(); }, 50);
      }
    });
  } catch (e) {
    if (!closed) { send('error', { success: false, error: 'INTERNAL_ERROR', message: e.message }); res.end(); }
    clearInterval(beat);
  }
});

// Provider-specific streams
app.get('/api/streams/:provider/:type/:tmdbId', async (req,res) => {
  const { provider, type, tmdbId } = req.params;
  if (!['movie','series'].includes(type)) return res.status(400).json({ success:false, error:'INVALID_TYPE' });
  const parsed = parseSeasonEpisode(req);
  if (parsed.error) return res.status(400).json({ success:false, error: parsed.error });
  const { season, episode } = parsed;
  const prov = getProvider(provider);
  if (!prov) return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOUND' });
  if (!prov.enabled) return res.status(503).json({ success:false, error:'PROVIDER_DISABLED' });
  // Declared out here because the timeout branch below reports it too. It was scoped inside the try, so a
  // timed-out provider threw a ReferenceError instead of returning the graceful PROVIDER_TIMEOUT body.
  let imdbId = null;
  let metaPromise = null;
  try {
    metrics.streamRequests++;
    metrics.providerCalls[prov.name] = (metrics.providerCalls[prov.name]||0)+1;
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    imdbId = await resolveImdbId(tmdbType, tmdbId); if (imdbId) metrics.tmdbToImdbLookups++;
    // Title metadata, used for two things: deciding the tag, and giving the streams the same episode name
    // and description every other route returns. season/episode are passed so the episode object is filled in.
    // Started before the provider call and awaited after it, so it costs nothing when cached (6h) and is
    // capped when not: a stream with no episode name beats a slow response.
    metaPromise = (async () => {
      try {
        const { getMetadata } = require('./utils/metadata');
        return await getMetadata(tmdbType, tmdbId, { season, episode });
      } catch { return null; }
    })();
    const t0 = Date.now();
    let streams = await withDeadline(
      prov.fetch({ tmdbId, type, season, episode, imdbId, filters:{} }),
      providerTimeoutMs(prov.name), prov.name
    );
    const providerTimings = { [prov.name]: Date.now()-t0 };
    if (!Array.isArray(streams)) streams = [];
    streams = applyFilters(streams, prov.name, config.minQualities, config.excludeCodecs);
    metrics.streamsReturned += streams.length;
    if (config.enableProxy) {
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      streams = processStreamsForProxy(streams, serverUrl);
      streams = streams.map(s => { if (s && typeof s === 'object') { const { headers, ...rest } = s; return rest; } return s; });
    }
    // Awaited here rather than before the provider call, capped so a cold metadata lookup cannot turn a
    // single-provider request into a slow one.
    const details = await Promise.race([metaPromise, new Promise(r => setTimeout(() => r(null), 2500))]);
    streams = applyTmdbTags(streams, { type, isAnime: details ? details.isAnime : undefined });
    // Same enrichment the aggregate route applies, so both endpoints describe an episode identically.
    streams = enrichStreams(streams, details, { perStreamMeta: req.query.perStreamMeta === '1' });
    // Label every stream with its container and whether a browser/Roku can actually decode it. Last, so it
    // runs on the final URL after proxy rewriting -- otherwise it would classify the proxy wrapper, not the file.
    streams = streams.map(classifyForPlayback);
    res.json({
      success:true, provider: prov.name, tmdbId, imdbId, count: streams.length, providerTimings,
      tagCounts: tagCounts(streams),
      // The per-episode facts, served once instead of repeated on every stream. Same shape the aggregate
      // route exposes as metadata.episode.
      episode: details ? {
        name: details.episode ? details.episode.name : null,
        overview: details.episode ? details.episode.overview : (details.type === 'movie' ? details.overview : null),
        still: details.episode ? details.episode.still : (details.type === 'movie' ? details.poster : null),
        airDate: details.episode ? details.episode.airDate : (details.type === 'movie' ? details.releaseDate : null),
        absoluteEpisode: details.episode ? details.episode.absoluteEpisode ?? null : null
      } : null,
      streams
    });
  } catch (e) {
    metrics.lastError = e.message;
    // A provider that ran out of time is not a server fault: report it as an empty result with a reason,
    // so a client can move on to another provider instead of treating the whole API as broken.
    if (e && e.name === 'TimeoutError') {
      metrics.providerTimeouts = (metrics.providerTimeouts || 0) + 1;
      return res.json({
        success: true, provider: prov.name, tmdbId, imdbId, count: 0, streams: [],
        error: 'PROVIDER_TIMEOUT', message: e.message
      });
    }
    res.status(500).json({ success:false, error:'INTERNAL_ERROR', message:e.message });
  }
});

const PORT = config.port;
const HOST = process.env.BIND_HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`TMDB Embed REST API listening on http://${HOST}:${PORT}`);
  if (HOST !== '192.168.86.75') {
    console.log(`Local access (if running on your machine): http://192.168.86.75:${PORT}`);
  }
  console.log('Endpoints:');
  console.log('  GET  /api/health');
  console.log('  GET  /api/metrics');
  console.log('  GET  /api/providers');
  console.log('  GET  /api/streams/:type/:id');
  console.log('  POST /api/streams/:type/:id');
  if (!config.febboxCookies || config.febboxCookies.length === 0) {
    console.warn('[startup][warning] No FEBBOX_COOKIES configured. Showbox / PStream related streams may be unavailable. Set FEBBOX_COOKIES in your environment to enable these sources.');
  }
});

server.on('error', (err)=>{ console.error('[diagnostic] server error', err); });
