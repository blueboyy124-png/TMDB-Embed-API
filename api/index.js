// Serverless entry point (Vercel, and anything else that invokes an exported (req, res) handler).
//
// Platforms like Vercel do not run `node apiServer.js`; they import a handler and call it per request.
// apiServer.js only calls app.listen() when it is the entry point, so importing it here gives us the
// fully-wired Express app without opening a port. The app is a valid (req, res) handler.
//
// Read this before deploying with this file:
//
//   * Environment variables, not the config UI. A serverless filesystem is read-only apart from
//     /tmp, so utils/user-config.json and utils/auth-users.json cannot be created or written. Set
//     TMDB_API_KEY / TMDB_API_KEYS / FEBBOX_COOKIES / DEFAULT_PROVIDERS / ENABLE_PROXY etc. in the
//     platform's dashboard instead. The admin UI and POST /api/config will report write failures.
//
//   * The proxy routes are best-effort here. /ts-proxy and /m3u8-proxy stream media back through this
//     function, and serverless platforms cap response size and execution time, so large files and
//     long programs will fail. Turn ENABLE_PROXY off to hand out direct upstream URLs, or run the
//     container image on a host that keeps a process alive (Fly.io, Railway, Render, a VPS) for the
//     full proxy feature set.
//
//   * Providers can take 20-45s to aggregate. The function's max duration (set in vercel.json) has to
//     cover that, or the client gets a platform timeout instead of `partial: true`.
//
// The container path (Dockerfile / docker-compose.yml) has none of these limits and is the
// recommended way to deploy the complete API.

module.exports = require('../apiServer');
