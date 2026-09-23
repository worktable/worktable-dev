#!/bin/sh
set -eu

# Compatibility entrypoint: one packaged journey owns install, client config,
# HTTP/stdio MCP, and the explicitly requested native user-service checks.
ROOT_DIR=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
WORKTABLE_SMOKE_PORT=${WORKTABLE_E2E_PORT:-19436} \
WORKTABLE_SMOKE_KEEP=${WORKTABLE_E2E_KEEP:-0} \
WORKTABLE_SMOKE_HOLD=${WORKTABLE_E2E_HOLD:-0} \
WORKTABLE_SMOKE_BASE=${WORKTABLE_E2E_BASE:-/tmp} \
WORKTABLE_SMOKE_ROOT=${WORKTABLE_E2E_ROOT:-} \
exec sh "$ROOT_DIR/scripts/smoke-local-install.sh" "$@"
