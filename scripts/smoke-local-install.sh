#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
PORT=${WORKTABLE_SMOKE_PORT:-19434}
KEEP=${WORKTABLE_SMOKE_KEEP:-0}
HOLD=${WORKTABLE_SMOKE_HOLD:-0}
SMOKE_BASE=${WORKTABLE_SMOKE_BASE:-/tmp}
SMOKE_ROOT=${WORKTABLE_SMOKE_ROOT:-}
TARGET_OS=${WORKTABLE_TEST_OS:-$(uname -s)}
TARGET_ARCH=${WORKTABLE_TEST_ARCH:-$(uname -m)}

usage() {
  cat <<'EOF'
Usage: bun run smoke:local-install -- [options]

Options:
  --keep             Keep smoke files/logs after the checks finish.
  --review           Keep smoke files and keep the server running for browser review.
  --root <path>      Use a stable smoke root instead of a generated temp dir.
  --base <path>      Directory for generated smoke roots. Default: /tmp.
  --port <port>      Port for the temporary Worktable server. Default: 19434.
  --help             Show this help.

Examples:
  bun run smoke:local-install
  bun run smoke:local-install -- --keep
  bun run smoke:local-install -- --review
  bun run smoke:local-install -- --root /tmp/worktable-smoke --review
EOF
}

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
      SMOKE_ROOT=$1
      ;;
    --base)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--base requires a path." >&2
        exit 1
      fi
      SMOKE_BASE=$1
      ;;
    --port)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--port requires a value." >&2
        exit 1
      fi
      PORT=$1
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
    echo "No local install smoke target for $TARGET_OS/$TARGET_ARCH." >&2
    exit 1
    ;;
esac

if [ ! -f "$ROOT_DIR/dist/releases/$target_artifact" ]; then
  if [ ! -d "$ROOT_DIR/node_modules" ]; then
    echo "Release artifact $target_artifact not found and repo dependencies are not installed." >&2
    echo "Run this first:" >&2
    echo "  bun install" >&2
    echo >&2
    echo "Then rerun:" >&2
    echo "  bun run smoke:local-install" >&2
    exit 1
  fi
  echo "Release artifact $target_artifact not found. Building release artifacts with bun run release:local."
  (cd "$ROOT_DIR" && bun run release:local)
fi

if [ -z "$SMOKE_ROOT" ]; then
  mkdir -p "$SMOKE_BASE"
  SMOKE_ROOT=$(mktemp -d "$SMOKE_BASE/worktable-local-smoke.XXXXXX")
fi
HOME_DIR="$SMOKE_ROOT/home"
BIN_DIR="$SMOKE_ROOT/bin"
WORKSPACE_DIR="$SMOKE_ROOT/workspace"
APP_DIR="$SMOKE_ROOT/app"

mkdir -p "$HOME_DIR" "$BIN_DIR" "$WORKSPACE_DIR" "$APP_DIR"

stop_owned_process() {
  owned_pid=$1
  kill "$owned_pid" >/dev/null 2>&1 || true
  attempts=0
  while kill -0 "$owned_pid" >/dev/null 2>&1 && [ "$attempts" -lt 100 ]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
  if kill -0 "$owned_pid" >/dev/null 2>&1; then
    kill -KILL "$owned_pid" >/dev/null 2>&1 || true
  fi
  wait "$owned_pid" 2>/dev/null || true
}

