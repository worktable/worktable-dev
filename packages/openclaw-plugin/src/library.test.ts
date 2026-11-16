import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LibrarySkillFolder, librarySkillsFrom } from "./library.js"

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

describe("the team's Library skills as OpenClaw skills", () => {
  it("keeps a pointer per skill by when to use it, drops removed ones, and changes nothing when Worktable can't answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "worktable-library-"))
    folders.push(root)
    const folder = join(root, "library")
    const answers: Array<Record<string, unknown> | Error> = [
      {
        skills: [
          { name: "release-checklist", description: "Use when shipping a release.", library: "Worktable" },
          { name: "Not A Name", description: "x" },
          // A name two libraries share lists once per library, each read from its own.
          { name: "pay-guide", description: "Use when paying.", library: "Space: Ops", read: { library: "space", spaceId: "ops" } },
          { name: "pay-guide", description: "Use when paying.", library: "Yours", read: { library: "agent" } },
          // Never in place of another skill, even one with the name a shared one would get.
          { name: "pay-guide", description: "Use when paying.", library: "Space: Ops", read: { library: "space", spaceId: "east" } },
          { name: "pay-guide-yours", description: "Use when paying yourself.", library: "Worktable" },
        ],
      },
      new Error("unreachable"),
      { skills: [] },
    ]
    const skills = new LibrarySkillFolder(folder, async () => {
      const answer = answers.shift()!
      if (answer instanceof Error) throw answer
      return librarySkillsFrom(answer)
    })

    expect(await skills.refresh()).toBe(true)
    const listed = await readFile(join(folder, "release-checklist", "SKILL.md"), "utf8")
    expect(listed).toContain('description: "Use when shipping a release."')
    expect(listed).toContain('worktable_skills_read tool (name: "release-checklist")')
    const shared = await readFile(join(folder, "pay-guide-space-ops", "SKILL.md"), "utf8")
    expect(shared).toContain('(name: "pay-guide", library: "space", spaceId: "ops")')
    expect((await readdir(folder)).sort()).toEqual([
      "pay-guide-space-ops",
      "pay-guide-space-ops-east",
      "pay-guide-yours",
      "pay-guide-yours-2",
      "release-checklist",
    ])
    expect(await readFile(join(folder, "pay-guide-yours-2", "SKILL.md"), "utf8")).toContain('library: "agent"')

    expect(await skills.refresh()).toBe(false)
    expect(await readdir(folder)).toHaveLength(5)

    expect(await skills.refresh()).toBe(true)
    expect(await readdir(folder)).toEqual([])
  })
})
