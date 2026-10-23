# Project structure

`TMDB-Embed-API` is the server and web UI. `macapp/` is the native macOS client. `scripts/` holds
verification and one-off debug tooling. Generated output is ignored and can be deleted at any time.

## Entry points

| Path | What it is |
| --- | --- |
| `apiServer.js` | Express app. Starts listening on `API_PORT` (default `8787`) only when run directly. |
| `api/index.js` | Serverless adapter (Vercel). Imports the app without opening a port. |
| `vercel.json` | Rewrites and the function duration cap. |
| `Dockerfile`, `docker-compose.yml` | Container build/run. |

## Server

| Path | Responsibility |
| --- | --- |
| `providers/` | One module per source. `providers/registry.js` maps provider names to functions; add new providers there. |
| `proxy/proxyServer.js` | `/ts-proxy`, `/m3u8-proxy`, `/sub-proxy`; playlist rewriting, range handling, caches. |
| `utils/` | Config, auth, AniList/cour mapping, episode numbering, link health, stream metadata, `anixoAgent.js`. |
| `public/` | Admin panel and browser player. `public/streamer/` is the current UI; `public/test-player.html` is the playback harness. |
| `public/dev/` | One-off debug pages. Not linked from the main UI. |
| `docs/` | Design notes and handoff docs. |
| `macapp/` | SwiftUI macOS app. `macapp/.build/` and `macapp/build/` are generated. |
| `scripts/` | `verify-*.mjs` suites wired to `npm run verify:*`; build helpers. |
| `scripts/debug/` | Manual diagnostics (run by hand, not part of CI). |

## Where to change what

| Change | Start here |
| --- | --- |
| Add or fix a stream source | `providers/<name>.js` + `providers/registry.js` |
| Playback/proxy behaviour | `proxy/proxyServer.js` |
| Browser UI | `public/streamer/` |
| Native app | `macapp/Sources/MacStreamApp/` |
| Season/episode mapping | `utils/anilist.js`, `utils/episodeNumbering.js` |
| Configuration/defaults | `utils/config.js`, `.env.example` |
| Stream classification | `utils/streamMeta.js` |

## Generated and ignored

`node_modules/`, `providers/.cache/`, `macapp/.build/`, `macapp/build/`, `.env`,
`restart.trigger`, `*.log`, `.verify/`. Do not commit runtime config that contains secrets.

## Common commands

```bash
npm start                 # nodemon, restarts when restart.trigger changes
node apiServer.js         # single run
npm run verify:unit       # fast unit suites
npm run verify            # unit + security + live stream/player suites
npm run macapp:build      # swift build
npm run macapp:run        # swift run
```
