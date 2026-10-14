#!/usr/bin/env bash
# Run click-trace.ts on a Namespace worker through ns-verify (see README.md):
#
#   ns-verify --repo . --timeout 10800 --collect click-results -- \
#     bash scripts/perf/click-trace-remote.sh <commit> [click-trace options]
#
# With PERF_TOOL=io-count it runs io-count.ts instead (no browser or web
# build; strace is installed if missing), passing the options through.
#
# ns-verify uploads a fresh snapshot per run. The perf fixture is keyed by its
# absolute path (the server keys app-local state by workspace path), so this
# copies the snapshot into a stable checkout under $HOME and runs there: the
# fixture, node_modules and toolchains are reused across runs. Results are
# written to ./click-results for --collect, so a run cut short at the timeout
# still returns its finished rounds.
set -euo pipefail

# Namespace stops a devbox it sees as idle, and a stop at that deadline leaves
# its volume "not shut down cleanly". A task marker keeps it active for the
# whole run. Flush writes before ns-verify stops the worker.
MARKER=""
if [ -n "${NAMESPACE_DEVBOX_TASKS_DIR:-}" ]; then
  mkdir -p "$NAMESPACE_DEVBOX_TASKS_DIR"
  MARKER="$NAMESPACE_DEVBOX_TASKS_DIR/click-trace-$$"
  echo "click-trace $(date -u +%FT%TZ)" > "$MARKER"
fi
trap 'rm -f "$MARKER"; sync' EXIT

COMMIT=${1:?usage: click-trace-remote.sh <commit> [click-trace options]}
shift
TASK_DIR=$PWD
WORK=$HOME/perf-click-trace
TOOLS=$HOME/toolchains
BUN_DIR=$TOOLS/bun-1.3.14
NODE_DIR=$TOOLS/node-v24.15.0-linux-x64
CADDY_DIR=$TOOLS/caddy-2.11.7
mkdir -p "$TOOLS" "$WORK/src" "$WORK/results" "$TASK_DIR/click-results"

# The pinned toolchains, and Caddy for the HTTP/2 profiles.
if [ ! -x "$BUN_DIR/bun-linux-x64/bun" ]; then
  curl -fsSL -o /tmp/bun-1.3.14.zip \
    https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip
  rm -rf "$BUN_DIR" && mkdir -p "$BUN_DIR"
  python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" \
    /tmp/bun-1.3.14.zip "$BUN_DIR"
  chmod +x "$BUN_DIR/bun-linux-x64/bun"
fi
if [ ! -x "$NODE_DIR/bin/node" ]; then
  curl -fsSL https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz |
    tar -xJ -C "$TOOLS"
fi
if [ ! -x "$CADDY_DIR/caddy" ]; then
  mkdir -p "$CADDY_DIR"
  curl -fsSL https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_amd64.tar.gz |
    tar -xz -C "$CADDY_DIR" caddy
fi
export PATH="$BUN_DIR/bun-linux-x64:$NODE_DIR/bin:$CADDY_DIR:$PATH"
echo "bun $(bun --version), node $(node --version), $(caddy version | cut -d' ' -f1)," \
  "$(nproc) CPUs, $(free -g | awk '/Mem:/ {print $2}') GB"

if command -v rsync >/dev/null; then
  rsync -a --delete --exclude node_modules --exclude .local-dev \
    --exclude apps/web/dist --exclude .git ./ "$WORK/src/"
else
  # Without rsync, empty the checkout first so files deleted since the last
  # run cannot leak in. Keep the fixture (.local-dev) and root dependencies.
  find "$WORK/src" -mindepth 1 -maxdepth 1 ! -name node_modules \
    ! -name .local-dev -exec rm -rf {} +
  tar --exclude=./.git --exclude=./.local-dev --exclude=./apps/web/dist \
    --exclude=node_modules -cf - . | tar -xf - -C "$WORK/src"
fi
cd "$WORK/src"

bun install --frozen-lockfile
TOOL=${PERF_TOOL:-clicks}
if [ "$TOOL" = io-count ]; then
  if ! command -v strace >/dev/null; then
    sudo -n apt-get update -qq && sudo -n apt-get install -y -qq strace
  fi
else
  bun x playwright@1.61.1 install --with-deps chromium ||
    bun x playwright@1.61.1 install chromium
  # Workaround: a web build without a fixed id writes a build-id.txt that
  # differs from the id compiled into the client, and the tab reloads itself
  # on every navigation. Remove WORKTABLE_BUILD_ID once the product fix lands.
  WORKTABLE_BUILD_ID="perf-$COMMIT" bun run --cwd apps/web build
  bun scripts/perf/bundle.ts || true
fi

# Generate the fixture the trace will ask for (click-trace's defaults).
PROFILE=1k
SEED=1
for ((i = 1; i <= $#; i++)); do
  next=$((i + 1))
  case "${!i}" in
    --profile) PROFILE=${!next} ;;
    --seed) SEED=${!next} ;;
  esac
done
bun scripts/perf/fixtures.ts --profile "$PROFILE" --seed "$SEED"

OUT=$TASK_DIR/click-results/$(date -u +%Y%m%dT%H%M%SZ)-$TOOL-$PROFILE
status=0
SCRIPT=scripts/perf/click-trace.ts
[ "$TOOL" = io-count ] && SCRIPT=scripts/perf/io-count.ts
PERF_COMMIT=$COMMIT bun "$SCRIPT" --profile "$PROFILE" \
  --out "$OUT" "$@" || status=$?
cp -r "$OUT" "$WORK/results/" || true
exit $status
