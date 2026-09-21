#!/bin/sh
set -eu

# Validate built release tarballs before they are published.
#
# Usage:
#   sh scripts/verify-release-artifacts.sh [dist/releases]
#
# Checks, per the release artifact contract:
#   - all four CLI tarballs, all four skill-installer tarballs, and checksums exist
#   - sha256sum -c passes (Linux)
#   - the top-level (platform-neutral) manifest.json exists — published as a
#     release asset so installs can poll releases/latest/manifest.json — and
#     each tarball's manifest agrees with its version
#   - each tarball contains bin/worktable, web/, install.sh, manifest.json
#   - manifest.json carries the required fields (and source metadata on CI)
#   - bin/worktable contains no build-machine checkout path or known
#     non-portable references (the xhr-sync-worker.js class of bug)
#   - the Linux binary runs `--version` when host architecture matches

ROOT_DIR=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
RELEASE_DIR=${1:-"$ROOT_DIR/dist/releases"}
HOST_OS=$(uname -s)
HOST_ARCH=$(uname -m)
SKILL_INVENTORY="$ROOT_DIR/plugins/worktable/skill-inventory.json"

[ -f "$SKILL_INVENTORY" ] || {
  echo "verify-release-artifacts: missing skill inventory: $SKILL_INVENTORY" >&2
  exit 1
}
SKILL_FILES=$(bun -e '
  const inventory = await Bun.file(process.argv[1]).json()
  for (const skill of inventory.skills) {
    for (const file of skill.files) console.log(`${skill.name}/${file}`)
  }
' "$SKILL_INVENTORY")
[ -n "$SKILL_FILES" ] || {
  echo "verify-release-artifacts: skill inventory is empty" >&2
  exit 1
}

ARTIFACTS="worktable-darwin-arm64.tar.gz worktable-darwin-x64.tar.gz worktable-linux-x64.tar.gz worktable-linux-arm64.tar.gz"
SKILL_ARTIFACTS="worktable-skills-darwin-arm64.tar.gz worktable-skills-darwin-x64.tar.gz worktable-skills-linux-x64.tar.gz worktable-skills-linux-arm64.tar.gz"

# The standalone server artifact has a distinct entry point and no CLI installer.
SERVER_ARTIFACT="worktable-server-linux-x64.tar.gz"

# Source-metadata fields are always written by build-release.ts, but sourceTag /
# workflowRunUrl are required on private CI rehearsals. Public builds instead
# validate the exact source identity and require an empty workflowRunUrl.
REQUIRE_SOURCE_META=0
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  REQUIRE_SOURCE_META=1
fi

fail() {
  echo "verify-release-artifacts: $1" >&2
  exit 1
}

if [ ! -d "$RELEASE_DIR" ]; then
  fail "release directory not found: $RELEASE_DIR"
fi

for artifact in $ARTIFACTS; do
  [ -f "$RELEASE_DIR/$artifact" ] || fail "missing artifact: $artifact"
done
for artifact in $SKILL_ARTIFACTS; do
  [ -f "$RELEASE_DIR/$artifact" ] || fail "missing artifact: $artifact"
done
[ -f "$RELEASE_DIR/$SERVER_ARTIFACT" ] || fail "missing artifact: $SERVER_ARTIFACT"
[ -f "$RELEASE_DIR/checksums.txt" ] || fail "missing checksums.txt"
[ -f "$RELEASE_DIR/manifest.json" ] || fail "missing top-level manifest.json (update-check asset)"
[ -f "$RELEASE_DIR/worktable-connect.mjs" ] || fail "missing tokenless connector asset"
[ -f "$RELEASE_DIR/worktable-openclaw.tgz" ] || fail "missing OpenClaw plugin asset"

for artifact in $ARTIFACTS $SKILL_ARTIFACTS $SERVER_ARTIFACT; do
  python3 "$ROOT_DIR/scripts/release-archive.py" verify "$RELEASE_DIR/$artifact" ||
    fail "archive metadata verification failed: $artifact"
done

if grep -aF -q 'wt_' "$RELEASE_DIR/worktable-connect.mjs"; then
  fail "connector asset contains a token-shaped static credential"
fi
tar -tzf "$RELEASE_DIR/worktable-openclaw.tgz" |
  grep -q 'package/openclaw.plugin.json' ||
  fail "OpenClaw artifact is not an installable plugin package"

# Verify checksums where sha256sum is available (Linux runners).
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$RELEASE_DIR" && sha256sum -c checksums.txt) || fail "checksum verification failed"
else
  echo "verify-release-artifacts: sha256sum unavailable; skipping checksum verification"
fi

manifest_value() {
  # manifest_value <file> <key>
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1
}

# Top-level manifest: the published update-check asset. Its version is what
# `worktable update` / the Settings nudge will report as "latest", so it must
# agree with every tarball's manifest (checked per-artifact below).
index_manifest="$RELEASE_DIR/manifest.json"
bun "$ROOT_DIR/scripts/release-source.ts" "$index_manifest" >/dev/null || fail "invalid release-index source identity"
bun "$ROOT_DIR/scripts/connector-distribution.ts" "$RELEASE_DIR/worktable-connect.mjs" || fail "invalid detached connector notices"
index_type=$(manifest_value "$index_manifest" type)
[ "$index_type" = "worktable.release-index" ] || fail "top-level manifest type is '$index_type', expected worktable.release-index"
index_version=$(manifest_value "$index_manifest" version)
[ -n "$index_version" ] || fail "top-level manifest 'version' is missing or empty"

assert_portable_binary() {
  binary=$1
  if LC_ALL=C grep -aF -q "$ROOT_DIR" "$binary"; then
    fail "binary contains build checkout path: $ROOT_DIR ($binary)"
  fi
  if LC_ALL=C grep -aF -q 'xhr-sync-worker.js' "$binary"; then
    fail "binary contains unresolved jsdom sync-XHR worker lookup ($binary)"
  fi
  if LC_ALL=C grep -aF -q 'mermaid.core.mjs?instance=' "$binary"; then
    fail "binary contains non-portable Mermaid cache-busting import ($binary)"
  fi
}

work=$(mktemp -d "${TMPDIR:-/tmp}/worktable-verify.XXXXXX")
cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

for artifact in $ARTIFACTS; do
  echo "Verifying $artifact"
  dest="$work/${artifact%.tar.gz}"
  mkdir -p "$dest"
  tar -xzf "$RELEASE_DIR/$artifact" -C "$dest"

  [ -x "$dest/bin/worktable" ] || fail "$artifact: missing bin/worktable"
  [ -d "$dest/web" ] || fail "$artifact: missing web/"
  [ -f "$dest/integrations/worktable-claude-desktop.mcpb" ] || fail "$artifact: missing Claude Desktop MCPB"
  for skill_file in $SKILL_FILES; do
    [ -f "$dest/integrations/worktable-skills/$skill_file" ] || fail "$artifact: missing packaged skill file $skill_file"
    [ ! -L "$dest/integrations/worktable-skills/$skill_file" ] || fail "$artifact: packaged skill file $skill_file is a symlink"
  done
  [ -f "$dest/install.sh" ] || fail "$artifact: missing install.sh"
  [ -f "$dest/manifest.json" ] || fail "$artifact: missing manifest.json"
  bun "$ROOT_DIR/scripts/release-licenses.ts" "$dest" cli >/dev/null || fail "$artifact: missing or changed component license notice"
  cmp "$RELEASE_DIR/worktable-connect.mjs" "$dest/connector/connect.mjs" || fail "$artifact: connector differs from detached asset"
  bun "$ROOT_DIR/scripts/connector-distribution.ts" "$dest/integrations/worktable-claude-desktop.mcpb" || fail "$artifact: invalid detached MCPB notices"

  manifest="$dest/manifest.json"
  source_visibility=$(bun "$ROOT_DIR/scripts/release-source.ts" "$manifest" "$index_manifest") || fail "$artifact: invalid source identity"
  type_value=$(manifest_value "$manifest" type)
  [ "$type_value" = "worktable.release" ] || fail "$artifact: manifest type is '$type_value', expected worktable.release"

  for key in version platform arch bunTarget builtAt staticDirRelative sourceRepo sourceCommit; do
    value=$(manifest_value "$manifest" "$key")
    [ -n "$value" ] || fail "$artifact: manifest field '$key' is missing or empty"
  done

  artifact_version=$(manifest_value "$manifest" version)
  [ "$artifact_version" = "$index_version" ] || fail "$artifact: manifest version '$artifact_version' does not match top-level manifest version '$index_version'"

  # sourceTag / workflowRunUrl keys must always be present; non-empty only on CI.
  for key in sourceTag workflowRunUrl; do
    grep -q "\"$key\"" "$manifest" || fail "$artifact: manifest field '$key' is missing"
    if [ "$REQUIRE_SOURCE_META" = "1" ] && [ "$source_visibility" != "public" ]; then
      value=$(manifest_value "$manifest" "$key")
      [ -n "$value" ] || fail "$artifact: manifest field '$key' is empty under CI"
    fi
  done

  assert_portable_binary "$dest/bin/worktable"

  case "$artifact" in
    worktable-linux-x64.tar.gz)
      if [ "$HOST_OS" = "Linux" ] && [ "$HOST_ARCH" = "x86_64" ]; then
        binary_version=$(
          WORKTABLE_RELEASE_DIR="$dest" \
            WORKTABLE_STATIC_DIR="$dest/web" \
            WORKTABLE_APP_DIR="$dest/app" \
            "$dest/bin/worktable" --version
        ) || fail "$artifact: binary failed to run --version"
        [ "$binary_version" = "$artifact_version" ] ||
          fail "$artifact: binary version '$binary_version' does not match manifest version '$artifact_version'"
      fi
      ;;
    worktable-linux-arm64.tar.gz)
      if [ "$HOST_OS" = "Linux" ] && { [ "$HOST_ARCH" = "aarch64" ] || [ "$HOST_ARCH" = "arm64" ]; }; then
        binary_version=$(
          WORKTABLE_RELEASE_DIR="$dest" \
            WORKTABLE_STATIC_DIR="$dest/web" \
            WORKTABLE_APP_DIR="$dest/app" \
            "$dest/bin/worktable" --version
        ) || fail "$artifact: binary failed to run --version"
        [ "$binary_version" = "$artifact_version" ] ||
          fail "$artifact: binary version '$binary_version' does not match manifest version '$artifact_version'"
      fi
      ;;
  esac
