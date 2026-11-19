import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import inventory from "../../../plugins/worktable/skill-inventory.json" with { type: "json" }

// ============================================================
// Worktable's skills as a catalog (/.well-known/skills/)
// ============================================================
//
// OpenCode (`skills`) and Kilo (`skills.urls`) load skills from a URL that
// serves `index.json` ({ skills: [{ name, version, files }] }) and each file
// at `<url>/<name>/<file>`. They download a skill again when its version
// changes, so the skills update with this Worktable.
//
// Only the built-in skills this install ships, the same ones as the
// Worktable plugin: never workspace content or a team's Library skills, so
// the route needs no sign-in. Built once per process from the install's own
// copy of the skills.

export interface SkillCatalogEntry {
  name: string
  /** Changes exactly when one of the skill's files does. */
  version: string
  files: string[]
}

export interface SkillCatalog {
  index: { skills: SkillCatalogEntry[] }
  /** `<name>/<file>` to its contents. */
  files: Map<string, Buffer>
}

const RELEASE_SKILLS = join("integrations", "worktable-skills")

/** Where this install keeps its skills: the release copy, else the source tree. */
function skillSourceCandidates(): string[] {
  const releaseDir = process.env["WORKTABLE_RELEASE_DIR"]?.trim()
  if (releaseDir) return [join(resolve(releaseDir), RELEASE_SKILLS)]
  const executables = [process.argv[1], process.execPath].filter(
    (value): value is string => Boolean(value)
  )
  return [
    ...new Set(
      executables.map((path) =>
        join(dirname(dirname(resolve(path))), RELEASE_SKILLS)
      )
    ),
    resolve(import.meta.dir, "../../../plugins/worktable/skills"),
  ]
}

/**
 * The catalog for the skills in `sourceDir`. Each skill lists its top-level
 * files only: SKILL.md and its license. `agents/openai.yaml` is ChatGPT's
 * display metadata, and some OpenCode releases skip a skill whose files
 * include a folder.
 */
export function buildSkillCatalog(sourceDir: string): SkillCatalog {
  const files = new Map<string, Buffer>()
  const skills: SkillCatalogEntry[] = []
  for (const skill of inventory.skills) {
    if ((skill as { bundled?: boolean }).bundled === false) continue
    const served = skill.files.filter((file) => !file.includes("/"))
    const hash = createHash("sha256")
    for (const file of served) {
      const contents = readFileSync(join(sourceDir, skill.name, file))
      files.set(`${skill.name}/${file}`, contents)
      hash.update(`${file}\0${contents.length}\0`).update(contents)
    }
    skills.push({
      name: skill.name,
      version: hash.digest("hex").slice(0, 16),
      files: served,
    })
  }
  return { index: { skills }, files }
}

let cached: SkillCatalog | null = null

/** This install's catalog, or null when it ships no skills. */
export function getSkillCatalog(): SkillCatalog | null {
  if (cached) return cached
  const source = skillSourceCandidates().find((path) => existsSync(path))
  if (!source) return null
  try {
    cached = buildSkillCatalog(source)
  } catch {
    // An incomplete copy serves nothing rather than a partial catalog.
    return null
  }
  return cached
}

/** Test seam: the catalog is built once per process. */
export function resetSkillCatalogForTests(): void {
  cached = null
}
