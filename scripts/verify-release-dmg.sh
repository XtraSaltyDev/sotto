#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

version="${1:-}"
dmg="${2:-out/make/Sotto-${version}-arm64.dmg}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && -s "$dmg" ]] || {
  printf 'Usage: %s <version> [dmg-path]\n' "$0" >&2
  exit 1
}
[[ -n "${SOTTO_UPDATE_CONFIG_FILE:-}" && -s "$SOTTO_UPDATE_CONFIG_FILE" ]] || {
  printf 'SOTTO_UPDATE_CONFIG_FILE is required.\n' >&2
  exit 1
}
[[ -n "${SOTTO_UPDATE_CA_FILE:-}" && -s "$SOTTO_UPDATE_CA_FILE" ]] || {
  printf 'SOTTO_UPDATE_CA_FILE is required.\n' >&2
  exit 1
}

/usr/bin/codesign --verify --strict --verbose=2 "$dmg"
/usr/bin/xcrun stapler validate "$dmg"
/usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
/usr/bin/hdiutil verify "$dmg"

temporary_directory="$(mktemp -d)"
mount_point="$temporary_directory/dmg"
mounted=0
cleanup() {
  if [[ "$mounted" == '1' ]]; then
    /usr/bin/hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  fi
  /bin/rm -rf -- "$temporary_directory"
}
trap cleanup EXIT
mkdir -p "$mount_point"
/usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$mount_point" "$dmg" >/dev/null
mounted=1
app_path="$mount_point/Sotto.app"
[[ -d "$app_path" ]] || {
  printf 'The release DMG does not contain Sotto.app at its root.\n' >&2
  exit 1
}
SOTTO_REQUIRE_CLEAN_SOURCE=1 \
  SOTTO_REQUIRE_SECURE_UPDATE_CONFIG=1 \
  SOTTO_REQUIRE_UPDATE_CA=1 \
  SOTTO_REQUIRE_APPLE_DISTRIBUTION=1 \
  node scripts/verify-packaged-app.mjs darwin-arm64 "$app_path"
cmp -s "$SOTTO_UPDATE_CONFIG_FILE" "$app_path/Contents/Resources/sotto-update-config.json"
cmp -s "$SOTTO_UPDATE_CA_FILE" "$app_path/Contents/Resources/ca.crt"
/usr/bin/hdiutil detach "$mount_point" >/dev/null
mounted=0
printf 'Verified signed, notarized Sotto %s DMG and mounted app.\n' "$version"
