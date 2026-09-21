#!/usr/bin/env bash
# Server start script
set -euo pipefail

# Ensure bun is on PATH (service managers often have a minimal PATH)
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Optionally load environment from a file (e.g. SECRETS_FILE=/path/to/secrets.env)
if [ -n "${SECRETS_FILE:-}" ] && [ -f "$SECRETS_FILE" ]; then
  set -a
  source "$SECRETS_FILE"
  set +a
fi

cd "$PROJECT_DIR"
exec bun run packages/server/src/index.ts "$@"
