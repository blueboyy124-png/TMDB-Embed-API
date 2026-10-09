const { config } = require('../utils/config');
const { stampProviderTags } = require('../utils/streamTags');
const { requestContext, runWithRequestContext } = require('../utils/requestContext');
const { Semaphore } = require('../utils/concurrency');
const fs = require('fs');
const path = require('path');

// Process-wide cap on concurrent provider invocations.
//
// Without this, N users x ~14 providers each multiply into unbounded concurrent work. That does more than
// make things slow: providers like 4khdhub parse large HTML with cheerio, and CPU-bound parsing blocks
// Node's event loop -- which stops timers firing. Measured with 8 users, the aggregate's own 20s soft deadline
// fired 108,136ms late and six of eight users hit a 60s client timeout. The deadline could not save them
// because the loop it depends on was blocked. Capping admission keeps that loop breathing.
//
// The default sits above one request's provider count (14) so a single user is never slowed down, while still
// bounding the pile-up from many users. Override with PROVIDER_CONCURRENCY.
const providerSemaphore = new Semaphore(Number(process.env.PROVIDER_CONCURRENCY) || 28);

// Lazy load cache for providers
const providerCache = new Map();

// Function name mappings for existing providers
// Function name mappings for existing providers
const providerFunctionMap = {
  'Showbox.js': 'getStreamsFromTmdbId',
  '4khdhub.js': 'get4KHDHubStreams',
  'vidlink.js': 'getVidlinkStreams',
  'dahmermovies.js': 'getDahmermoviesStreams',
  'streamflix.js': 'getStreamflixStreams',
  'vaplayer.js': 'getVaplayerStreams',
  'castletv.js': 'getCastletvStreams',
  'netmirror.js': 'getNetmirrorStreams',
  'onetouchtv.js': 'getOnetouchtvStreams',
  'anime.js': 'getAnimeStreams',
};

// Stats for debug endpoint
let lastCookieStats = { selected: null, index: null, total: 0, remainingMB: null, timestamp: null };

async function getEffectiveCookies() {
  return Array.isArray(config.febboxCookies) ? config.febboxCookies : [];
}

// Get all provider files
function getProviderFiles() {
  const providersDir = path.join(__dirname);
  return fs.readdirSync(providersDir)
    .filter(file => file.endsWith('.js') && file !== 'registry.js')
    .map(file => ({
      name: path.parse(file).name.toLowerCase(),
      file: file,
      functionName: providerFunctionMap[file]
    }));
}

// Load a provider module
function loadProvider(providerFile) {
  if (!providerCache.has(providerFile)) {
    try {
      providerCache.set(providerFile, require(path.join(__dirname, providerFile)));
    } catch (e) {
      console.error(`Failed to load provider ${providerFile}:`, e.message);
      return null;
    }
  }
  return providerCache.get(providerFile);
}

