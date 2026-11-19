import { existsSync } from "node:fs"
import { readJsonObject, writeJsonObject } from "./client-config.ts"
import { projectSkills, type SkillsReport } from "./skill-plugin.ts"

// ============================================================
// Worktable's skills for OpenCode and Kilo, from the Worktable itself
// ============================================================
//
// Both load skills from a URL that serves a catalog, and download a skill
// again when its version changes. The connected Worktable serves its own
// skills at /.well-known/skills/ (packages/server/src/skill-catalog.ts), so
// the connect command adds that address to the client's settings, next to
// the connection, and the skills update with the Worktable. When it can't,
// the skills are copied to ~/.agents/skills, which both read. Nothing here
// can fail the connection: every outcome is a line to show.
//
// Must stay runnable under plain Node 18+, like the rest of the connector.

export type SkillCatalogClient = "opencode" | "kilo"

export const SKILL_CATALOG_CLIENTS: readonly SkillCatalogClient[] = [
  "opencode",
  "kilo",
]

export function isSkillCatalogClient(
  id: string | null
): id is SkillCatalogClient {
  return (SKILL_CATALOG_CLIENTS as readonly string[]).includes(id ?? "")
}

/** The catalog a Worktable at `origin` serves. */
export function skillCatalogUrl(origin: string): string {
  return `${new URL(origin).origin}/.well-known/skills/`
}

const LABELS: Record<SkillCatalogClient, string> = {
  opencode: "OpenCode",
  kilo: "Kilo",
}

const RESTART_HINTS: Record<SkillCatalogClient, string> = {
  opencode: "Restart OpenCode to load Worktable.",
  kilo: "Run /reload in Kilo, or start a new session, to load Worktable.",
}

const SKILLS_GUIDE = "https://docs.worktable.dev/agents/skills/"

export interface SkillCatalogDependencies {
  /** Null when the catalog lists skills, else what went wrong. */
  checkCatalog(url: string): Promise<string | null>
  projectSkills: typeof projectSkills
}

async function checkCatalog(url: string): Promise<string | null> {
  try {
    const response = await fetch(new URL("index.json", url))
    if (!response.ok) return `its skills address returned HTTP ${response.status}`
    const index = (await response.json()) as { skills?: unknown }
    return Array.isArray(index.skills) && index.skills.length > 0
      ? null
      : "its skills address lists no skills"
  } catch (error) {
    return `couldn't reach its skills address: ${(error as Error).message}`
  }
}

/**
 * Add `url` to the `skills` setting: a list of paths and addresses, or
 * Kilo's older `{ paths, urls }`. True when it was already there.
 */
export function addSkillCatalog(configPath: string, url: string): boolean {
  const root = existsSync(configPath) ? readJsonObject(configPath) : {}
  const skills = root["skills"]
  let list: unknown[]
  if (skills === undefined) {
    list = []
    root["skills"] = list
  } else if (Array.isArray(skills)) {
    list = skills
  } else if (skills && typeof skills === "object") {
    const object = skills as Record<string, unknown>
    const urls = object["urls"] ?? []
    if (!Array.isArray(urls)) throw new Error("its skills.urls setting isn't a list")
    object["urls"] = urls
    list = urls
  } else {
    throw new Error("its skills setting isn't a list")
  }
  if (list.includes(url)) return true
  list.push(url)
  writeJsonObject(configPath, root)
  return false
}

/** Point OpenCode or Kilo at the Worktable's skills, else copy them. */
export async function setUpCatalogSkills(
  client: SkillCatalogClient,
  target: { origin: string; configPath: string },
  overrides: Partial<SkillCatalogDependencies> = {}
): Promise<SkillsReport> {
  const dependencies: SkillCatalogDependencies = {
    checkCatalog,
    projectSkills,
    ...overrides,
  }
  const label = LABELS[client]
  const url = skillCatalogUrl(target.origin)
  const lines: string[] = []
  const report = (outcome: SkillsReport["outcome"]): SkillsReport => ({
    outcome,
    lines,
    restartHint: RESTART_HINTS[client],
  })

  let reason = await dependencies.checkCatalog(url)
  if (!reason) {
    try {
      const already = addSkillCatalog(target.configPath, url)
      lines.push(
        already
          ? `  ${label}: Worktable skills already added`
          : `  ${label}: Worktable skills added from ${url}`
      )
      return report({ via: "catalog", alreadyAdded: already })
    } catch (error) {
      reason = (error as Error).message
    }
  }

  const copyError = await dependencies.projectSkills("agents")
  lines.push(
    copyError
      ? `  Couldn't add Worktable's skills to ${label} (${reason}; ${copyError}). See ${SKILLS_GUIDE}`
      : `  Couldn't add Worktable's skills address to ${label} (${reason}), so its skills were copied to ~/.agents/skills instead.`
  )
  return report({
    via: "copy",
    reason,
    copied: copyError === null,
    ...(copyError ? { copyError } : {}),
  })
}
