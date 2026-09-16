# TMDB debugging helpers (movie name/overview + TV episodes)

## What you already proved
- `GET /api/streams/movie/:tmdbId` returns streams, but **does not include** TMDB metadata fields (`title`, `overview`, `poster_path`, `release_date`).
- The frontend uses those metadata fields from the same endpoint.

## Add request/response logging to confirm what fields are missing
Edit `TMDB-Embed-API/apiServer.js`:
1. In `app.get('/api/streams/:type/:tmdbId', ...)`:
   - Right after `const { type, tmdbId } = req.params;` add logs:
     - `console.log('[tmdb-debug] streams handler type=', type, 'tmdbId=', tmdbId, 'query=', req.query);`
2. Just before `res.json({ success:true, ... streams })`, add:
   - `console.log('[tmdb-debug] response keys=', Object.keys({success:true, tmdbId, imdbId, count: streams.length, providerTimings, streams}));`
   - and log `console.log('[tmdb-debug] hasTitle=', !!(details?.title), 'hasOverview=', !!details?.overview)` **after you add details enrichment**.

## Next: implement metadata enrichment for movies
Implement this in the movies branch of `app.get('/api/streams/:type/:tmdbId', ...)`.
- Call `utils/tmdb.js` `getDetails('movie', tmdbId)`
- Merge details fields into response.

## Validation URLs
After patching, confirm:
- Movie metadata presence:
  - `curl -s http://192.168.86.75:8787/api/streams/movie/1083381 | node -e "let j=''+process.stdin.read();"`
  - or simply check in browser/network for existence of `title/overview/poster_path/release_date`.
- TV episode list (if you later wire it):
  - `http://192.168.86.75:8787/api/info/tv/:tmdbId/season/:seasonNum`

## Frontend verification
Once metadata fields exist, `my-anime-site/app/watch/page.tsx` should stop defaulting to:
- `setAnimeTitle(data.title || 'Movie')`
- `setEpisodeTitle(data.title || 'Movie')`