// Create fetch function for a provider
function createFetchFunction(providerInfo) {
  return async function(ctx, signal) {
    const module = loadProvider(providerInfo.file);
    if (!module) return [];

    const funcName = providerInfo.functionName;
    if (!module[funcName]) {
      console.error(`Provider ${providerInfo.name} does not export ${funcName}`);
      return [];
    }

    try {
      const mediaType = ctx.type === 'movie' ? 'movie' : 'tv';
      const t0 = Date.now();

      let result;
      if (providerInfo.name === 'showbox') {
        // Special case for Showbox with TMDB key and cookies
        const { getTmdbApiKey } = require('../utils/tmdbKey');
        const tmdbApiKey = getTmdbApiKey();
        if (!tmdbApiKey) {
          console.warn('[registry] showbox skipped: TMDB API key missing');
          return [];
        }
        const cookies = await getEffectiveCookies();
        let selected = null;
        if (cookies.length > 0) {
          const index = Math.floor(Math.random() * cookies.length);
          selected = cookies[index];
          // Per-request context, NOT a global. Two users requesting at the same instant each get their own
          // object, so one can never observe or overwrite the other's chosen cookie. See utils/requestContext.js
          // for what this replaces and why it was a cross-user data leak.
          const rc = requestContext();
          if (rc) {
            rc.cookie = selected.startsWith('ui=') ? selected : `ui=${selected}`;
            rc.cookies = cookies.map(c => c.startsWith('ui=') ? c : `ui=${c}`);
          }
          lastCookieStats = { selected: selected.slice(0, 16) + '...', index, total: cookies.length, remainingMB: null, timestamp: Date.now() };
          console.log(`[registry] Cookie random pick index=${index} total=${cookies.length}`);
        }
        // Admitted through the process-wide semaphore so many users queue rather than thrash the event loop.
        result = await providerSemaphore.run(() =>
          module[funcName](mediaType, ctx.tmdbId, ctx.season || null, ctx.episode || null, null, selected, signal));
        const rc = requestContext();
        if (rc && rc.remainingMB != null) {
          lastCookieStats.remainingMB = rc.remainingMB;
        }
      } else {
        // Standard provider call
        result = await providerSemaphore.run(() =>
          module[funcName](ctx.tmdbId, mediaType, ctx.season || null, ctx.episode || null, signal));
      }

      const durationMs = Date.now() - t0;
      console.log(`[registry] ${providerInfo.name} fetch duration ${durationMs}ms`);

      if (!Array.isArray(result)) return [];

      // Add provider name if not present
      const named = result.map(s => ({ ...s, provider: s.provider || providerInfo.name }));
      // Tag here rather than in each route: this is the one place every provider's output passes through on
      // its way to every endpoint, so "anime.js streams are anime" cannot be forgotten by a new route.
      // The TMDB half of the classification needs the title's metadata, so it is applied by the routes.
      return stampProviderTags(named, providerInfo.name);

    } catch (e) {
      // Don't log aborted requests as errors - they're expected when the aggregate deadline fires
      if (e && e.name === 'AbortError') {
        console.log(`[registry] ${providerInfo.name} aborted`);
        return [];
      }
      console.error(`[registry] ${providerInfo.name} fetch error:`, e.message);
      return [];
    }
  };
}

// Initialize providers - always load all; enabled state is checked dynamically from live config
const providerFiles = getProviderFiles();
const providers = [];

for (const providerInfo of providerFiles) {
  providers.push({
    name: providerInfo.name,
    fetch: createFetchFunction(providerInfo)
  });
  console.log(`[registry] ${providerInfo.name} provider loaded`);
}

function isProviderEnabled(name) {
  const flag = `enable${name.charAt(0).toUpperCase() + name.slice(1)}Provider`;
  return config[flag] !== false;
}

function listProviders() { return providers.map(p => ({ name: p.name, enabled: isProviderEnabled(p.name) })); }
function getProvider(name) {
  const p = providers.find(p => p.name === name.toLowerCase());
  if (!p) return null;
  return { ...p, enabled: isProviderEnabled(p.name) };
}

function getCookieStats() { return lastCookieStats; }

// Exposed for /api/health. A non-zero `pending` here means provider work is queueing because more users
// arrived than the process admits at once -- which is the intended behaviour, and the number to look at when
// asking "is it slow because too many people, or because a provider is hanging?".
function getAdmissionStatus() { return providerSemaphore.status(); }

// --- Test hooks (scripts/verify-concurrency.mjs) ---
// Not part of the public surface. They exist so the concurrency guarantees can be asserted directly rather
// than inferred: `peekGlobalState` is what makes "no cross-user leak through a global" checkable at all.
async function __test__getWithContext(mediaType, tmdbId, season, episode, _unused, selected) {
  return runWithRequestContext(async () => {
    const prov = getProvider('showbox');
    if (!prov) return [];
    return prov.fetch({ tmdbId, type: mediaType === 'movie' ? 'movie' : 'series', season, episode, imdbId: null, filters: {} });
  });
}
function __test__peekGlobalState() {
  return {
    currentRequestConfig: global.currentRequestConfig,
    currentRequestUserCookie: global.currentRequestUserCookie,
    currentRequestUserCookieRemainingMB: global.currentRequestUserCookieRemainingMB,
    currentRequestRegionPreference: global.currentRequestRegionPreference
  };
}

module.exports = { listProviders, getProvider, getCookieStats, getAdmissionStatus, __test__getWithContext, __test__peekGlobalState };