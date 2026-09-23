#!/bin/sh
set -eu

mode=latest
version=latest
case "${1:-}" in
  --latest|"")
    ;;
  --version)
    [ -n "${2:-}" ] || {
      echo "public-skill-installer-smoke: --version requires a release tag" >&2
      exit 2
    }
    mode=versioned
    version=$2
    ;;
  *)
    echo "Usage: sh scripts/public-skill-installer-smoke.sh [--latest | --version vX.Y.Z]" >&2
    exit 2
    ;;
esac

install_url=${WORKTABLE_SKILLS_INSTALL_URL:-https://worktable.dev/install-skills}
inventory=${WORKTABLE_SKILL_INVENTORY:-plugins/worktable/skill-inventory.json}
[ -f "$inventory" ] || {
  echo "public-skill-installer-smoke: canonical skill inventory not found: $inventory" >&2
  exit 1
}
skill_files=$(WORKTABLE_SKILL_INVENTORY="$inventory" bun -e '
  const inventory = await Bun.file(process.env.WORKTABLE_SKILL_INVENTORY).json()
  for (const skill of inventory.skills) {
    for (const file of skill.files) console.log(`${skill.name}/${file}`)
  }
')
[ -n "$skill_files" ] || {
  echo "public-skill-installer-smoke: canonical skill inventory is empty" >&2
  exit 1
}
root=$(mktemp -d "${TMPDIR:-/tmp}/worktable-public-skills.XXXXXX")
cleanup() {
  rm -rf "$root"
}
trap cleanup EXIT INT TERM
mkdir -p "$root/home" "$root/app"

run_installer() {
  curl -fsSL "$install_url" |
    HOME="$root/home" \
    WORKTABLE_SKILL_HOME="$root/home" \
    WORKTABLE_APP_DIR="$root/app" \
    WORKTABLE_SKILLS_VERSION="$version" \
    sh -s -- "$@"
}

run_installer --target agents
skill_root="$root/home/.agents/skills"
[ -d "$skill_root" ] || {
  echo "public-skill-installer-smoke: installer created no Agent Skills folder" >&2
  exit 1
}
for file in $skill_files; do
  [ -f "$skill_root/$file" ] || {
    echo "public-skill-installer-smoke: installed package is missing $file" >&2
    exit 1
  }
done
installed_file_count=$(find "$skill_root" -type f | wc -l | tr -d ' ')
expected_file_count=$(printf '%s\n' "$skill_files" | wc -l | tr -d ' ')
[ "$installed_file_count" = "$expected_file_count" ] || {
  echo "public-skill-installer-smoke: installed package contains unexpected files" >&2
  exit 1
}

# Idempotency and status are owned by the compiled installer contracts.
# Keep the actual public wrapper install/remove journey at each release route.
run_installer remove --target agents
[ -z "$(find "$skill_root" -type f -print -quit)" ] || {
  echo "public-skill-installer-smoke: removal left a Worktable-owned file" >&2
  exit 1
}

echo "Public $mode standalone skill install/remove smoke passed."
