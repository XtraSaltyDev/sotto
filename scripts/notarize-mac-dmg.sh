#!/usr/bin/env bash
# Notarize and staple the finished DMG after Forge has signed, notarized, and
# stapled the app bundle that the DMG contains.
set -euo pipefail

cd "$(dirname "$0")/.."

identity="${SOTTO_MAC_SIGNING_IDENTITY:-}"
profile="${SOTTO_MAC_NOTARY_KEYCHAIN_PROFILE:-}"
version="$(node -p "require('./package.json').version")"
dmg="out/make/Sotto-${version}-arm64.dmg"

[[ "$identity" == Developer\ ID\ Application:* ]] || {
  printf 'SOTTO_MAC_SIGNING_IDENTITY must be a Developer ID Application identity.\n' >&2
  exit 1
}
[[ -n "$profile" ]] || {
  printf 'SOTTO_MAC_NOTARY_KEYCHAIN_PROFILE is required.\n' >&2
  exit 1
}
[[ -s "$dmg" ]] || {
  printf 'Missing release DMG: %s\n' "$dmg" >&2
  exit 1
}

/usr/bin/codesign --verify --strict --verbose=2 "$dmg"
/usr/bin/xcrun notarytool submit "$dmg" \
  --keychain-profile "$profile" \
  --wait
/usr/bin/xcrun stapler staple "$dmg"
/usr/bin/xcrun stapler validate "$dmg"
/usr/sbin/spctl --assess --type open \
  --context context:primary-signature \
  --verbose=4 "$dmg"
