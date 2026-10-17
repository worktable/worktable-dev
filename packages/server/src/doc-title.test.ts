import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SpaceFile } from "@worktable/types"
import { renameDocToTitle } from "./doc-title.ts"
import { renameDocAndSync } from "./doc-rename.ts"
import { withMarkdownTitle } from "./doc-title-text.ts"
import { resolveDocAlias } from "./doc-aliases.ts"
import { docExists, readDoc, writeDoc, writeSpace } from "./store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"
import { yjsManager } from "./yjs-manager.ts"

const testDir = join(tmpdir(), `worktable-doc-title-${Date.now()}`)

function makeSpace(id: string): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

const text = (value: string) => [{ type: "text", text: value, styles: {} }]
const heading = (id: string, value: string) => ({
  id,
  type: "heading",
  props: { level: 1 },
  content: text(value),
  children: [],
})
const paragraph = (id: string, value: string) => ({
  id,
  type: "paragraph",
  content: text(value),
  children: [],
})

function titleOf(blocks: unknown): unknown {
  const first = (blocks as Array<{ type: string; content: Array<{ text: string }> }>)[0]
  return first?.type === "heading" ? first.content.map((item) => item.text).join("") : null
}

beforeEach(async () => {
  mkdirSync(testDir, { recursive: true })
  setWorkspaceRootOverride(testDir)
  ensureWorkspaceManifest()
  await writeSpace(makeSpace("space"))
})

afterEach(async () => {
  await yjsManager.shutdown()
  setWorkspaceRootOverride(null)
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
})

describe("renaming a Doc by its title", () => {
  it("sets the title and moves the Doc to a free path made from it, keeping old links", async () => {
    await writeDoc("space", "plans/untitled", [heading("t", "Draft"), paragraph("p", "Body")])
    await writeDoc("space", "plans/hiring", [paragraph("x", "Taken")])

    const outcome = await renameDocToTitle("space", "plans/untitled", "Hiring", "user")

    expect(outcome).toEqual({
      renamed: [{ from: "plans/untitled", to: "plans/hiring-2" }],
      error: null,
    })
    const moved = await readDoc("space", "plans/hiring-2")
    expect(titleOf(moved.data)).toBe("Hiring")
    expect((moved.data as Array<{ id: string }>).map((block) => block.id)).toEqual(["t", "p"])
    expect(await docExists("space", "plans/hiring")).toBe(true)
    expect((await resolveDocAlias("space", "plans/untitled")).path).toBe("plans/hiring-2")

    // A path a moved Doc left for its old links is taken too.
    await writeDoc("space", "plans/budget", [paragraph("b", "Moved away")])
    await renameDocAndSync("space", "plans/budget", "archive/budget")
    expect((await renameDocToTitle("space", "plans/hiring", "Budget", "user")).renamed).toEqual([
      { from: "plans/hiring", to: "plans/budget-2" },
    ])

    // Renaming to the name it already has leaves the path alone.
    expect(await renameDocToTitle("space", "plans/hiring-2", "Hiring", "user")).toEqual({
      renamed: [{ from: "plans/hiring-2", to: "plans/hiring-2" }],
      error: null,
    })
  })

  it("gives an open Doc without a title one, leaving what people typed in place", async () => {
    await writeDoc("space", "notes", [paragraph("p", "First line")])
    await yjsManager.getOrCreateDoc("space", "notes")

    const outcome = await renameDocToTitle("space", "notes", "Weekly notes", "user")

    expect(outcome.error).toBeNull()
    expect(outcome.renamed).toEqual([{ from: "notes", to: "weekly-notes" }])
    const live = await yjsManager.liveBlocks("space", "weekly-notes")
    expect(titleOf(live)).toBe("Weekly notes")
    expect((live as Array<{ id: string }>)[1]?.id).toBe("p")
  })

  it("moves a Doc to the name its title gives, and leaves one without a title alone", async () => {
    await writeDoc("space", "untitled", [heading("t", "Launch notes"), paragraph("p", "Body")])
    await writeDoc("space", "untitled-2", [heading("e", ""), paragraph("q", "Body")])

    expect(await renameDocToTitle("space", "untitled", undefined, "user")).toEqual({
      renamed: [{ from: "untitled", to: "launch-notes" }],
      error: null,
    })
    expect(await renameDocToTitle("space", "untitled-2", undefined, "user")).toEqual({
      renamed: [],
      error: null,
    })
    expect(await docExists("space", "untitled-2")).toBe(true)
  })

  it("sets a Markdown Doc's opening heading", () => {
    expect(withMarkdownTitle("# Old\n\nBody", "New")).toBe("# New\n\nBody")
    expect(withMarkdownTitle("Old\n===\n\nBody", "New")).toBe("# New\n\nBody")
    expect(withMarkdownTitle("Body only", "New")).toBe("# New\n\nBody only")
    expect(withMarkdownTitle("## Section\n\nBody", "New")).toBe("# New\n\n## Section\n\nBody")
    expect(withMarkdownTitle("\uFEFF# Old\n\nBody", "New")).toBe("\uFEFF# New\n\nBody")
    expect(withMarkdownTitle("# Old\r\n\r\nBody\r\n", "New")).toBe("# New\r\n\r\nBody\r\n")
    expect(withMarkdownTitle("Body\r\n", "New")).toBe("# New\r\n\r\nBody\r\n")
  })
})
