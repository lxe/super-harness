#!/usr/bin/env bash
# Unlocks login keychain in this session, signs, installs, and launches SuperHarness on a physical iPhone.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
UDID="${1:-${SH_DEVICE_UDID:-}}"
if [ -z "$UDID" ]; then
  UDID=$(xcrun xctrace list devices 2>/dev/null | grep -E "iPhone.*\([0-9A-F-]+\)$" | grep -v Simulator | head -n 1 | sed -E 's/.*\(([0-9A-F-]+)\)$/\1/' || true)
fi
if [ -z "$UDID" ]; then
  echo "No connected physical iPhone detected. Pass UDID as first argument or set SH_DEVICE_UDID." >&2
  exit 1
fi
HOST_URL="${SH_HOST_URL:-http://100.64.0.10:47890}"
TOKEN="${SH_BEARER_TOKEN:-}"

echo "Unlocking macOS login keychain for codesign..."
security unlock-keychain ~/Library/Keychains/login.keychain-db

cd "$(dirname "$0")/.."
echo "Building and signing SuperHarness for device $UDID..."
xcodebuild -project SuperHarness.xcodeproj \
  -scheme SuperHarness \
  -configuration Debug \
  -destination "id=$UDID" \
  -derivedDataPath /tmp/sh-ios-device-dd \
  -allowProvisioningUpdates \
  build

APP_PATH="/tmp/sh-ios-device-dd/Build/Products/Debug-iphoneos/SuperHarness.app"
echo "Installing $APP_PATH onto $UDID..."
xcrun devicectl device install app --device "$UDID" "$APP_PATH"

if [ -n "$TOKEN" ]; then
  ENV_JSON=$(python3 -c 'import json, sys; print(json.dumps({"SH_HOST_URL": sys.argv[1], "SH_BEARER_TOKEN": sys.argv[2], "SH_CONNECTION_MODE": "live"}))' "$HOST_URL" "$TOKEN")
  echo "Launching SuperHarness pre-paired with $HOST_URL..."
  xcrun devicectl device process launch --device "$UDID" -e "$ENV_JSON" --terminate-existing com.lxe.superharness
else
  echo "Launching SuperHarness..."
  xcrun devicectl device process launch --device "$UDID" --terminate-existing com.lxe.superharness
fi
