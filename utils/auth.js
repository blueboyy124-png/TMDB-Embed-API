const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Path for auth users file
const AUTH_FILE = path.join(process.cwd(), 'utils/auth-users.json');

// In-memory cache
let usersCache = null;
let lastLoaded = 0;
const LOAD_INTERVAL_MS = 30 * 1000; // reload at most every 30s

// Credentials can be supplied by the environment for hosts that cannot write files (serverless, some
// container platforms). Without this, the read-only filesystem meant ensureAuthFile() threw on the very
// first login and the API was unusable: no file, no in-memory user, 500 on /auth/login.
//   AUTH_USERS       JSON array of { username, hash } -- hash is the same "<salt>:<derived>" form the file uses
//   ADMIN_USERNAME + ADMIN_PASSWORD  a single user, hashed on load
//
// Resolved once per process: hashing the ADMIN_PASSWORD costs a PBKDF2 run, and this is read on every
// login attempt, so it must not re-hash each time.
let envUsersResolved = false;
let envUsersCache = null;
function envUsers() {
  if (envUsersResolved) return envUsersCache;
  envUsersResolved = true;
  if (process.env.AUTH_USERS) {
    try {
      const parsed = JSON.parse(process.env.AUTH_USERS);
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.users;
      const valid = (Array.isArray(list) ? list : []).filter(u => u && u.username && u.hash);
      if (valid.length) { envUsersCache = valid; return envUsersCache; }
      console.warn('[auth] AUTH_USERS is set but contains no usable { username, hash } entries');
    } catch (e) {
      console.warn('[auth] AUTH_USERS is not valid JSON:', e.message);
    }
  }
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    envUsersCache = [{ username: process.env.ADMIN_USERNAME, hash: hashPassword(process.env.ADMIN_PASSWORD).hash }];
    return envUsersCache;
  }
  return null;
}

let warnedDefaultPassword = false;
function defaultUsers() {
  if (!warnedDefaultPassword) {
    console.warn('[auth] Using default credentials "admin" / "change-me". CHANGE THE PASSWORD IMMEDIATELY (or set ADMIN_USERNAME/ADMIN_PASSWORD).');
    warnedDefaultPassword = true;
  }
  return [{ username: 'admin', hash: hashPassword('change-me').hash }];
}

function ensureAuthFile() {
  if (fs.existsSync(AUTH_FILE)) return;
  if (envUsers()) return; // credentials come from the environment; nothing to persist
  const data = {
    info: 'Initial default credentials. CHANGE THE PASSWORD IMMEDIATELY using /auth/change-password after logging in.',
    users: defaultUsers()
  };
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
    console.warn('[auth] Created default auth-users.json with username "admin" and password "change-me". CHANGE IT NOW.');
  } catch (e) {
    // Read-only or ephemeral filesystem (serverless, locked-down container). Keep the default user in
    // memory so the process still starts and can be logged into; it simply will not survive a restart.
    console.warn(`[auth] Could not write auth-users.json (${e.message}); using the default admin user in memory only. Set ADMIN_USERNAME/ADMIN_PASSWORD or AUTH_USERS on this host.`);
  }
}

function loadUsers(force=false){
  const fromEnv = envUsers();
  if (fromEnv) { usersCache = fromEnv; lastLoaded = Date.now(); return usersCache; }
  if (!force && usersCache && (Date.now() - lastLoaded) < LOAD_INTERVAL_MS) return usersCache;
  ensureAuthFile();
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    usersCache = Array.isArray(parsed.users) ? parsed.users : [];
    lastLoaded = Date.now();
  } catch (e) {
    console.error('[auth] Failed loading users file:', e.message);
    // Fall back to the in-memory default rather than zero users, which would lock everyone out.
    usersCache = defaultUsers();
    lastLoaded = Date.now();
  }
  return usersCache;
}

function hashPassword(password, salt){
  salt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash: `${salt}:${derived}`, salt };
}

function verifyPassword(password, stored){
  if (!stored || !stored.includes(':')) return false;
  const [salt, derived] = stored.split(':');
  const test = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived,'hex'), Buffer.from(test,'hex'));
}

function findUser(username){
  return loadUsers().find(u => u.username === username);
}

function updatePassword(username, newPassword){
  const users = loadUsers(true);
  const u = users.find(x => x.username === username);
  if (!u) return false;
  u.hash = hashPassword(newPassword).hash;
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify({ users }, null, 2));
    usersCache = users;
    lastLoaded = Date.now();
    return true;
  } catch (e) {
    console.error('[auth] Failed writing updated password:', e.message);
    return false;
  }
}

// Session issuance & validation
const SESSION_SECRET = crypto.randomBytes(32); // ephemeral; restart invalidates sessions
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function base64url(input){
  return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function sign(payloadB64){
  return base64url(crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest());
}

function issueSession(username){
  const payload = { u: username, exp: Date.now() + SESSION_TTL_MS };
  const payloadB64 = base64url(JSON.stringify(payload));
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

function parseCookies(req){
  const h = req.headers.cookie; if (!h) return {};
  return h.split(';').map(v=>v.trim()).reduce((acc, part)=>{ const eq = part.indexOf('='); if(eq>0){ acc[part.slice(0,eq)] = decodeURIComponent(part.slice(eq+1)); } return acc; },{});
}

function validateSessionToken(token){
  if (!token || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (sign(payloadB64) !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'));
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function authenticate(username, password){
  const user = findUser(username);
  if (!user) return false;
  return verifyPassword(password, user.hash);
}

function getSession(req){
  const cookies = parseCookies(req);
  if (!cookies.session) return null;
  return validateSessionToken(cookies.session);
}

function requireAuth(req, res, next){
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ success:false, error:'AUTH_REQUIRED' });
  req.session = sess;
  next();
}

module.exports = {
  loadUsers,
  authenticate,
  issueSession,
  requireAuth,
  getSession,
  updatePassword,
  AUTH_FILE
};
