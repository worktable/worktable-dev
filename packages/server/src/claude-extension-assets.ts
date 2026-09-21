import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const RELEASE_BUNDLE_RELATIVE = join(
  "integrations",
  "worktable-claude-desktop.mcpb"
)

let cachedBundle: Buffer | null = null

function possibleExecutableReleaseDirs(): string[] {
  const paths = [process.argv[1], process.execPath].filter(
    (value): value is string => Boolean(value)
  )
  return [
    ...new Set(
      paths.map((executable) => dirname(dirname(resolve(executable))))
    ),
  ]
}

function bundleCandidates(): string[] {
  const candidates: string[] = []
  const override = process.env["WORKTABLE_CLAUDE_MCPB_BUNDLE"]?.trim()
  // An explicit override is authoritative. Falling through from a typo to a
  // development artifact could serve a different Worktable version silently.
  if (override) return [resolve(override)]

  const releaseDir = process.env["WORKTABLE_RELEASE_DIR"]?.trim()
  if (releaseDir) {
    candidates.push(join(resolve(releaseDir), RELEASE_BUNDLE_RELATIVE))
  }
  for (const dir of possibleExecutableReleaseDirs()) {
    candidates.push(join(dir, RELEASE_BUNDLE_RELATIVE))
  }
  candidates.push(
    join(
      import.meta.dir,
      "../../mcp-connect/dist/worktable-claude-desktop.mcpb"
    )
  )
  return [...new Set(candidates)]
}

/** Return the secret-free extension matching this installed Worktable build. */
export function getClaudeDesktopExtensionBundle(): Buffer | null {
  if (cachedBundle) return cachedBundle
  for (const candidate of bundleCandidates()) {
    if (!existsSync(candidate)) continue
    cachedBundle = readFileSync(candidate)
    return cachedBundle
  }
  return null
}

/** Test seam: production resolution is cached for the life of the process. */
export function resetClaudeDesktopExtensionCacheForTests(): void {
  cachedBundle = null
}
