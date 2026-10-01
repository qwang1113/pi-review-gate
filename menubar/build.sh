#!/usr/bin/env bash
#
# BUILD THE MENU BAR APP — one `swiftc` invocation, no Xcode project.
#
# What it does, in order:
#   1. compiles menubar/Sources/*.swift into a real .app bundle
#      (menubar/build/PiGate.app — `LSUIElement`, so it lives in the menu bar
#      and never in the Dock);
#   2. bakes the ABSOLUTE path of `node` into Info.plist. A Finder-launched app
#      gets a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so `env node`
#      would not find an nvm or Homebrew node — the app needs to be told.
#      Rebuild after moving node;
#   3. ad-hoc code-signs it (`codesign -s -`). No Developer ID, no notarization,
#      no Apple account: local use. macOS still asks for confirmation the first
#      time a downloaded-or-copied bundle runs — see docs/daemon/README.md.
#
# Usage:  bash menubar/build.sh          # build (or rebuild)
#         bash menubar/build.sh --run    # build, then launch it
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${HERE}/build"
APP="${OUT}/PiGate.app"
SOURCES="${HERE}/Sources"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "找不到 swiftc —— 装 Xcode Command Line Tools：xcode-select --install" >&2
  exit 1
fi

NODE_PATH_ABS="$(command -v node || true)"
if [ -z "${NODE_PATH_ABS}" ]; then
  echo "找不到 node —— app 用它执行 pi-gate daemon start/stop；装好 node 再重建。" >&2
fi

ARCH="$(uname -m)"
mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"

echo "编译 ${SOURCES}/*.swift → ${APP}"
swiftc -O \
  -target "${ARCH}-apple-macos13.0" \
  -o "${APP}/Contents/MacOS/PiGate" \
  "${SOURCES}"/*.swift

cat > "${APP}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>pi-gate</string>
  <key>CFBundleDisplayName</key>
  <string>pi-gate</string>
  <key>CFBundleIdentifier</key>
  <string>com.pi.review-gate.menubar</string>
  <key>CFBundleExecutable</key>
  <string>PiGate</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.2.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <!-- menu bar only: no Dock icon, no main window -->
  <key>LSUIElement</key>
  <true/>
  <!-- the node this build was made against; the app falls back to the usual
       install locations when it is missing -->
  <key>PiGateNodePath</key>
  <string>${NODE_PATH_ABS}</string>
</dict>
</plist>
PLIST

# A LOCAL bundle still needs a signature for UNUserNotificationCenter to be
# willing to deliver: ad-hoc (`-`) is enough, and needs no certificate.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "${APP}" >/dev/null 2>&1 \
    && echo "已临时签名（ad-hoc）" \
    || echo "警告：ad-hoc 签名失败 —— 菜单栏仍能用，但系统通知可能投递不了" >&2
fi

echo
echo "构建完成：${APP}"
echo "启动：open '${APP}'"
echo "（首次打开若被拦下：系统设置 → 隐私与安全性 → 「仍要打开」；这是本地 ad-hoc 签名，不是公证过的分发包。）"

if [ "${1:-}" = "--run" ]; then
  open "${APP}"
fi
