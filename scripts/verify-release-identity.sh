#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'Usage: %s <version>\n' "$0" >&2
  exit 1
}

[[ "$(git branch --show-current)" == 'main' ]] || {
  printf 'Releases must use the main branch.\n' >&2
  exit 1
}
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || {
  printf 'Releases require a clean checkout.\n' >&2
  exit 1
}
[[ "$(node -p "require('./package.json').version")" == "$version" ]] || {
  printf 'package.json is not version %s.\n' "$version" >&2
  exit 1
}

commit="$(git rev-parse HEAD)"
[[ "$(git rev-parse origin/main)" == "$commit" ]] || {
  printf 'HEAD must exactly match origin/main before release.\n' >&2
  exit 1
}

tag="v$version"
[[ "$(git rev-list -n 1 "$tag" 2>/dev/null || true)" == "$commit" ]] || {
  printf 'Tag %s must point to release commit %s.\n' "$tag" "$commit" >&2
  exit 1
}
remote_tag="$(
  git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}" |
    awk '$2 ~ /\^\{\}$/ { peeled=$1 } $2 !~ /\^\{\}$/ { direct=$1 } END { print peeled ? peeled : direct }'
)"
[[ "$remote_tag" == "$commit" ]] || {
  printf 'Remote tag %s must point to release commit %s.\n' "$tag" "$commit" >&2
  exit 1
}

printf '%s\n' "$commit"
