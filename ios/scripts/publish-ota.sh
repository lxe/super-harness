#!/usr/bin/env bash
# Builds, signs (Ad-Hoc Release by default), and packages an iOS OTA bundle
# (SuperHarness.ipa + manifest.plist + index.html + icons) for HTTPS itms-services:// install
# (e.g. over Tailscale Serve HTTPS while away on 5G/cellular).
#
# Usage:
#   ./ios/scripts/publish-ota.sh <https-base-url> [ad-hoc|development]
# Example:
#   ./ios/scripts/publish-ota.sh https://my-host.tailnet.ts.net:8451
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

BASE_URL="${1:-${SH_OTA_BASE_URL:-}}"
METHOD="${2:-${SH_OTA_METHOD:-ad-hoc}}"
OUT_DIR="${SH_OTA_OUT_DIR:-/tmp/sh-ota-out}"

if [ -z "$BASE_URL" ]; then
  echo "Usage: $0 <https-base-url> [ad-hoc|development]" >&2
  exit 1
fi
BASE_URL="${BASE_URL%/}"

if [[ "$BASE_URL" != https://* ]]; then
  echo "Error: iOS OTA installs require an https:// URL (got: $BASE_URL)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$IOS_DIR/.." && pwd)"

TEAM_ID="${SH_DEVELOPMENT_TEAM:-$(grep -m1 'DEVELOPMENT_TEAM:' "$IOS_DIR/project.yml" | awk '{print $2}' | tr -d '"')}"
BUNDLE_ID="${SH_BUNDLE_ID:-$(grep -m1 'PRODUCT_BUNDLE_IDENTIFIER:' "$IOS_DIR/project.yml" | awk '{print $2}' | tr -d '"')}"
VERSION="${SH_MARKETING_VERSION:-$(grep -m1 'MARKETING_VERSION:' "$IOS_DIR/project.yml" | awk '{print $2}' | tr -d '"')}"
GIT_SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo 'local')"
BUILD_TS="$(date +%Y%m%d-%H%M%S)"
# A fresh build number per install: iOS caches the app icon (home screen and push
# notifications) per build, so a constant CFBundleVersion keeps showing a stale icon.
BUILD_NUMBER="${SH_BUILD_NUMBER:-$(date +%Y%m%d%H%M)}"
BUILD_HUMAN="$(date '+%b %d, %Y %I:%M %p %Z')"
CONFIG="Release"
if [ "$METHOD" = "development" ]; then
  CONFIG="Debug"
fi

echo "Unlocking macOS login keychain for codesign..."
security unlock-keychain ~/Library/Keychains/login.keychain-db

ARCHIVE="/tmp/sh-ota-SuperHarness.xcarchive"
EXPORT="/tmp/sh-ota-export"
EXPORT_PLIST="/tmp/sh-ota-export-options.plist"
rm -rf "$ARCHIVE" "$EXPORT" "$OUT_DIR"
mkdir -p "$OUT_DIR"

cat > "$EXPORT_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${METHOD}</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>${TEAM_ID}</string>
  <key>compileBitcode</key>
  <false/>
  <key>thinning</key>
  <string>&lt;none&gt;</string>
</dict>
</plist>
PLIST

cd "$IOS_DIR"
echo "Archiving SuperHarness (${CONFIG}, ${METHOD}, commit ${GIT_SHA})..."
xcodebuild archive \
  -project SuperHarness.xcodeproj \
  -scheme SuperHarness \
  -configuration "$CONFIG" \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  -quiet

echo "Exporting signed IPA (${METHOD})..."
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates \
  -quiet

IPA_SRC="$(find "$EXPORT" -maxdepth 1 -name '*.ipa' | head -n 1)"
if [ -z "$IPA_SRC" ] || [ ! -f "$IPA_SRC" ]; then
  echo "Export succeeded but no .ipa was found in $EXPORT" >&2
  exit 1
fi

