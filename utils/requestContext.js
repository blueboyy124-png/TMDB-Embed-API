/* Per-request state, isolated from every other request in the process.
 *
 * Why this exists: the showbox provider used to keep its state on `global.currentRequestConfig` -- ONE slot
 * for the whole process. With a single user that looked fine. With two users, request B's cookie selection
 * overwrote request A's mid-flight, so A could build its FebBox calls with B's cookie. Two related globals
 * (`currentRequestUserCookie`, `currentRequestUserCookieRemainingMB`) were written by the provider and never
 * cleared at all, so a cookie picked for one user stayed readable by every later request. That is a
 * cross-user data leak, not just a glitch.
 *
 * AsyncLocalStorage fixes the class of bug rather than this one instance: each request runs inside its own
 * async context, so `requestContext()` returns that request's object and nobody else's, no matter how many
 * requests interleave. Nothing has to be cleaned up by hand, because the context is discarded with the
 * request -- a "forgot to reset in an error path" bug is no longer possible.
 *
 * Outside a request (scripts, tests, a direct provider call) there is simply no context, and every caller
 * already handles that by falling back to its own defaults.
 */

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

// Fields are intentionally flat and few. Each is documented because showbox.js reads them by name.
function createRequestContext() {
  return {
    // The single FebBox cookie chosen for this request, already prefixed with 'ui='.
    cookie: null,
    // Every configured cookie, each prefixed, for quota-aware selection.
    cookies: null,
    // Quota-aware selection caches its pick here so the rest of the cycle reuses it.
    chosenFebboxBaseCookieForRequest: null,
    // The winning cookie after quota selection.
    userCookie: null,
    // Remaining quota on the winning cookie, surfaced in /api/debug/env.
    remainingMB: null,
    // Which FebBox region this request actually used, and whether that was a fallback. Also per-request:
    // as globals, one user's fallback was read by the next user's request.
    lastRequestedRegion: null,
    usedRegionFallback: null
  };
}

// Runs `fn` with a fresh context. Everything awaited inside keeps access to it.
function runWithRequestContext(fn) {
  return storage.run(createRequestContext(), fn);
}

// The current request's context, or null when there isn't one. Never returns another request's state.
function requestContext() {
  return storage.getStore() || null;
}

module.exports = { runWithRequestContext, requestContext, createRequestContext };
