# StreamShelf desktop wrapper

`StreamShelf` is a separate macOS wrapper. It does not change the browser website or add
desktop controls to `public/streamer`. It bundles the normal streamer UI, mirrors updates
from `http://127.0.0.1:8787` while the API is running, and keeps completed direct-file
downloads in Application Support.

Build the app from this folder:

```sh
./Scripts/build-app.sh
```

Run `npm start` in the parent API project first for browsing, UI updates, and new downloads.
Without it, the wrapper loads its cached/bundled UI and exposes completed downloads.

Only direct, authorized, non-DRM files are saved in this first implementation. HLS URLs are
reported as unsupported rather than producing a corrupt offline item.
