import { afterEach, describe, expect, it } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Hono } from "hono"
import inventory from "../../../plugins/worktable/skill-inventory.json" with { type: "json" }
import { wellKnownRouter } from "./routes/well-known.ts"
import { buildSkillCatalog, resetSkillCatalogForTests } from "./skill-catalog.ts"

const SKILLS = resolve(import.meta.dir, "../../../plugins/worktable/skills")
const BUNDLED = inventory.skills
  .filter((skill) => (skill as { bundled?: boolean }).bundled !== false)
  .map((skill) => skill.name)

let tempDir: string | null = null

afterEach(() => {
  resetSkillCatalogForTests()
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = null
})

function app(): Hono {
  return new Hono().route("/.well-known", wellKnownRouter)
}

async function get(path: string): Promise<Response> {
  return app().fetch(new Request(`http://localhost${path}`))
}

describe("GET /.well-known/skills", () => {
  it("serves the plugin's skills the way OpenCode and Kilo fetch them", async () => {
    const response = await get("/.well-known/skills/index.json")
    expect(response.status).toBe(200)
    const index = (await response.json()) as {
      skills: { name: string; version: string; files: string[] }[]
    }
    expect(index.skills.map((skill) => skill.name)).toEqual(BUNDLED)
    for (const skill of index.skills) {
      expect(skill.files).toContain("SKILL.md")
      expect(skill.files.every((file) => !file.includes("/"))).toBe(true)
      for (const file of skill.files) {
        const served = await get(`/.well-known/skills/${skill.name}/${file}`)
        expect(served.status).toBe(200)
        expect(Buffer.from(await served.arrayBuffer())).toEqual(
          readFileSync(join(SKILLS, skill.name, file))
        )
      }
    }
  })

  it("serves nothing outside the catalog", async () => {
    for (const path of [
      "/.well-known/skills/worktable-setup/SKILL.md",
      "/.well-known/skills/worktable-library/agents%2Fopenai.yaml",
      "/.well-known/skills/..%2F..%2Fskill-inventory.json/x",
    ]) {
      const response = await get(path)
      expect(response.status).toBe(404)
      expect(response.headers.get("Content-Type")).toContain("application/json")
    }
  })

  it("changes a skill's version only when its files change", () => {
    tempDir = mkdtempSync(join(tmpdir(), "worktable-skill-catalog-"))
    cpSync(SKILLS, tempDir, { recursive: true })
    const before = buildSkillCatalog(tempDir).index.skills
    const path = join(tempDir, "worktable-library", "SKILL.md")
    writeFileSync(path, `${readFileSync(path, "utf8")}\nOne more line.\n`)
    const after = buildSkillCatalog(tempDir).index.skills
    for (const [index, skill] of after.entries()) {
      if (skill.name === "worktable-library")
        expect(skill.version).not.toBe(before[index]!.version)
      else expect(skill.version).toBe(before[index]!.version)
    }
  })
})
