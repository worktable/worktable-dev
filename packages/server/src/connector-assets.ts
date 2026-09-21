import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ============================================================
// Remote-agent connector assets (/connect.sh + /connect.mjs)
// ============================================================
//
// The instance serves its own connector: the agent machine can always reach
// this origin (that is the definition of being able to use MCP here), even
// in tailnet-only setups where npm or worktable.dev may be unreachable, and
// the served code is always version-matched to this server.
//
// Bundle resolution mirrors static-assets.ts: env override, release layout,
// executable-relative release layout, then the dev source tree (prebuilt
// dist, else an on-demand Bun.build of the mcp-connect package, cached for
// the process lifetime).

const RELEASE_BUNDLE_RELATIVE = join("connector", "connect.mjs");

let cachedBundle: string | null = null;

function possibleExecutableReleaseDirs(): string[] {
  const paths = [process.argv[1], process.execPath].filter(
    (value): value is string => Boolean(value)
  );
  const dirs: string[] = [];
  for (const executable of paths) {
    const binDir = dirname(resolve(executable));
    dirs.push(dirname(binDir));
  }
  return [...new Set(dirs)];
}

function bundleFileCandidates(): string[] {
  const candidates: string[] = [];
  const env = process.env["WORKTABLE_CONNECTOR_BUNDLE"]?.trim();
  if (env) candidates.push(resolve(env));
  const releaseDir = process.env["WORKTABLE_RELEASE_DIR"]?.trim();
  if (releaseDir) candidates.push(join(resolve(releaseDir), RELEASE_BUNDLE_RELATIVE));
  for (const dir of possibleExecutableReleaseDirs()) {
    candidates.push(join(dir, RELEASE_BUNDLE_RELATIVE));
  }
  // Source checkout with a prior `bun run --cwd packages/mcp-connect build`.
  candidates.push(join(import.meta.dir, "../../mcp-connect/dist/connect.mjs"));
  return candidates;
}

/** The bundled connector source, or null when unavailable in this install. */
export async function getConnectorBundle(): Promise<string | null> {
  if (cachedBundle) return cachedBundle;

  for (const candidate of bundleFileCandidates()) {
    if (existsSync(candidate)) {
      cachedBundle = readFileSync(candidate, "utf8");
      return cachedBundle;
    }
  }

  // Dev fallback: build from the workspace source on demand. Skipped in
  // release builds (no source tree next to the executable). The build runs
  // as a `bun build` subprocess, NOT in-process Bun.build: once a connector
  // dependency (e.g. @worktable/types/mcp-clients via the CLI graph) is
  // loaded as a runtime module in this process, a second in-process
  // Bun.build of it fails with a bogus "EISDIR reading file" (Bun 1.3.14),
  // which broke the full test suite while every file passed in isolation.
  const entry = join(import.meta.dir, "../../mcp-connect/scripts/build-connector.ts");
  if (existsSync(entry)) {
    try {
      const proc = Bun.spawn([process.execPath, entry, "--stdout"], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: dirname(entry),
      });
      // Drain BOTH pipes before awaiting exit: an undrained stderr can fill
      // its pipe buffer and deadlock the child against proc.exited.
      const [bundle, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode === 0 && bundle.trim()) {
        cachedBundle = bundle;
        return cachedBundle;
      }
    } catch {
      // Fall through to null; the route reports the miss.
    }
  }
  return null;
}

/** Test seam: resolution is cached for the process lifetime. */
export function resetConnectorBundleCacheForTests(): void {
  cachedBundle = null;
}

/**
 * The shell wrapper behind the Settings one-liner:
 *
 *   curl -fsSL https://host/connect.sh | sh -s -- ABCDE-FGHJK
 *
 * The serving route interpolates ONLY the validated server origin (never
 * request/user content) so the script knows where to fetch the bundle and
 * which server to pair against; the pairing code stays a positional argument.
 */
export function renderConnectScript(origin: string): string {
  // Belt and braces: the origin comes from resolveOrigin (already an
  // http(s) URL origin), but normalize through URL before embedding.
  const safeOrigin = new URL(origin).origin;
  return `#!/bin/sh
# Worktable remote agent connect — fetched from ${safeOrigin}
# Usage: curl -fsSL ${safeOrigin}/connect.sh | sh -s -- <pairing-code> [--client <id>] [--replace]
set -eu

ORIGIN="${safeOrigin}"

# A temp DIR with a fixed .mjs filename inside: Node refuses to execute ESM
# from an extension-less mktemp file, and template-suffix support differs
# between GNU and BSD mktemp. The full-template form works on both.
TMPD="$(mktemp -d "\${TMPDIR:-/tmp}/worktable-connect.XXXXXX")" || exit 1
TMP="$TMPD/connect.mjs"
trap 'rm -rf "$TMPD"' EXIT INT HUP TERM

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$ORIGIN/connect.mjs" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$ORIGIN/connect.mjs"
else
  echo "worktable-connect: curl or wget is required." >&2
  exit 1
fi

# The connector needs global fetch (Node 18+). An older node earlier in
# PATH must not shadow a usable bun.
RUNTIME=""
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  case "$NODE_MAJOR" in
    ''|*[!0-9]*) ;;
    *) [ "$NODE_MAJOR" -ge 18 ] && RUNTIME=node ;;
  esac
fi
if [ -z "$RUNTIME" ] && command -v bun >/dev/null 2>&1; then
  RUNTIME=bun
fi
if [ -z "$RUNTIME" ]; then
  echo "worktable-connect: Node 18+ or Bun is required on this machine." >&2
  echo "Manual setup: open $ORIGIN -> Settings -> Agents -> Manual install." >&2
  exit 1
fi

# No exec: it would replace the shell and skip the EXIT trap, leaking the
# temp dir on every successful connect. Run, then exit with the same status.
STATUS=0
"$RUNTIME" "$TMP" --server "$ORIGIN" "$@" || STATUS=$?
exit $STATUS
`;
}
