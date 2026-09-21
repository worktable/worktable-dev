#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
PORT=${WORKTABLE_E2E_PORT:-19436}
KEEP=${WORKTABLE_E2E_KEEP:-0}
HOLD=${WORKTABLE_E2E_HOLD:-0}
E2E_BASE=${WORKTABLE_E2E_BASE:-/tmp}
E2E_ROOT=${WORKTABLE_E2E_ROOT:-}
TARGET_OS=${WORKTABLE_TEST_OS:-$(uname -s)}
TARGET_ARCH=${WORKTABLE_TEST_ARCH:-$(uname -m)}

usage() {
  cat <<'EOF'
Usage: bun run verify:local-e2e -- [options]

Options:
  --keep             Keep verification files/logs after checks finish.
  --review           Keep files and keep the server running for browser review.
  --root <path>      Use a stable verification root instead of a generated temp dir.
  --base <path>      Directory for generated verification roots. Default: /tmp.
  --port <port>      Port for the temporary Worktable server. Default: 19436.
  --service          Also attempt real user-service install/start/stop checks.
  --help             Show this help.

This script verifies the packaged installed Worktable launcher, not the repo
TypeScript entrypoint. It uses isolated workspace/app/client config paths.
EOF
}

CHECK_SERVICE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep)
      KEEP=1
      ;;
    --review)
      KEEP=1
      HOLD=1
      ;;
    --root)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--root requires a path." >&2
        exit 1
      fi
      E2E_ROOT=$1
      ;;
    --base)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--base requires a path." >&2
        exit 1
      fi
      E2E_BASE=$1
      ;;
    --port)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--port requires a value." >&2
        exit 1
      fi
      PORT=$1
      ;;
    --service)
      CHECK_SERVICE=1
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

case "$TARGET_OS:$TARGET_ARCH" in
  Darwin:arm64)
    target_artifact=worktable-darwin-arm64.tar.gz
    ;;
  Darwin:x86_64)
    target_artifact=worktable-darwin-x64.tar.gz
    ;;
  Linux:x86_64)
    target_artifact=worktable-linux-x64.tar.gz
    ;;
  Linux:aarch64|Linux:arm64)
    target_artifact=worktable-linux-arm64.tar.gz
    ;;
  *)
    echo "No local E2E target for $TARGET_OS/$TARGET_ARCH." >&2
    exit 1
    ;;
esac

if [ ! -f "$ROOT_DIR/dist/releases/$target_artifact" ]; then
  if [ ! -d "$ROOT_DIR/node_modules" ]; then
    echo "Release artifact $target_artifact not found and repo dependencies are not installed." >&2
    echo "Run this first:" >&2
    echo "  bun install" >&2
    exit 1
  fi
  echo "Release artifact $target_artifact not found. Building release artifacts with bun run release:local."
  (cd "$ROOT_DIR" && bun run release:local)
fi

if [ -z "$E2E_ROOT" ]; then
  mkdir -p "$E2E_BASE"
  E2E_ROOT=$(mktemp -d "$E2E_BASE/worktable-local-e2e.XXXXXX")
fi

HOME_DIR="$E2E_ROOT/home"
BIN_DIR="$E2E_ROOT/bin"
FAKE_PATH_DIR="$E2E_ROOT/fake-path"
WORKSPACE_DIR="$E2E_ROOT/workspace"
APP_DIR="$E2E_ROOT/app"
CLIENT_DIR="$E2E_ROOT/clients"
CURSOR_CONFIG="$CLIENT_DIR/cursor/mcp.json"
OPENCODE_CONFIG="$CLIENT_DIR/opencode/opencode.json"
CODEX_CONFIG="$CLIENT_DIR/codex/config.toml"

mkdir -p "$HOME_DIR" "$BIN_DIR" "$FAKE_PATH_DIR" "$WORKSPACE_DIR" "$APP_DIR" "$CLIENT_DIR"

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "${STDIO_PID:-}" ]; then
    kill "$STDIO_PID" >/dev/null 2>&1 || true
  fi
  if [ "$KEEP" != "1" ]; then
    rm -rf "$E2E_ROOT"
  fi
}
trap cleanup EXIT INT TERM

