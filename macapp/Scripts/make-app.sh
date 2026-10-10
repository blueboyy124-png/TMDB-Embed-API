#!/bin/zsh
# Builds MacStream.app — a real Dock app bundle (icon, pinnable, single window) — from the
# SwiftPM build, without Xcode. Installs to /Applications (falls back to ~/Applications).
#
#   ./Scripts/make-app.sh            # release build + bundle + install
#   ./Scripts/make-app.sh --no-install   # build the bundle only
set -euo pipefail
cd "$(dirname "$0")/.."   # macapp/

echo "==> swift build -c release"
swift build -c release

APP="build/MacStream.app"
BIN="$(swift build -c release --show-bin-path)/MacStreamApp"
echo "==> bundling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/MacStream"
echo -n 'APPL????' > "$APP/Contents/PkgInfo"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
            <string>MacStream</string>
    <key>CFBundleDisplayName</key>
    <string>MacStream</string>
    <key>CFBundleIdentifier</key>
    <string>local.macstream</string>
    <key>CFBundleExecutable</key>
    <string>MacStream</string>
    <key>CFBundleIconFile</key>
    <string>MacStream</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.entertainment</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <key>NSSupportsSuddenTermination</key>
    <false/>
    <key>NSSupportsAutomaticTermination</key>
    <false/>
</dict>
</plist>
PLIST

echo "==> icon"
ICONSET="build/MacStream.iconset"
rm -rf "$ICONSET"
swift Scripts/make-icon.swift "$ICONSET"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/MacStream.icns"
rm -rf "$ICONSET"

echo "==> ad-hoc sign"
codesign --force --sign - "$APP" 2>/dev/null || true

plutil -lint "$APP/Contents/Info.plist" >/dev/null

if [[ "${1:-}" == "--no-install" ]]; then
    echo "built: $APP"
    exit 0
fi

DEST=""
if [[ -w /Applications ]]; then
    DEST="/Applications"
elif [[ -d "$HOME/Applications" && -w "$HOME/Applications" ]]; then
    DEST="$HOME/Applications"
fi

if [[ -n "$DEST" ]]; then
    rm -rf "$DEST/MacStream.app"
    cp -R "$APP" "$DEST/"
    echo "installed: $DEST/MacStream.app"
else
    echo "no writable Applications dir — bundle left at $APP"
fi

echo "done: open '$DEST/MacStream.app' (or $APP)"
