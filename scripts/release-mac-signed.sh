#!/usr/bin/env bash
# Builds the macOS installers signed with a Developer ID certificate and notarized by Apple,
# so macOS opens them without a Gatekeeper warning. CI builds are unsigned; run this on a Mac
# that has the certificate in its keychain, then upload release/*.dmg and release/*.zip to the
# GitHub release in place of the CI-built Mac files.
#
# Needs in the environment:
#   APPLE_API_KEY      path to an App Store Connect API key (.p8)
#   APPLE_API_KEY_ID   its key id
#   APPLE_API_ISSUER   its issuer id
# Optional: CSC_NAME, the certificate's name without the "Developer ID Application: " prefix.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${APPLE_API_KEY:?set APPLE_API_KEY}" "${APPLE_API_KEY_ID:?set APPLE_API_KEY_ID}" "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"
ENT="$PWD/resources/entitlements.mac.plist"
npm run build
npx electron-builder --mac --publish never \
  -c.mac.hardenedRuntime=true \
  -c.mac.entitlements="$ENT" \
  -c.mac.entitlementsInherit="$ENT" \
  -c.mac.notarize=true \
  "-c.mac.extendInfo.NSMicrophoneUsageDescription=Superharness records voice dictation and transcribes it on your own dictation server."
for dmg in release/*.dmg; do
  echo "$dmg"
done
shasum -a 256 release/*.dmg release/*.zip
