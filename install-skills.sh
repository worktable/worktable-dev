#!/bin/sh
set -eu

# Install Worktable's optional skills without installing Worktable itself.
#
# Usage:
#   curl -fsSL https://worktable.dev/install-skills | sh -s -- --target agents
#   curl -fsSL https://worktable.dev/install-skills | sh -s -- --target claude
#   curl -fsSL https://worktable.dev/install-skills | sh -s -- status --target agents
#   curl -fsSL https://worktable.dev/install-skills | sh -s -- update --target agents

base_url=${WORKTABLE_SKILLS_RELEASE_BASE_URL:-https://worktable.dev/releases}
version=${WORKTABLE_SKILLS_VERSION:-latest}
os=$(uname -s)
arch=$(uname -m)

case "$os:$arch" in
  Darwin:arm64|Darwin:aarch64)
    artifact=worktable-skills-darwin-arm64.tar.gz
    ;;
  Darwin:x86_64)
    artifact=worktable-skills-darwin-x64.tar.gz
    ;;
  Linux:x86_64)
    artifact=worktable-skills-linux-x64.tar.gz
    ;;
  Linux:aarch64|Linux:arm64)
    artifact=worktable-skills-linux-arm64.tar.gz
    ;;
  *)
    echo "Worktable skills are not available for $os/$arch." >&2
    exit 1
    ;;
esac

if [ "${WORKTABLE_SKILLS_TEST_MAP_ONLY:-}" = "1" ]; then
  echo "$artifact"
  exit 0
fi

if [ "$version" = "latest" ]; then
  url="$base_url/latest/$artifact"
else
  url="$base_url/$version/$artifact"
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/worktable-skills.XXXXXX")
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

archive="$tmp_dir/$artifact"
extract_dir="$tmp_dir/release"
mkdir -p "$extract_dir"

case "$url" in
  file://*)
    local_artifact=${url#file://}
    [ -f "$local_artifact" ] || {
      echo "Worktable skill installer not found: $local_artifact" >&2
      exit 1
    }
    cp "$local_artifact" "$archive"
    ;;
  *)
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$url" -o "$archive"
    elif command -v wget >/dev/null 2>&1; then
      wget -q "$url" -O "$archive"
    else
      echo "The Worktable skill installer requires curl or wget." >&2
      exit 1
    fi
    ;;
esac

tar -xzf "$archive" -C "$extract_dir"
binary="$extract_dir/bin/worktable-skill-installer"
[ -x "$binary" ] || {
  echo "The downloaded skill installer is incomplete." >&2
  exit 1
}
[ -d "$extract_dir/skills" ] || {
  echo "The downloaded Worktable skills are missing." >&2
  exit 1
}

WORKTABLE_SKILL_INSTALLER_ROOT="$extract_dir" "$binary" "$@"
