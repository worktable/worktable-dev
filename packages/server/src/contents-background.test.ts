import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseChangedFiles, startContentsBackground } from "./contents-background.ts"
import { closeDerivedStore, derivedStore, derivedStoreDir } from "./derived-store.ts"
import { writeSpace } from "./store.ts"
import { smallPdf } from "./test-support/small-pdf.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  writeWorkspaceManifest,
} from "./workspace.ts"
import { noteSpaceChanged } from "./workspace-read-model.ts"

const spaceId = "background"
let root: string
let previousFiles: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-contents-background-"))
  setWorkspaceRootOverride(root)
  closeDerivedStore()
  writeWorkspaceManifest({ ...ensureWorkspaceManifest(), version: 2 })
  previousFiles = process.env["WORKTABLE_FILES"]
  process.env["WORKTABLE_FILES"] = "1"
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Background",
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    createdBy: "test",
    settings: {},
  })
  await mkdir(join(root, "spaces", spaceId, "docs"), { recursive: true })
})

afterEach(async () => {
  if (previousFiles === undefined) delete process.env["WORKTABLE_FILES"]
  else process.env["WORKTABLE_FILES"] = previousFiles
  closeDerivedStore()
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("parsing in the background", () => {
  it("parses a PDF once its bytes change, and only then", async () => {
    const docs = join(root, "spaces", spaceId, "docs")
    await writeFile(join(docs, "report.pdf"), smallPdf([{ text: "First edition" }]))
    await writeFile(join(docs, "notes.txt"), "Text is read from the file itself.\n")
    noteSpaceChanged(spaceId)

    expect(await parseChangedFiles(spaceId)).toBe(1)
    const kept = () => derivedStore().listing(spaceId).filter((row) => row.kind === "contents")
    expect(kept()).toHaveLength(1)
    // Nothing changed: nothing is read or parsed again.
    expect(await parseChangedFiles(spaceId)).toBe(0)
    // A new start of the background looks again, and finds it kept.
    const stop = startContentsBackground()
    await stop()
    expect(await parseChangedFiles(spaceId)).toBe(0)
    closeDerivedStore()
    await rm(derivedStoreDir(), { recursive: true, force: true })
    // The store was removed, as a workspace reset removes it: a new start
    // parses the PDF again.
    await startContentsBackground()()
    expect(await parseChangedFiles(spaceId)).toBe(1)

    await writeFile(join(docs, "report.pdf"), smallPdf([{ text: "Second edition" }]))
    noteSpaceChanged(spaceId)
    expect(await parseChangedFiles(spaceId)).toBe(1)
    // Only the new version's contents stay.
    const [row] = kept()
    expect(kept()).toHaveLength(1)
    expect(derivedStore().readContentsLines({ ...row!, spaceId })?.text).toContain("Second edition")
  }, 60_000)

  it("parses a Space within its hour's budget, and says when it can go on", async () => {
    const docs = join(root, "spaces", spaceId, "docs")
    for (const name of ["one", "two", "three"]) {
      await writeFile(join(docs, `${name}.pdf`), smallPdf([{ text: `Report ${name}` }]))
    }
    noteSpaceChanged(spaceId)
    let resumesAt: number | null = null
    // A budget one parse uses up: the pass stops there and says when it resumes.
    expect(await parseChangedFiles(spaceId, { budgetMs: 1, deferred: (at) => (resumesAt = at) })).toBe(1)
    expect(resumesAt).toBeGreaterThan(Date.now() + 50 * 60_000)
    expect(await parseChangedFiles(spaceId, { budgetMs: 1 })).toBe(0)
    // With the hour's budget, the rest are parsed.
    expect(await parseChangedFiles(spaceId)).toBe(2)
  }, 60_000)

  it("goes on past a file it can't read, and reads it once it can", async () => {
    // Root reads any file, so the unreadable one can't be made there.
    if (process.getuid?.() === 0) return
    const docs = join(root, "spaces", spaceId, "docs")
    await writeFile(join(docs, "a-locked.pdf"), smallPdf([{ text: "Locked away" }]))
    await writeFile(join(docs, "b-open.pdf"), smallPdf([{ text: "Open to read" }]))
    await chmod(join(docs, "a-locked.pdf"), 0o000)
    noteSpaceChanged(spaceId)
    expect(await parseChangedFiles(spaceId)).toBe(1)
    await chmod(join(docs, "a-locked.pdf"), 0o644)
    expect(await parseChangedFiles(spaceId)).toBe(1)
  }, 60_000)
})
