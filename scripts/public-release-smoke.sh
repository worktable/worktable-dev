#!/bin/sh
set -eu

# Smoke-test the PUBLIC install path from a disposable environment.
#
# Usage:
#   sh scripts/public-release-smoke.sh --version v0.0.2
#   sh scripts/public-release-smoke.sh --latest --expect-version v0.0.2
#
# It installs Worktable exactly the way a user would (curl worktable.dev/install),
# then exercises the installed launcher: version, paths, doctor health gate, and a
# real server launch that proves the bundled static assets work.
#
# Network steps are wrapped in bounded retries to tolerate GitHub asset / Vercel
# redirect / CDN propagation lag right after a release is published or promoted.
#
# Temp dirs are removed unless WORKTABLE_PUBLIC_SMOKE_KEEP=1.

INSTALL_URL=${WORKTABLE_PUBLIC_SMOKE_INSTALL_URL:-https://worktable.dev/install}
PORT=${WORKTABLE_PUBLIC_SMOKE_PORT:-19438}
KEEP=${WORKTABLE_PUBLIC_SMOKE_KEEP:-0}
RETRIES=${WORKTABLE_PUBLIC_SMOKE_RETRIES:-8}
RETRY_DELAY=${WORKTABLE_PUBLIC_SMOKE_RETRY_DELAY:-8}

MODE=
VERSION=
EXPECTED_VERSION=

usage() {
  cat <<'EOF'
Usage:
  sh scripts/public-release-smoke.sh --version <tag>
  sh scripts/public-release-smoke.sh --latest [--expect-version <tag>]

Options:
  --version <tag>        Install and verify a specific version (e.g. v0.0.2).
  --latest               Install the current latest release.
  --expect-version <tag> Require --latest to install this version.
  --help                 Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      shift
      [ "$#" -gt 0 ] || { echo "--version requires a tag." >&2; exit 1; }
      MODE=version
      VERSION=$1
      ;;
    --latest)
      MODE=latest
      ;;
    --expect-version)
      shift
      [ "$#" -gt 0 ] || { echo "--expect-version requires a tag." >&2; exit 1; }
      EXPECTED_VERSION=${1#v}
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [ -z "$MODE" ]; then
  echo "Specify --version <tag> or --latest." >&2
  usage >&2
  exit 1
fi
if [ "$MODE" = "version" ]; then
  [ -z "$EXPECTED_VERSION" ] || {
    echo "--expect-version is only valid with --latest." >&2
    exit 1
  }
  EXPECTED_VERSION=${VERSION#v}
fi

retry() {
  # retry <description> <command...>
  description=$1
  shift
  i=1
  while [ "$i" -le "$RETRIES" ]; do
    if "$@"; then
      return 0
    fi
    echo "  $description failed (attempt $i/$RETRIES); retrying in ${RETRY_DELAY}s..." >&2
    i=$((i + 1))
    sleep "$RETRY_DELAY"
  done
  echo "$description failed after $RETRIES attempts." >&2
  return 1
}

SMOKE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/worktable-public-smoke.XXXXXX")
HOME_DIR="$SMOKE_ROOT/home"
BIN_DIR="$SMOKE_ROOT/bin"
APP_DIR="$SMOKE_ROOT/app"
WORKSPACE_DIR="$SMOKE_ROOT/workspace"
mkdir -p "$HOME_DIR" "$BIN_DIR" "$APP_DIR" "$WORKSPACE_DIR"

SERVER_PID=

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [ "$KEEP" != "1" ]; then
    rm -rf "$SMOKE_ROOT"
  else
    echo "Smoke files kept at: $SMOKE_ROOT"
  fi
}
trap cleanup EXIT INT TERM

WORKTABLE="$BIN_DIR/worktable"

# Pin XDG dirs inside the sandbox home: completions install by default, and an
# inherited XDG_DATA_HOME/XDG_CONFIG_HOME would make install.sh write outside it.
install_once() {
  if [ "$MODE" = "version" ]; then
    curl -fsSL "$INSTALL_URL" | \
      HOME="$HOME_DIR" \
      XDG_DATA_HOME="$HOME_DIR/.local/share" \
      XDG_CONFIG_HOME="$HOME_DIR/.config" \
      sh -s -- \
      --no-setup \
      --install-dir "$BIN_DIR" \
      --app-dir "$APP_DIR" \
      --version "$VERSION" \
      > "$SMOKE_ROOT/install.log" 2>&1 \
      || return 1
  else
    curl -fsSL "$INSTALL_URL" | \
      HOME="$HOME_DIR" \
      XDG_DATA_HOME="$HOME_DIR/.local/share" \
      XDG_CONFIG_HOME="$HOME_DIR/.config" \
      sh -s -- \
      --no-setup \
      --install-dir "$BIN_DIR" \
      --app-dir "$APP_DIR" \
      > "$SMOKE_ROOT/install.log" 2>&1 \
      || return 1
  fi

  # A successful download/install can still be the previous "latest" while CDN
  # caches converge after promotion. Include the semantic version assertion in
  # the bounded install retry so the lifecycle smoke only exercises the release
  # this job was asked to verify.
  if [ -n "$EXPECTED_VERSION" ]; then
    [ -x "$WORKTABLE" ] || return 1
    installed=$(
      HOME="$HOME_DIR" \
      WORKTABLE_APP_DIR="$APP_DIR" \
      "$WORKTABLE" --version
    ) || return 1
    if [ "$installed" != "$EXPECTED_VERSION" ]; then
      echo "Installed version '$installed' does not match expected '$EXPECTED_VERSION'." >&2
      return 1
    fi
  fi
}

run_wt() {
  HOME="$HOME_DIR" \
  WORKTABLE_WORKSPACE="$WORKSPACE_DIR" \
  WORKTABLE_APP_DIR="$APP_DIR" \
  "$WORKTABLE" "$@"
}

echo "Public install smoke ($MODE) from $INSTALL_URL"
echo "Smoke root: $SMOKE_ROOT"

retry "public install" install_once || {
  sed -n '1,160p' "$SMOKE_ROOT/install.log" >&2 || true
  exit 1
}

if [ ! -x "$WORKTABLE" ]; then
  echo "Expected installed launcher at $WORKTABLE." >&2
  sed -n '1,160p' "$SMOKE_ROOT/install.log" >&2
  exit 1
fi

# Configure a foreground install without touching MCP clients or launching.
run_wt setup --yes --foreground --skip-mcp --no-launch \
  --workspace "$WORKSPACE_DIR" \
  --host 127.0.0.1 \
  --port "$PORT" \
  > "$SMOKE_ROOT/setup.out"

run_wt --version > "$SMOKE_ROOT/version.out"
installed_version=$(cat "$SMOKE_ROOT/version.out")
echo "Installed version: $installed_version"

if [ -n "$EXPECTED_VERSION" ] && [ "$installed_version" != "$EXPECTED_VERSION" ]; then
  echo "Installed version '$installed_version' does not match expected '$EXPECTED_VERSION'." >&2
  exit 1
fi

run_wt paths --json > "$SMOKE_ROOT/paths.json"

# Health gate: doctor --check must exit 0 and report no degraded static assets.
run_wt doctor --check > "$SMOKE_ROOT/doctor.out"
if grep -q "Degraded:" "$SMOKE_ROOT/doctor.out"; then
  echo "doctor --check reported a degraded install." >&2
  cat "$SMOKE_ROOT/doctor.out" >&2
  exit 1
fi

# Launch the server and prove the bundled web assets actually serve.
run_wt launch --foreground --no-browser --port "$PORT" > "$SMOKE_ROOT/server.log" 2>&1 &
SERVER_PID=$!

healthy=0
i=0
while [ "$i" -lt 80 ]; do
  if curl -fsS "http://127.0.0.1:$PORT/health" > "$SMOKE_ROOT/health.json" 2>/dev/null &&
     grep -q '"service":"worktable"' "$SMOKE_ROOT/health.json"; then
    healthy=1
    break
  fi
  i=$((i + 1))
  sleep 0.25
done
if [ "$healthy" != "1" ]; then
  echo "Worktable did not become healthy on port $PORT." >&2
  sed -n '1,160p' "$SMOKE_ROOT/server.log" >&2
  exit 1
fi

curl -fsS "http://127.0.0.1:$PORT/" > "$SMOKE_ROOT/index.html"
grep -q "<title>Worktable</title>" "$SMOKE_ROOT/index.html" \
  || { echo "Served index.html is missing the Worktable title (static assets broken?)." >&2; exit 1; }

i=0
while [ "$i" -lt 40 ]; do
  curl -fsS "http://127.0.0.1:$PORT/api/spaces" > "$SMOKE_ROOT/spaces.json" || true
  if grep -q '"id":"welcome"' "$SMOKE_ROOT/spaces.json"; then
    break
  fi
  i=$((i + 1))
  sleep 0.25
done
grep -q '"id":"welcome"' "$SMOKE_ROOT/spaces.json" \
  || { echo "Welcome space not found via /api/spaces." >&2; exit 1; }

echo
echo "Public install smoke passed ($MODE)."
echo "Version: $installed_version"
echo "URL: http://127.0.0.1:$PORT"
