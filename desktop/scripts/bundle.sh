#!/bin/sh
# Wrap the built binary in a minimal .app: UNUserNotificationCenter refuses a
# process without a bundle identifier, so native notifications need this.
# Usage: scripts/bundle.sh [debug|release]   (run from desktop/)
set -eu
profile="${1:-debug}"
if [ "$profile" = release ]; then cargo build --release; else cargo build; fi
app="target/$profile/PiDesktop.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/licenses"
cp "target/$profile/pi-desktop" "$app/Contents/MacOS/pi-desktop"
# Fonts and icons are embedded in the binary; their licences ship beside it (OFL-1.1, ISC).
cp assets/licenses/* "$app/Contents/Resources/licenses/"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.pi-review-gate.desktop</string>
  <key>CFBundleName</key><string>Pi Desktop</string>
  <key>CFBundleExecutable</key><string>pi-desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$app"
echo "$app  (run: $app/Contents/MacOS/pi-desktop <cwd>)"
