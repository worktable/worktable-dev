#!/bin/sh
set -eu

# Wait for a promoted release manifest to converge at its public latest URL.
# A successful check requires a complete HTTP transfer and valid JSON, matching
# the update-check clients that consume this file.

URL=${1:-}
TAG=${2:-}
ATTEMPTS=${WORKTABLE_RELEASE_MANIFEST_ATTEMPTS:-12}
DELAY=${WORKTABLE_RELEASE_MANIFEST_DELAY:-10}

[ -n "$URL" ] || { echo "manifest URL is required" >&2; exit 1; }
[ -n "$TAG" ] || { echo "expected release tag is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

expected=${TAG#v}
version=
manifest_file=$(mktemp "${TMPDIR:-/tmp}/worktable-release-manifest.XXXXXX")
trap 'rm -f "$manifest_file"' EXIT INT TERM

i=1
while [ "$i" -le "$ATTEMPTS" ]; do
  version=
  if curl -fsSL -o "$manifest_file" "$URL"; then
    version=$(jq -er \
      '.version | select(type == "string" and length > 0)' \
      "$manifest_file" 2>/dev/null) || version=
  fi

  if [ "$version" = "$expected" ]; then
    echo "OK: latest manifest reports $version"
    exit 0
  fi

  if [ "$i" -lt "$ATTEMPTS" ]; then
    echo "  latest manifest reports '${version:-unavailable}', expected '$expected' (attempt $i/$ATTEMPTS); retrying in ${DELAY}s..."
    sleep "$DELAY"
  fi
  i=$((i + 1))
done

echo "::error::latest manifest reports '${version:-unavailable}', expected '$expected' after $ATTEMPTS attempts" >&2
exit 1