done

# ---------------------------------------------------------------
# Standalone skill-installer artifacts
# ---------------------------------------------------------------
# These archives deliberately contain none of the Worktable application or
# server payload. On the matching host, exercise the compiled entry point and
# its real projection engine through install and remove.
for artifact in $SKILL_ARTIFACTS; do
  echo "Verifying $artifact"
  dest="$work/${artifact%.tar.gz}"
  mkdir -p "$dest"
  tar -xzf "$RELEASE_DIR/$artifact" -C "$dest"

  [ -x "$dest/bin/worktable-skill-installer" ] || fail "$artifact: missing standalone installer"
  [ -f "$dest/manifest.json" ] || fail "$artifact: missing manifest.json"
  [ -d "$dest/skills" ] || fail "$artifact: missing skills/"
  [ ! -d "$dest/web" ] || fail "$artifact: unexpectedly contains the Worktable web app"
  [ ! -d "$dest/connector" ] || fail "$artifact: unexpectedly contains an MCP connector"
  [ ! -f "$dest/install.sh" ] || fail "$artifact: unexpectedly contains the Worktable app installer"

  for skill_file in $SKILL_FILES; do
    [ -f "$dest/skills/$skill_file" ] || fail "$artifact: missing skill file $skill_file"
    [ ! -L "$dest/skills/$skill_file" ] || fail "$artifact: skill file $skill_file is a symlink"
  done
  skill_file_count=$(find "$dest/skills" -type f | wc -l | tr -d ' ')
  expected_skill_file_count=$(printf '%s\n' "$SKILL_FILES" | wc -l | tr -d ' ')
  [ "$skill_file_count" = "$expected_skill_file_count" ] || fail "$artifact: unexpected files in skills/"
  release_file_count=$(find "$dest" -type f | wc -l | tr -d ' ')
  license_file_count=$(bun "$ROOT_DIR/scripts/release-licenses.ts" "$dest" skills) || fail "$artifact: missing or changed skill license notice"
  expected_release_file_count=$((expected_skill_file_count + 2 + license_file_count))
  [ "$release_file_count" = "$expected_release_file_count" ] || fail "$artifact: contains a file outside the executable, manifest, license notices, or canonical skill inventory"
  [ -z "$(find "$dest" -type l -print -quit)" ] || fail "$artifact: contains a symlink"

  manifest="$dest/manifest.json"
  source_visibility=$(bun "$ROOT_DIR/scripts/release-source.ts" "$manifest" "$index_manifest") || fail "$artifact: invalid source identity"
  type_value=$(manifest_value "$manifest" type)
  [ "$type_value" = "worktable.skill-installer" ] || fail "$artifact: manifest type is '$type_value', expected worktable.skill-installer"
  for key in version platform arch bunTarget builtAt sourceRepo sourceCommit; do
    value=$(manifest_value "$manifest" "$key")
    [ -n "$value" ] || fail "$artifact: manifest field '$key' is missing or empty"
  done
  for key in sourceTag workflowRunUrl; do
    grep -q "\"$key\"" "$manifest" || fail "$artifact: manifest field '$key' is missing"
    if [ "$REQUIRE_SOURCE_META" = "1" ] && [ "$source_visibility" != "public" ]; then
      value=$(manifest_value "$manifest" "$key")
      [ -n "$value" ] || fail "$artifact: manifest field '$key' is empty under CI"
    fi
  done
  artifact_version=$(manifest_value "$manifest" version)
  [ "$artifact_version" = "$index_version" ] || fail "$artifact: manifest version '$artifact_version' does not match top-level manifest version '$index_version'"
  assert_portable_binary "$dest/bin/worktable-skill-installer"

  run_skill_smoke=0
  case "$artifact:$HOST_OS:$HOST_ARCH" in
    worktable-skills-linux-x64.tar.gz:Linux:x86_64|worktable-skills-linux-arm64.tar.gz:Linux:aarch64|worktable-skills-linux-arm64.tar.gz:Linux:arm64|worktable-skills-darwin-x64.tar.gz:Darwin:x86_64|worktable-skills-darwin-arm64.tar.gz:Darwin:arm64|worktable-skills-darwin-arm64.tar.gz:Darwin:aarch64)
      run_skill_smoke=1
      ;;
  esac
  if [ "$run_skill_smoke" = "1" ]; then
    smoke="$work/skill-smoke-${artifact%.tar.gz}"
    mkdir -p "$smoke/home" "$smoke/app"
    binary_version=$(
      WORKTABLE_SKILL_INSTALLER_ROOT="$dest" \
      WORKTABLE_SKILL_HOME="$smoke/home" \
      WORKTABLE_APP_DIR="$smoke/app" \
      "$dest/bin/worktable-skill-installer" --version
    ) || fail "$artifact: standalone installer failed to run --version"
    [ "$binary_version" = "$artifact_version" ] || fail "$artifact: binary version '$binary_version' does not match manifest version '$artifact_version'"
    WORKTABLE_SKILL_INSTALLER_ROOT="$dest" \
      WORKTABLE_SKILL_HOME="$smoke/home" \
      WORKTABLE_APP_DIR="$smoke/app" \
      "$dest/bin/worktable-skill-installer" install --target agents >/dev/null || fail "$artifact: standalone install failed"
    for skill_file in $SKILL_FILES; do
      [ -f "$smoke/home/.agents/skills/$skill_file" ] || fail "$artifact: standalone install omitted $skill_file"
    done
    WORKTABLE_SKILL_INSTALLER_ROOT="$dest" \
      WORKTABLE_SKILL_HOME="$smoke/home" \
      WORKTABLE_APP_DIR="$smoke/app" \
      "$dest/bin/worktable-skill-installer" remove --target agents >/dev/null || fail "$artifact: standalone remove failed"
    [ -z "$(find "$smoke/home/.agents/skills" -type f -print -quit)" ] || fail "$artifact: standalone remove left an owned skill file"
    echo "  standalone install/remove smoke: OK"
  fi
