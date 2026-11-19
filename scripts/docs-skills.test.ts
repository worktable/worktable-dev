import { expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { WORKFLOW_GUIDES } from "../packages/server/src/mcp/workflow-guides.generated.ts"
import { publishSkills, parseSkill, SKILL_PAGES } from "./docs-skills.ts"
import {
  WORKFLOW_GUIDE_DIRECTORY,
  WORKTABLE_SKILLS,
} from "./skill-inventory.ts"

test("publishes complete canonical skill packages and matching readable workflows", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktable-doc-skills-"))
  try {
    const sources = [
      ...WORKTABLE_SKILLS.flatMap((skill) =>
        skill.files.map((file) => `${skill.sourceDirectory}/${file}`)
      ),
      ...Object.keys(WORKFLOW_GUIDES).map(
        (name) => `${WORKFLOW_GUIDE_DIRECTORY}/${name}.md`
      ),
    ]
    for (const path of sources) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(
        join(root, path),
        readFileSync(join(import.meta.dir, "..", path))
      )
    }
    const output = join(root, "apps/docs/public")
    mkdirSync(join(output, ".well-known/skills/retired"), { recursive: true })
    writeFileSync(join(output, ".well-known/skills/retired/SKILL.md"), "stale")
    const agentsDir = join(root, "apps/docs/src/content/docs/agents")
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, "retired.md"),
      "<!-- Generated at build time from plugins/worktable/skills/retired/SKILL.md. -->\nOld workflow"
    )
    writeFileSync(join(agentsDir, "overview.md"), "Hand-authored overview")
    await publishSkills(root)
    const catalog = await Bun.file(
      join(output, ".well-known/skills/index.json")
    ).json()
    expect(catalog.skills.map((skill: { name: string }) => skill.name)).toEqual(
      WORKTABLE_SKILLS.map((skill) => skill.name)
    )
    // A catalog OpenCode and Kilo refresh from: each skill has a version.
    for (const skill of catalog.skills)
      expect(skill.version).toMatch(/^[0-9a-f]{16}$/)
    expect(
      await Bun.file(
        join(output, ".well-known/skills/retired/SKILL.md")
      ).exists()
    ).toBe(false)
    expect(await Bun.file(join(agentsDir, "retired.md")).exists()).toBe(false)
    expect(readFileSync(join(agentsDir, "overview.md"), "utf8")).toBe(
      "Hand-authored overview"
    )
    for (const skill of WORKTABLE_SKILLS) {
      const archive = new Bun.Archive(
        await Bun.file(
          join(output, `downloads/skills/${skill.name}.tar`)
        ).arrayBuffer()
      )
      const entries = await archive.files()
      expect([...entries.keys()].sort()).toEqual(
        skill.files.map((file) => `${skill.name}/${file}`).sort()
      )
      for (const file of skill.files) {
        const source = readFileSync(join(root, skill.sourceDirectory, file))
        expect(
          new Uint8Array(
            await entries.get(`${skill.name}/${file}`)!.arrayBuffer()
          )
        ).toEqual(new Uint8Array(source))
        expect(
          readFileSync(join(output, `.well-known/skills/${skill.name}/${file}`))
        ).toEqual(source)
      }
      const source = readFileSync(
        join(root, skill.sourceDirectory, "SKILL.md"),
        "utf8"
      )
      const page = readFileSync(
        join(
          root,
          `apps/docs/src/content/docs/agents/${SKILL_PAGES[skill.name]!.slug}.md`
        ),
        "utf8"
      )
      // Apps install a pointer to the guide; the page shows the guide.
      const guide = WORKFLOW_GUIDES[skill.name as keyof typeof WORKFLOW_GUIDES]
      if (guide) {
        expect(source).toContain(`name: "${skill.name}"`)
        const guideBody = guide.replace(/^# .*\n+/, "")
        expect(page).toContain(guideBody)
        expect(source).not.toContain(guideBody.slice(0, 200))
      } else {
        expect(page).toContain(parseSkill(source).body)
      }
      expect(page).not.toMatch(/^# /m)
    }

    // The Gemini app uploads one folder with one SKILL.md.
    const gemini = await new Bun.Archive(
      await Bun.file(
        join(output, "downloads/skills/gemini/worktable.tar")
      ).arrayBuffer()
    ).files()
    expect([...gemini.keys()]).toEqual(["worktable/SKILL.md"])
    const combined = parseSkill(await gemini.get("worktable/SKILL.md")!.text())
    expect(combined.name).toBe("worktable")
    expect(combined.body).toContain("`worktable_state`")
    for (const name of Object.keys(WORKFLOW_GUIDES)) {
      expect(combined.body).toContain(`\`${name}\``)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
