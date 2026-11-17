import { join } from "node:path"
import skillInventory from "../plugins/worktable/skill-inventory.json" with { type: "json" }

export interface WorktableSkill {
  name: string
  files: string[]
  /** False for skills distributed outside the Worktable agent plugin. */
  bundled: boolean
  /** Repository-relative directory that holds the skill's source files. */
  sourceDirectory: string
  /**
   * Agent plugins that leave the skill out. Hermes and OpenClaw list the
   * team's Library skills themselves, so they skip the Library check.
   */
  skipIn: SkillRuntime[]
}

export type SkillRuntime = "hermes" | "openclaw"
const SKILL_RUNTIMES = new Set<string>(["hermes", "openclaw"])

/**
 * The full guide behind each bundled skill that points to one. The server
 * serves it through worktable_guidance (topic "workflow") and the docs show it,
 * while the SKILL.md that apps install only points there. It lives outside the
 * plugin so no installed copy carries it.
 */
export const WORKFLOW_GUIDE_DIRECTORY =
  "packages/server/src/mcp/workflow-guides"

export function workflowGuidePath(
  repositoryRoot: string,
  name: string
): string {
  return join(repositoryRoot, WORKFLOW_GUIDE_DIRECTORY, `${name}.md`)
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
    const skipIn = (skill as { skipIn?: unknown }).skipIn ?? []
    if (
      !Array.isArray(skipIn) ||
      skipIn.some((runtime) => !SKILL_RUNTIMES.has(runtime))
    ) {
      throw new Error(`Invalid skipIn for Worktable skill: ${skill.name}`)
    }
    const isBundled = bundled !== false
    return {
      name: skill.name,
      files: skill.files,
      bundled: isBundled,
      sourceDirectory: sourceDirectoryFor(skill.name, isBundled),
      skipIn: skipIn as SkillRuntime[],
    }
  })
}

/** Every Worktable skill, in inventory order. */
export const WORKTABLE_SKILLS = validatedSkillInventory()

/** Skills shipped inside the Worktable agent plugin. */
export const WORKTABLE_BUNDLED_SKILLS = WORKTABLE_SKILLS.filter(
  (skill) => skill.bundled
)

/** Skills an agent plugin ships, from those it draws on. */
export function skillsFor(
  runtime: SkillRuntime,
  skills: WorktableSkill[]
): WorktableSkill[] {
  return skills.filter((skill) => !skill.skipIn.includes(runtime))
}

export function skillSourcePath(
  repositoryRoot: string,
  skill: WorktableSkill,
  file: string
): string {
  return join(repositoryRoot, skill.sourceDirectory, file)
}
