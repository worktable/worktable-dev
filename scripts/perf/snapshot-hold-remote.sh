#!/usr/bin/env bash
# Temporary: base (main) against head snapshot hold timings on a Namespace runner.
#   bash scripts/perf/snapshot-hold-remote.sh <hot-versions> <rounds> <quiet> <loaded> [labels...]
set -euo pipefail
versions=${1:-9500}
rounds=${2:-2}
quiet=${3:-5}
loaded=${4:-3}
only=${5:-both}
git fetch -q --depth=1 origin main
git worktree add -q ../base FETCH_HEAD
echo "base $(git -C ../base rev-parse HEAD) head $(git rev-parse HEAD)"
(cd ../base && bun install --frozen-lockfile >/dev/null)
nproc
free -g
mkdir -p test-results
bun scripts/perf/snapshot-hold.ts --fixture /tmp/hold/fixture --build \
  --documents 1000 --hot-versions "$versions" 2>&1 | tee "test-results/build-$versions.log"
checkouts=(--checkout ../base --label main --checkout . --label head)
[ "$only" = head ] && checkouts=(--checkout . --label head)
bun scripts/perf/snapshot-hold.ts --fixture /tmp/hold/fixture "${checkouts[@]}" \
  --rounds "$rounds" --quiet "$quiet" --loaded "$loaded" \
  --out "test-results/hold-$versions.json" 2>&1 | tee "test-results/hold-$versions.log"