done

# ---------------------------------------------------------------
# Hosted tenant server artifact
# ---------------------------------------------------------------
# Boot the standalone hosted server on matching hosts and verify /health.
echo "Verifying $SERVER_ARTIFACT"
sdest="$work/${SERVER_ARTIFACT%.tar.gz}"
mkdir -p "$sdest"
tar -xzf "$RELEASE_DIR/$SERVER_ARTIFACT" -C "$sdest"

[ -x "$sdest/bin/worktable-server" ] || fail "$SERVER_ARTIFACT: missing bin/worktable-server"
[ -d "$sdest/web" ] || fail "$SERVER_ARTIFACT: missing web/"
[ -f "$sdest/integrations/worktable-claude-desktop.mcpb" ] || fail "$SERVER_ARTIFACT: missing Claude Desktop MCPB"
[ -f "$sdest/manifest.json" ] || fail "$SERVER_ARTIFACT: missing manifest.json"
bun "$ROOT_DIR/scripts/release-licenses.ts" "$sdest" server >/dev/null || fail "$SERVER_ARTIFACT: missing or changed component license notice"
cmp "$RELEASE_DIR/worktable-connect.mjs" "$sdest/connector/connect.mjs" || fail "$SERVER_ARTIFACT: connector differs from detached asset"
bun "$ROOT_DIR/scripts/connector-distribution.ts" "$sdest/integrations/worktable-claude-desktop.mcpb" || fail "$SERVER_ARTIFACT: invalid detached MCPB notices"

