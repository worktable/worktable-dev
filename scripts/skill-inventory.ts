import { join } from "node:path"
import skillInventory from "../plugins/worktable/skill-inventory.json" with { type: "json" }

export interface WorktableSkill {
  name: string
  files: string[]
  /** False for skills distributed outside the Worktable agent plugin. */
  bundled: boolean
  /** Repository-relative directory that holds the skill's source files. */
  sourceDirectory: string
}

// Plugin skills live in the plugin bundle. Skills that directories would
// reject inside a plugin, such as one that runs the installer, live under
// skills/ and ship only through the standalone skill channels.
function sourceDirectoryFor(name: string, bundled: boolean): string {
  return bundled ? `plugins/worktable/skills/${name}` : `skills/${name}`
}

function validatedSkillInventory(): WorktableSkill[] {
  if (
    skillInventory.schemaVersion !== 1 ||
    !Array.isArray(skillInventory.skills)
  ) {
    throw new Error("Invalid Worktable skill inventory")
  }
  const names = new Set<string>()
  return skillInventory.skills.map((skill) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skill.name) || names.has(skill.name)) {
      throw new Error(
        `Invalid or duplicate Worktable skill name: ${skill.name}`
      )
    }
    names.add(skill.name)
    const bundled = (skill as { bundled?: unknown }).bundled
    if (bundled !== undefined && typeof bundled !== "boolean") {
      throw new Error(`Invalid bundled flag for Worktable skill: ${skill.name}`)
    }
    const files = new Set<string>()
    for (const path of skill.files) {
      const segments = path.split("/")
      if (
        segments.some(
          (segment) =>
            !segment ||
            segment === "." ||
            segment === ".." ||
            !/^[A-Za-z0-9._-]+$/.test(segment)
        ) ||
        files.has(path)
      ) {
        throw new Error(`Invalid or duplicate skill file path: ${path}`)
      }
      files.add(path)
    }
    const isBundled = bundled !== false
    return {
      name: skill.name,
      files: skill.files,
      bundled: isBundled,
      sourceDirectory: sourceDirectoryFor(skill.name, isBundled),
    }
  })
}

/** Every Worktable skill, in inventory order. */
export const WORKTABLE_SKILLS = validatedSkillInventory()

/** Skills shipped inside the Worktable agent plugin. */
export const WORKTABLE_BUNDLED_SKILLS = WORKTABLE_SKILLS.filter(
  (skill) => skill.bundled
)

export function skillSourcePath(
  repositoryRoot: string,
  skill: WorktableSkill,
  file: string
): string {
  return join(repositoryRoot, skill.sourceDirectory, file)
}
