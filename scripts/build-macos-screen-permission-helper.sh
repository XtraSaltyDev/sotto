#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != 'Darwin' ]]; then
  exit 0
fi

readonly REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SOURCE_PATH="${REPOSITORY_ROOT}/native/macos/sotto-screen-permission-request.m"
readonly OUTPUT_DIRECTORY="${REPOSITORY_ROOT}/resources/sidecars/darwin-arm64"
readonly OUTPUT_PATH="${OUTPUT_DIRECTORY}/sotto-screen-permission-request"
readonly SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"

mkdir -p "${OUTPUT_DIRECTORY}"
xcrun --sdk macosx clang \
  -arch arm64 \
  -fobjc-arc \
  -framework CoreGraphics \
  -framework Foundation \
  -isysroot "${SDK_PATH}" \
  -mmacosx-version-min=13.0 \
  -o "${OUTPUT_PATH}" \
  "${SOURCE_PATH}"
chmod 0755 "${OUTPUT_PATH}"