run_wt() {
  HOME="$HOME_DIR" \
  PATH="$FAKE_PATH_DIR:/usr/bin:/bin:/usr/sbin:/sbin" \
  WORKTABLE_WORKSPACE="$WORKSPACE_DIR" \
  WORKTABLE_APP_DIR="$APP_DIR" \
  WORKTABLE_CURSOR_MCP_CONFIG="$CURSOR_CONFIG" \
  WORKTABLE_OPENCODE_CONFIG="$OPENCODE_CONFIG" \
  WORKTABLE_CODEX_CONFIG="$CODEX_CONFIG" \
  WORKTABLE_NO_UPDATE_CHECK=1 \
  "$WORKTABLE" "$@"
}

wait_for_health() {
  healthy=0
  i=0
  while [ "$i" -lt 80 ]; do
    if curl -fsS "http://127.0.0.1:$PORT/health" > "$E2E_ROOT/health.json" 2>/dev/null &&
       grep -q '"service":"worktable"' "$E2E_ROOT/health.json"; then
      healthy=1
      break
    fi
    i=$((i + 1))
    sleep 0.25
  done
  if [ "$healthy" != "1" ]; then
    echo "Worktable did not become healthy on port $PORT." >&2
    sed -n '1,180p' "$E2E_ROOT/server.log" >&2 || true
    exit 1
  fi
}

echo "E2E root: $E2E_ROOT"
echo "Installing packaged Worktable into isolated temp dirs..."

HOME="$HOME_DIR" \
sh "$ROOT_DIR/scripts/install.sh" \
  --install-dir "$BIN_DIR" \
  --app-dir "$APP_DIR" \
  --workspace "$WORKSPACE_DIR" \
  --release-base-url "file://$ROOT_DIR/dist" \
  --version "releases" \
  --no-setup \
  > "$E2E_ROOT/install.log" 2>&1

WORKTABLE="$BIN_DIR/worktable"
if [ ! -x "$WORKTABLE" ]; then
  echo "Expected installed launcher at $WORKTABLE." >&2
  sed -n '1,160p' "$E2E_ROOT/install.log" >&2
  exit 1
fi

run_wt --version > "$E2E_ROOT/version.out"
run_wt --help > "$E2E_ROOT/help.out"
grep -q "worktable launch" "$E2E_ROOT/help.out"
grep -q "worktable setup" "$E2E_ROOT/help.out"
grep -q "worktable mcp" "$E2E_ROOT/help.out"

run_wt setup --yes --foreground --skip-mcp --no-launch \
  --workspace "$WORKSPACE_DIR" \
  --host 127.0.0.1 \
  --port "$PORT" \
  > "$E2E_ROOT/setup.out"
grep -q "Welcome to Worktable" "$E2E_ROOT/setup.out"

run_wt paths --json > "$E2E_ROOT/paths.json"
grep -q "\"workspaceDir\": \"$WORKSPACE_DIR\"" "$E2E_ROOT/paths.json"
grep -q "\"appDir\": \"$APP_DIR\"" "$E2E_ROOT/paths.json"

run_wt doctor > "$E2E_ROOT/doctor.out"
grep -q "Canonical config:" "$E2E_ROOT/doctor.out"
grep -q "MCP endpoint:" "$E2E_ROOT/doctor.out"

# A healthy packaged install must pass the doctor health gate (exit 0) and not
# report degraded static assets.
run_wt doctor --check > "$E2E_ROOT/doctor-check.out"
if grep -q "Degraded:" "$E2E_ROOT/doctor-check.out"; then
  echo "doctor --check reported degraded state on a healthy install." >&2
  cat "$E2E_ROOT/doctor-check.out" >&2
  exit 1
fi

run_wt status --json > "$E2E_ROOT/status-before.json"
grep -q "\"workspace\": \"$WORKSPACE_DIR\"" "$E2E_ROOT/status-before.json"
grep -q "\"url\": \"http://127.0.0.1:$PORT\"" "$E2E_ROOT/status-before.json"

run_wt mcp clients > "$E2E_ROOT/mcp-clients.out"
grep -q "claude-code" "$E2E_ROOT/mcp-clients.out"
grep -q "opencode" "$E2E_ROOT/mcp-clients.out"
if run_wt mcp clients --all > "$E2E_ROOT/mcp-clients-all.out"; then
  grep -q "claude-desktop" "$E2E_ROOT/mcp-clients-all.out"
fi

run_wt mcp setup cursor opencode codex > "$E2E_ROOT/mcp-setup.out"
grep -q "Cursor" "$E2E_ROOT/mcp-setup.out"
grep -q "opencode" "$E2E_ROOT/mcp-setup.out"
grep -q "Codex" "$E2E_ROOT/mcp-setup.out"

