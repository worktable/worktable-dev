import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseChangedFiles } from "./contents-background.ts"
import { closeDerivedStore, derivedStore } from "./derived-store.ts"
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

    await writeFile(join(docs, "report.pdf"), smallPdf([{ text: "Second edition" }]))
    noteSpaceChanged(spaceId)
    expect(await parseChangedFiles(spaceId)).toBe(1)
    // Only the new version's contents stay.
    const [row] = kept()
    expect(kept()).toHaveLength(1)
    expect(derivedStore().readContentsLines({ ...row!, spaceId })?.text).toContain("Second edition")
  }, 60_000)
})
