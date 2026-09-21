/**
 * Worktable Labs — seed-time workspace-manifest rewrite.
 *
 * A snapshot copied into a sandbox must get (a) a FRESH workspace id (so id-keyed
 * app-private state — Yjs/caches — never bleeds between source and copy) and (b) a
 * `provenance` block marking it as a disposable, one-way sandbox/staging/fixture copy.
 * This runs HOST-side (never modifies the source), and the generated manifest is copied
 * into the guest over the seeded one. The Microsandbox and Desktop manual lab
 * fixture seeders share this contract.
 */
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

export type WorkspaceMode = "daily" | "staging" | "sandbox" | "fixture"

export interface ProvenanceOpts {
  mode: WorkspaceMode
  /** Human label for the source (defaults to the source dir's basename). */
  label?: string
  /** Source path on the host. */
  path?: string
  /** For mode "fixture": the fixture name. */
  fixtureName?: string
  /** Override the snapshot timestamp (default: now). */
  snapshotAt?: string
}

function freshId(): string {
  return `ws_${randomBytes(16).toString("base64url")}`
}

/** Read a source workspace manifest and return a rewritten one (fresh id + provenance). */
export function buildProvenanceManifest(
  sourceDir: string,
  opts: ProvenanceOpts
): Record<string, unknown> {
  const manifestPath = join(sourceDir, "worktable.workspace.json")
  let source: Record<string, unknown> = {}
  if (existsSync(manifestPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
      if (parsed && typeof parsed === "object")
        source = parsed as Record<string, unknown>
    } catch {
      // Unreadable/absent source manifest -> fall back to defaults below.
    }
  }
  const name = typeof source["name"] === "string" ? source["name"] : "Workspace"
  const createdAt =
    typeof source["createdAt"] === "string"
      ? source["createdAt"]
      : new Date().toISOString()
  const sourceId = typeof source["id"] === "string" ? source["id"] : undefined

  return {
    type: "worktable.workspace",
    version: 1,
    id: freshId(),
    name,
    createdAt,
    cloud: { status: "unlinked" },
    provenance: {
      mode: opts.mode,
      source: {
        ...(sourceId ? { workspaceId: sourceId } : {}),
        label: opts.label ?? basename(sourceDir),
        ...(opts.path ? { path: opts.path } : {}),
      },
      snapshotAt: opts.snapshotAt ?? new Date().toISOString(),
      oneWay: true,
      disposable: opts.mode === "sandbox",
      ...(opts.fixtureName ? { fixtureName: opts.fixtureName } : {}),
    },
  }
}

// CLI for one-off workspace-copy tooling:
//   manifest-provenance.ts --source <dir> --out <file> [--mode sandbox] [--label L] [--path P] [--fixture NAME]
if (import.meta.main) {
  const argv = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const source = get("--source")
  const out = get("--out")
  if (!source || !out) {
    console.error(
      "usage: manifest-provenance.ts --source <dir> --out <file> [--mode sandbox] [--label L] [--path P] [--fixture NAME]"
    )
    process.exit(2)
  }
  const modeArg = get("--mode") ?? "sandbox"
  const MODES: readonly string[] = ["daily", "staging", "sandbox", "fixture"]
  if (!MODES.includes(modeArg)) {
    console.error(`--mode must be one of ${MODES.join(", ")} (got ${modeArg})`)
    process.exit(2)
  }
  const manifest = buildProvenanceManifest(source, {
    mode: modeArg as WorkspaceMode,
    label: get("--label"),
    path: get("--path"),
    fixtureName: get("--fixture"),
  })
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
}