test -f "$CURSOR_CONFIG"
test -f "$OPENCODE_CONFIG"
test -f "$CODEX_CONFIG"
grep -q "\"worktable\"" "$CURSOR_CONFIG"
grep -q "\"url\": \"http://127.0.0.1:$PORT/mcp\"" "$CURSOR_CONFIG"
grep -q "\"type\": \"remote\"" "$OPENCODE_CONFIG"
grep -q "url = \"http://127.0.0.1:$PORT/mcp\"" "$CODEX_CONFIG"

run_wt mcp status > "$E2E_ROOT/mcp-status.out"
grep -q "Cursor       configured" "$E2E_ROOT/mcp-status.out"
grep -q "opencode     configured" "$E2E_ROOT/mcp-status.out"
grep -q "Codex        configured" "$E2E_ROOT/mcp-status.out"

run_wt mcp print-config cursor > "$E2E_ROOT/mcp-print-cursor.out"
grep -q "\"mcpServers\"" "$E2E_ROOT/mcp-print-cursor.out"

run_wt launch --foreground --no-browser > "$E2E_ROOT/server.log" 2>&1 &
SERVER_PID=$!
wait_for_health

run_wt status --json > "$E2E_ROOT/status-running.json"
grep -q "\"running\": true" "$E2E_ROOT/status-running.json"

curl -fsS "http://127.0.0.1:$PORT/" > "$E2E_ROOT/index.html"
grep -q "<title>Worktable</title>" "$E2E_ROOT/index.html"

curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"local-e2e","version":"0.0.0"}}}' \
  > "$E2E_ROOT/http-mcp.out"
grep -q '"protocolVersion"' "$E2E_ROOT/http-mcp.out"

run_wt mcp test > "$E2E_ROOT/mcp-test.out"
grep -q "reachable" "$E2E_ROOT/mcp-test.out"

sh -c '
  printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"local-e2e\",\"version\":\"0.0.0\"}}}"
  sleep 0.5
  printf "%s\n" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\",\"params\":{}}"
  sleep 0.5
  printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}"
  sleep 2
' sh | HOME="$HOME_DIR" \
  PATH="$FAKE_PATH_DIR:/usr/bin:/bin:/usr/sbin:/sbin" \
  WORKTABLE_WORKSPACE="$WORKSPACE_DIR" \
  WORKTABLE_APP_DIR="$APP_DIR" \
  "$WORKTABLE" mcp stdio \
  > "$E2E_ROOT/stdio-mcp.out" 2> "$E2E_ROOT/stdio-mcp.err" &
STDIO_PID=$!
sleep 5
kill "$STDIO_PID" >/dev/null 2>&1 || true
grep -q '"protocolVersion"' "$E2E_ROOT/stdio-mcp.out"
grep -q 'worktable_discover' "$E2E_ROOT/stdio-mcp.out"

run_wt mcp remove cursor > "$E2E_ROOT/mcp-remove.out"
run_wt mcp status > "$E2E_ROOT/mcp-status-after-remove.out"
grep -q "Cursor       removed" "$E2E_ROOT/mcp-status-after-remove.out"

if [ "$CHECK_SERVICE" = "1" ]; then
  run_wt service install > "$E2E_ROOT/service-install.out"
  run_wt service start > "$E2E_ROOT/service-start.out"
  run_wt service status > "$E2E_ROOT/service-status.out"
  run_wt service logs > "$E2E_ROOT/service-logs.out"
  run_wt service stop > "$E2E_ROOT/service-stop.out" || true
  run_wt service uninstall > "$E2E_ROOT/service-uninstall.out" || true
fi

echo
echo "Local packaged E2E verification passed."
echo "Version: $(cat "$E2E_ROOT/version.out")"
echo "URL: http://127.0.0.1:$PORT"
echo "Workspace: $WORKSPACE_DIR"
echo "App-private dir: $APP_DIR"
echo "Client configs: $CLIENT_DIR"
if [ "$KEEP" = "1" ]; then
  echo "Verification files kept at: $E2E_ROOT"
else
  echo "Verification files will be removed. Set WORKTABLE_E2E_KEEP=1 to keep them."
fi

if [ "$HOLD" = "1" ]; then
  echo
  echo "Server is still running for manual review."
  echo "Press Ctrl+C to stop."
  wait "$SERVER_PID" || true
fi