cleanup() {
  smoke_status=$?
  trap - EXIT INT TERM
  if [ -n "${STDIO_PID:-}" ]; then
    stop_owned_process "$STDIO_PID"
  fi
  if [ -n "${SERVER_PID:-}" ]; then
    stop_owned_process "$SERVER_PID"
  fi
  if [ "$KEEP" != "1" ]; then
    rm -rf "$SMOKE_ROOT" || { [ "$smoke_status" -ne 0 ] || smoke_status=1; }
  fi
  exit "$smoke_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

assert_portable_binary() {
  binary=$1
  if LC_ALL=C grep -aF -q "$ROOT_DIR" "$binary"; then
    echo "Packaged binary contains build checkout path: $ROOT_DIR" >&2
    exit 1
  fi
  if LC_ALL=C grep -aF -q 'xhr-sync-worker.js' "$binary"; then
    echo "Packaged binary contains unresolved jsdom sync-XHR worker lookup." >&2
    exit 1
  fi
  if LC_ALL=C grep -aF -q 'mermaid.core.mjs?instance=' "$binary"; then
    echo "Packaged binary contains non-portable Mermaid cache-busting import." >&2
    exit 1
  fi
}

echo "Smoke root: $SMOKE_ROOT"
echo "Installing Worktable into isolated temp dirs..."

# Pin XDG dirs inside the sandbox home: completions install by default, and an
# inherited XDG_DATA_HOME/XDG_CONFIG_HOME would make install.sh write outside it.
# SHELL is pinned to bash so the default completion install is exercised
# deterministically regardless of the host shell.
HOME="$HOME_DIR" \
XDG_DATA_HOME="$HOME_DIR/.local/share" \
XDG_CONFIG_HOME="$HOME_DIR/.config" \
SHELL="/bin/bash" \
sh "$ROOT_DIR/scripts/install.sh" \
  --install-dir "$BIN_DIR" \
  --app-dir "$APP_DIR" \
  --release-base-url "file://$ROOT_DIR/dist" \
  --version "releases" \
  --no-setup \
  > "$SMOKE_ROOT/install.log" 2>&1

WORKTABLE="$BIN_DIR/worktable"
if [ ! -x "$WORKTABLE" ]; then
  echo "Expected installed launcher at $WORKTABLE." >&2
  sed -n '1,120p' "$SMOKE_ROOT/install.log" >&2
  exit 1
fi

# Keep the smoke hermetic: the installed launcher stamps WORKTABLE_VERSION,
# which would otherwise let the server's update check call the real release
# host from CI.
export WORKTABLE_NO_UPDATE_CHECK=1
# Completions install by default; assert both command names got a script.
for comp in worktable wtb; do
  comp_file="$HOME_DIR/.local/share/bash-completion/completions/$comp"
  if [ ! -s "$comp_file" ]; then
    echo "Expected default-installed bash completion at $comp_file." >&2
    sed -n '1,120p' "$SMOKE_ROOT/install.log" >&2
    exit 1
  fi
done

for binary in "$APP_DIR"/releases/*/bin/worktable; do
  if [ -x "$binary" ]; then
    assert_portable_binary "$binary"
  fi
done

WORKTABLE_WORKSPACE="$WORKSPACE_DIR" \
WORKTABLE_APP_DIR="$APP_DIR" \
"$WORKTABLE" --version > "$SMOKE_ROOT/version.out"

WORKTABLE_WORKSPACE="$WORKSPACE_DIR" \
WORKTABLE_APP_DIR="$APP_DIR" \
"$WORKTABLE" paths --json > "$SMOKE_ROOT/paths.json"

WORKTABLE_WORKSPACE="$WORKSPACE_DIR" \
WORKTABLE_APP_DIR="$APP_DIR" \
"$WORKTABLE" doctor > "$SMOKE_ROOT/doctor.out"

WORKTABLE_WORKSPACE="$WORKSPACE_DIR" \
WORKTABLE_APP_DIR="$APP_DIR" \
"$WORKTABLE" launch --foreground --no-browser --port "$PORT" > "$SMOKE_ROOT/server.log" 2>&1 &
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
grep -q "<title>Worktable</title>" "$SMOKE_ROOT/index.html"

i=0
while [ "$i" -lt 40 ]; do
  curl -fsS "http://127.0.0.1:$PORT/api/spaces" > "$SMOKE_ROOT/spaces.json"
  if grep -q '"id":"welcome"' "$SMOKE_ROOT/spaces.json"; then
    break
  fi
  i=$((i + 1))
  sleep 0.25
done
grep -q '"id":"welcome"' "$SMOKE_ROOT/spaces.json"

curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}' \
  > "$SMOKE_ROOT/http-mcp.out"
grep -q '"protocolVersion"' "$SMOKE_ROOT/http-mcp.out"

# Keep stdin open until the final response, and wait for each dependency.
# JSON-RPC permits concurrent replies; elapsed time does not prove completion.
# A kept stable root can retain the previous run's FIFO. Never remove an
# unrelated regular file if that path was supplied by the caller.
if [ -p "$SMOKE_ROOT/stdio-mcp.in" ]; then
  rm "$SMOKE_ROOT/stdio-mcp.in"
fi
mkfifo "$SMOKE_ROOT/stdio-mcp.in"
WORKTABLE_WORKSPACE="$WORKSPACE_DIR" \
  WORKTABLE_APP_DIR="$APP_DIR" \
  "$WORKTABLE" --mcp < "$SMOKE_ROOT/stdio-mcp.in" \
  > "$SMOKE_ROOT/stdio-mcp.out" 2> "$SMOKE_ROOT/stdio-mcp.err" &
STDIO_PID=$!
exec 3> "$SMOKE_ROOT/stdio-mcp.in"

await_mcp_response() {
  request_id=$1
  attempts=0
  while [ "$attempts" -lt 240 ]; do
    if grep -E "\"id\":[[:space:]]*$request_id([,}])" "$SMOKE_ROOT/stdio-mcp.out" > "$SMOKE_ROOT/mcp-response-$request_id.json"; then
      if grep -Eq '"error"[[:space:]]*:|"isError"[[:space:]]*:[[:space:]]*true' "$SMOKE_ROOT/mcp-response-$request_id.json"; then
        echo "Stdio MCP request $request_id failed:" >&2
        cat "$SMOKE_ROOT/mcp-response-$request_id.json" >&2
        exit 1
      fi
      return
    fi
    if ! kill -0 "$STDIO_PID" >/dev/null 2>&1; then
      break
    fi
    attempts=$((attempts + 1))
    sleep 0.25
  done
  echo "No stdio MCP response for request $request_id." >&2
  cat "$SMOKE_ROOT/stdio-mcp.err" >&2
  exit 1
}

printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"smoke\",\"version\":\"0.0.0\"}}}" >&3
await_mcp_response 1
printf "%s\n" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\",\"params\":{}}" >&3
printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"worktable_mermaid\",\"arguments\":{\"request\":{\"action\":\"validate\",\"source\":\"graph TD; A-->B\"}}}}" >&3
await_mcp_response 2
printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"worktable_spaces\",\"arguments\":{\"request\":{\"action\":\"create\",\"name\":\"Smoke MCP Space\"}}}}" >&3
await_mcp_response 3
printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"worktable_docs_write\",\"arguments\":{\"request\":{\"action\":\"write\",\"spaceId\":\"smoke-mcp-space\",\"docPath\":\"json-doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Hello from JSON\",\"styles\":{}}]},{\"type\":\"codeBlock\",\"props\":{\"language\":\"mermaid\"},\"content\":[{\"type\":\"text\",\"text\":\"graph TD; A-->B\",\"styles\":{}}]}]}}}}" >&3
await_mcp_response 4
printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"worktable_docs_read\",\"arguments\":{\"request\":{\"action\":\"read\",\"spaceId\":\"smoke-mcp-space\",\"docPath\":\"json-doc\"}}}}" >&3
await_mcp_response 5
exec 3>&-
stop_owned_process "$STDIO_PID"
STDIO_PID=
grep -q '"protocolVersion"' "$SMOKE_ROOT/mcp-response-1.json"
grep -q 'flowchart-v2' "$SMOKE_ROOT/mcp-response-2.json"
grep -q 'graph TD; A-->B' "$SMOKE_ROOT/mcp-response-5.json"
grep -q 'Hello from JSON' "$SMOKE_ROOT/mcp-response-5.json"

echo
echo "Local install smoke passed."
echo "Version: $(cat "$SMOKE_ROOT/version.out")"
echo "URL: http://127.0.0.1:$PORT"
echo "Workspace: $WORKSPACE_DIR"
echo "App-private dir: $APP_DIR"
if [ "$KEEP" = "1" ]; then
  echo "Smoke files kept at: $SMOKE_ROOT"
else
  echo "Smoke files will be removed. Set WORKTABLE_SMOKE_KEEP=1 to keep them."
fi

if [ "$HOLD" = "1" ]; then
  echo
  echo "Server is still running for manual review."
  echo "Press Ctrl+C to stop."
  wait "$SERVER_PID" || true
fi
