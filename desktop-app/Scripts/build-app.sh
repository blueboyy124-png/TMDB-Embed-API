#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."

# Keep the fallback UI separate from the website source while making every app build include
# the current normal streamer UI. The app never writes back to public/streamer.
rm -rf Sources/StreamShelf/Resources/streamer
mkdir -p Sources/StreamShelf/Resources/streamer
# Runtime credentials are deliberately not part of the desktop fallback bundle.
rsync -a --delete --exclude 'supabase-config.js' ../public/streamer/ Sources/StreamShelf/Resources/streamer/
swift build -c release

BIN_DIR="$(swift build -c release --show-bin-path)"
APP="build/StreamShelf.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/StreamShelf" "$APP/Contents/MacOS/StreamShelf"
cp -R "$BIN_DIR/StreamShelf_StreamShelf.bundle" "$APP/Contents/Resources/"
cp AppResources/Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - "$APP" 2>/dev/null || true
echo "Built: $APP"
