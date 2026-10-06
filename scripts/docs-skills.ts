import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { WORKTABLE_SKILLS } from "./skill-inventory.ts"

// Navigation metadata only. Instructions and discovery descriptions live in SKILL.md.
export const SKILL_PAGES: Record<string, { slug: string; title: string }> = {
  "worktable-setup": { slug: "setup", title: "Set up Worktable" },
  "worktable-find-and-synthesize-context": {
    slug: "find-context",
    title: "Find context",
  },
  "worktable-create-or-update-docs": {
    slug: "writing-docs",
    title: "Edit documents",
  },
  "worktable-create-or-manage-interactive-html": {
    slug: "building-widgets",
    title: "Build HTML",
  },
  "worktable-create-or-manage-records": {
    slug: "records-and-schemas",
    title: "Manage records",
  },
  "worktable-review-with-annotations": {
    slug: "annotations-protocol",
    title: "Review annotations",
  },
  "worktable-collaborate-threads": { slug: "threads", title: "Use threads" },
}

export function parseSkill(source: string): {
  name: string
  description: string
  body: string
} {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) throw new Error("Skill needs YAML frontmatter")
  const metadata = Bun.YAML.parse(match[1]!) as Record<string, unknown>
  if (
    typeof metadata.name !== "string" ||
    typeof metadata.description !== "string"
  ) {
    throw new Error("Skill needs a name and description")
  }
  return {
    name: metadata.name,
    description: metadata.description,
    body: match[2]!
      .trimStart()
      .replace(/^# .*\r?\n+/, "")
      .trim(),
  }
}

export function sourceRevision(rootDir: string): string {
  try {
    const options = {
      cwd: rootDir,
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
    }
    const revision = execFileSync("git", ["rev-parse", "HEAD"], options).trim()
    const dirty = execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--",
        "plugins/worktable/skills",
        "plugins/worktable/skill-inventory.json",
        "skills",
      ],
      options
    ).trim()
    return `${revision}${dirty ? " (modified)" : ""}`
  } catch {
    return "source checkout"
  }
}

export async function publishSkills(rootDir: string): Promise<string[]> {
  const revision = sourceRevision(rootDir)
  const sourceRef = /^[a-f0-9]{40}$/.test(revision) ? revision : "main"
  const agentsDir = join(rootDir, "apps/docs/src/content/docs/agents")
  const currentPages = new Set(
    WORKTABLE_SKILLS.map(({ name }) => `${SKILL_PAGES[name]?.slug}.md`)
  )
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir)) {
      if (!file.endsWith(".md") || currentPages.has(file)) continue
      const path = join(agentsDir, file)
      if (
        /<!-- Generated at build time from (?:plugins\/worktable\/)?skills\//.test(
          readFileSync(path, "utf8")
        )
      ) {
        rmSync(path)
      }
    }
  }
  const publicDir = join(rootDir, "apps/docs/public")
  const rawDir = join(publicDir, ".well-known/skills")
  const downloadsDir = join(publicDir, "downloads/skills")
  // These directories contain only generated distribution files.
  rmSync(rawDir, { recursive: true, force: true })
  rmSync(downloadsDir, { recursive: true, force: true })
  const catalog = []
  const pages: string[] = []
  for (const skill of WORKTABLE_SKILLS) {
    const page = SKILL_PAGES[skill.name]
    if (!page) throw new Error(`Missing documentation route for ${skill.name}`)
    const skillDir = join(rootDir, skill.sourceDirectory)
    const source = readFileSync(join(skillDir, "SKILL.md"), "utf8")
    const { name, description, body } = parseSkill(source)
    if (name !== skill.name)
      throw new Error(`Skill name differs from inventory: ${skill.name}`)
    const files: Record<string, Uint8Array> = {}
    const digests: Record<string, string> = {}
    for (const file of skill.files) {
      const content = readFileSync(join(skillDir, file))
      files[`${name}/${file}`] = content
      digests[file] = createHash("sha256").update(content).digest("hex")
      await Bun.write(join(rawDir, name, file), content)
    }
    const download = `/downloads/skills/${name}.tar`
    await Bun.write(
      join(publicDir, download.slice(1)),
      await new Bun.Archive(files).blob()
    )
    const sourcePath = `${skill.sourceDirectory}/SKILL.md`
    const sourceUrl = `https://github.com/worktable/worktable-dev/blob/${sourceRef}/${sourcePath}`
    const relPath = `apps/docs/src/content/docs/agents/${page.slug}.md`
    const frontmatter = [
      "---",
      `title: ${JSON.stringify(page.title)}`,
      `description: ${JSON.stringify(description)}`,
      `editUrl: ${JSON.stringify(`https://github.com/worktable/worktable-dev/edit/main/${sourcePath}`)}`,
      "skill:",
      `  name: ${JSON.stringify(name)}`,
      `  revision: ${JSON.stringify(revision)}`,
      `  source: ${JSON.stringify(sourceUrl)}`,
      "---",
    ].join("\n")
    // The workflow is the canonical skill body, with no separate edited copy.
    await Bun.write(
      join(rootDir, relPath),
      `${frontmatter}\n\n<!-- Generated at build time from ${sourcePath}. -->\n\n${body}\n`
    )
    pages.push(relPath)
    catalog.push({
      name,
      description,
      files: skill.files,
      url: `/agents/${page.slug}/`,
      download,
      source: sourceUrl,
      sha256: digests,
    })
  }
  await Bun.write(
    join(rawDir, "index.json"),
    JSON.stringify({ revision, skills: catalog }, null, 2) + "\n"
  )
  return pages
}