smanifest="$sdest/manifest.json"
bun "$ROOT_DIR/scripts/release-source.ts" "$smanifest" "$index_manifest" >/dev/null || fail "$SERVER_ARTIFACT: invalid source identity"
stype=$(manifest_value "$smanifest" type)
[ "$stype" = "worktable.server-release" ] || fail "$SERVER_ARTIFACT: manifest type is '$stype', expected worktable.server-release"

for key in version platform arch bunTarget builtAt staticDirRelative binRelative sourceRepo sourceCommit; do
  value=$(manifest_value "$smanifest" "$key")
  [ -n "$value" ] || fail "$SERVER_ARTIFACT: manifest field '$key' is missing or empty"
done

sversion=$(manifest_value "$smanifest" version)
[ "$sversion" = "$index_version" ] || fail "$SERVER_ARTIFACT: manifest version '$sversion' does not match top-level manifest version '$index_version'"

sbin=$(manifest_value "$smanifest" binRelative)
[ -x "$sdest/$sbin" ] || fail "$SERVER_ARTIFACT: manifest binRelative '$sbin' is not an executable in the tarball"

assert_portable_binary "$sdest/bin/worktable-server"

# Boot smoke: a tenant that cannot serve is the whole failure this artifact
# exists to prevent. WORKTABLE_HOSTED=1 is the posture a sprite runs it in —
# it must bind non-loopback with NO owner password (M1 replaced that with
# AS-issued bearers) and answer /health.
if [ "$HOST_OS" = "Linux" ] && [ "$HOST_ARCH" = "x86_64" ]; then
  sport=8791
  mkdir -p "$sdest/data/workspace" "$sdest/data/app"
  WORKTABLE_HOSTED=1 \
  WORKTABLE_NO_UPDATE_CHECK=1 \
  WORKTABLE_STATIC_DIR="$sdest/web" \
  WORKTABLE_WORKSPACE="$sdest/data/workspace" \
  WORKTABLE_APP_DIR="$sdest/data/app" \
  WORKTABLE_VERSION="$index_version" \
  HOST=0.0.0.0 PORT="$sport" \
  "$sdest/bin/worktable-server" >"$work/server.log" 2>&1 &
  spid=$!

  ok=0
  i=0
  while [ "$i" -lt 30 ]; do
    if curl -fsS -m 2 "http://127.0.0.1:$sport/health" 2>/dev/null | grep -q '"ok":true'; then
      ok=1
      break
    fi
    kill -0 "$spid" 2>/dev/null || break
    i=$((i + 1))
    sleep 1
  done
  kill "$spid" 2>/dev/null || true
  wait "$spid" 2>/dev/null || true

  if [ "$ok" != "1" ]; then
    echo "--- server log ---" >&2
    cat "$work/server.log" >&2 || true
    fail "$SERVER_ARTIFACT: server did not answer /health in hosted mode"
  fi
  echo "  hosted boot smoke: /health OK"
fi

echo "verify-release-artifacts: all artifacts in $RELEASE_DIR passed."
