'use strict';

// Where the API believes it is reachable from.
//
// Every absolute URL the API hands out -- the `/m3u8-proxy` and `/ts-proxy` rewrites, and the segment
// URLs the playlist proxy writes back into an m3u8 -- has to point at the host the CLIENT used, not at
// whatever Host header happened to reach the Node process. On a laptop those are the same thing. Behind a
// reverse proxy, a load balancer, a tunnel (ngrok / Cloudflare) or a hosting platform (Vercel, Fly,
// Railway, Render) they are not: the edge terminates TLS and forwards to an internal address, so a URL
// built from the internal request sends the player to a host only the server can reach. This is the one
// helper that decides, and everywhere that used to inline `${req.protocol}://${req.get('host')}` goes
// through it instead.
//
// Resolution order, first match wins:
//   1. PUBLIC_BASE_URL / PUBLIC_URL / API_BASE_URL
//        Explicit. Use it for a custom domain, and it is the only way to serve the API under a path
//        (https://example.com/tmdb-api) rather than at the root.
//   2. X-Forwarded-Proto + (X-Forwarded-Host | Host) and the RFC 7239 `Forwarded` header
//        What the edge saw. `trust proxy` is on, so Express already resolves req.protocol from these,
//        but reading the headers directly keeps this correct even if that setting is turned off.
//   3. req.protocol + req.get('host')
//        A direct connection or local development -- no proxy involved.
//   4. http://localhost:<port>
//        No request in hand (startup banner, tooling).

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

// X-Forwarded-* headers accumulate as "client, proxy1, proxy2"; the leftmost entry is the closest to the
// client, which is the one we want. `Forwarded` is a single header that may carry several comma-separated
// elements with `proto=`/`host=` parameters -- parsed just far enough to pull those out.
function firstForwardedValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).split(',')[0].trim();
}

function fromForwardedHeader(header) {
  const first = firstForwardedValue(header);
  if (!first) return {};
  const out = {};
  for (const part of first.split(';')) {
    const [rawKey, ...rest] = part.split('=');
    const key = String(rawKey || '').trim().toLowerCase();
    const val = rest.join('=').trim().replace(/^"|"$/g, '');
    if (!val) continue;
    if (key === 'proto') out.proto = val;
    else if (key === 'host') out.host = val;
  }
  return out;
}

function envBaseUrl() {
  return stripTrailingSlash(
    process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || process.env.API_BASE_URL || ''
  );
}

function defaultPort() {
  return Number(process.env.API_PORT || process.env.PORT) || 8787;
}

// The externally reachable base URL for a request, without a trailing slash.
function baseUrlFromRequest(req) {
  const override = envBaseUrl();
  if (override) return override;

  if (req && req.headers) {
    const forwarded = fromForwardedHeader(req.headers.forwarded);
    const proto = firstForwardedValue(req.headers['x-forwarded-proto'])
      || forwarded.proto
      || req.protocol
      || 'http';
    const host = firstForwardedValue(req.headers['x-forwarded-host'])
      || forwarded.host
      || (typeof req.get === 'function' ? req.get('host') : null)
      || req.headers.host;
    if (host) return `${proto}://${host}`;
  }

  return `http://localhost:${defaultPort()}`;
}

// Same answer, but for code paths with no request (banners, logs). Honours the explicit env override and
// otherwise falls back to the conventional local address.
function baseUrlFromConfig() {
  const override = envBaseUrl();
  if (override) return override;
  return `http://localhost:${defaultPort()}`;
}

module.exports = { baseUrlFromRequest, baseUrlFromConfig, stripTrailingSlash };