cp "$IPA_SRC" "$OUT_DIR/SuperHarness.ipa"
IPA_SIZE="$(du -h "$OUT_DIR/SuperHarness.ipa" | awk '{print $1}')"

# Prepare OTA icons from AppIcon-1024.png if available
ICON_SRC="$IOS_DIR/SuperHarness/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
if [ -f "$ICON_SRC" ] && command -v sips >/dev/null 2>&1; then
  sips -z 57 57 "$ICON_SRC" --out "$OUT_DIR/icon-57.png" >/dev/null 2>&1 || true
  sips -z 512 512 "$ICON_SRC" --out "$OUT_DIR/icon-512.png" >/dev/null 2>&1 || true
fi

CACHE_BUST="${GIT_SHA}-${BUILD_TS}"
IPA_URL="${BASE_URL}/SuperHarness.ipa?v=${CACHE_BUST}"
MANIFEST_URL="${BASE_URL}/manifest.plist?v=${CACHE_BUST}"
ENCODED_MANIFEST_URL="$(python3 -c 'import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$MANIFEST_URL")"
ITMS_LINK="itms-services://?action=download-manifest&url=${ENCODED_MANIFEST_URL}"

cat > "$OUT_DIR/manifest.plist" << MANIFEST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${IPA_URL}</string>
        </dict>
        <dict>
          <key>kind</key>
          <string>display-image</string>
          <key>url</key>
          <string>${BASE_URL}/icon-57.png</string>
        </dict>
        <dict>
          <key>kind</key>
          <string>full-size-image</string>
          <key>url</key>
          <string>${BASE_URL}/icon-512.png</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${BUNDLE_ID}</string>
        <key>bundle-version</key>
        <string>${VERSION}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>Super Harness</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
MANIFEST

cat > "$OUT_DIR/index.html" << HTML
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Install Super Harness</title>
  <meta name="theme-color" content="#16171b">
  <link rel="icon" type="image/png" href="icon-512.png">
  <link rel="apple-touch-icon" href="icon-512.png">
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100dvh; display: grid; place-items: center;
      background: #16171b; color: #f1f2f5;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      padding: 24px;
    }
    .card {
      width: 100%; max-width: 360px; background: #1c1e24;
      border-radius: 28px; padding: 32px 24px 26px; text-align: center;
      box-shadow: 0 1px 2px rgba(0,0,0,0.28), 0 2px 5px rgba(0,0,0,0.16),
        inset 0 1px 0 rgba(255,255,255,0.045);
    }
    .icon {
      width: 88px; height: 88px; border-radius: 22.4%; margin: 0 auto 18px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.32), 0 3px 8px rgba(0,0,0,0.22); display: block;
    }
    h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
    .meta { color: #9a9ea8; font-size: 13px; margin: 0 0 22px; line-height: 1.5; }
    .pill {
      display: inline-block; padding: 3px 9px; border-radius: 999px;
      background: rgba(255,255,255,0.08); color: #c9ccd4;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    }
    .btn {
      display: block; width: 100%; box-sizing: border-box;
      padding: 15px 18px; border-radius: 16px; text-decoration: none;
      background: #e4e6ec; color: #16171b; font-weight: 650; font-size: 16px;
    }
    .note { margin: 16px 0 0; color: #7c808b; font-size: 12px; line-height: 1.45; }
  </style>
</head>
<body>
  <main class="card">
    <img class="icon" src="icon-512.png" alt="Super Harness">
    <h1>Super Harness</h1>
    <p class="meta">
      <span class="pill">${GIT_SHA}</span> · v${VERSION} · ${IPA_SIZE}<br>
      Built ${BUILD_HUMAN} (${METHOD})
    </p>
    <a class="btn" href="${ITMS_LINK}">Install on iPhone</a>
    <p class="note">Open in Safari over Tailscale. Tap Install, then return to the Home Screen to watch progress.</p>
  </main>
</body>
</html>
HTML

echo "OTA bundle ready in $OUT_DIR (SuperHarness.ipa = ${IPA_SIZE}, commit ${GIT_SHA})"
