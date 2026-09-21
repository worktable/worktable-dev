import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SpaceFile } from "@worktable/types"
import {
  createAnnotation,
  listAnnotations,
  readAnnotation,
} from "./annotation-store.ts"
import { renameDocAndSync, renameDocsByPrefixAndSync } from "./doc-rename.ts"
import { moveDocumentFolder } from "./document-folder-move.ts"
import { buildDocumentCatalog } from "./document-catalog.ts"
import { setDocumentLifecycleStepHookForTests } from "./document-lifecycle-journal.ts"
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts"
import { resolveDocAlias } from "./doc-aliases.ts"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import { onDocContentChanged } from "./content-events.ts"
import { docExists, readDoc, writeDoc, writeSpace } from "./store.ts"
import {
  ensureWorkspaceManifest,
  getDocAliasesPath,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { buildWidgetFile } from "./widget-authoring.ts"
import { readWidget, readWidgetHtml, writeWidget } from "./widget-store.ts"

const testDir = join(tmpdir(), `worktable-doc-rename-lifecycle-${Date.now()}`)

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

async function claimMarkdown(path: string): Promise<string> {
  const documentId = mintDocumentId()
  await updateDocumentInventory("space", {
    upsert: [
      {
        documentId,
        path,
        format: { id: "worktable.markdown", sourceVersion: 1 },
        source: { kind: "file", relativePath: `docs/${path}.md` },
      },
    ],
  })
  return documentId
}

beforeEach(async () => {
  mkdirSync(testDir, { recursive: true })
  setWorkspaceRootOverride(testDir)
  ensureWorkspaceManifest()
  await writeSpace(makeSpace("space"))
})

afterEach(() => {
  setDocumentLifecycleStepHookForTests(null)
  setWorkspaceRootOverride(null)
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
})

describe("document rename lifecycle", () => {
  it("gives MCP the same annotation-aware rename lifecycle as REST", async () => {
    await writeDoc("space", "old", "# Old")
    const documentId = mintDocumentId()
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId,
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    })
    const created = await createAnnotation("space", {
      target: { type: "doc", docPath: "old" },
      category: "comment",
      body: "Move with the document.",
    })

    const contentSignals: string[] = []
    const workspaceSignals: string[] = []
    const stopContent = onDocContentChanged((_spaceId, path) => {
      contentSignals.push(path)
    })
    const stopWorkspace = onWorkspaceChange((event) => {
      workspaceSignals.push(event.type)
    })

    let result: { ok: boolean; oldPath: string; newPath: string }
    try {
      result = (await dispatchOperation("docs.rename", {
        spaceId: "space",
        oldPath: "/old",
        newPath: "/folder/new",
      })) as { ok: boolean; oldPath: string; newPath: string }
    } finally {
      stopContent()
      stopWorkspace()
    }

    expect(result).toEqual({ ok: true, oldPath: "old", newPath: "folder/new" })
    expect(contentSignals).toHaveLength(2)
    expect(contentSignals).toContain("old")
    expect(contentSignals).toContain("folder/new")
    expect(workspaceSignals).toContain("documentCorpus")
    expect(await docExists("space", "old")).toBe(false)
    expect(await docExists("space", "folder/new")).toBe(true)
    expect((await resolveDocAlias("space", "old")).path).toBe("folder/new")
    const oldPathRead = (await dispatchOperation("docs.read", {
      spaceId: "space",
      docPath: "/old",
    })) as { docPath: string; content: string }
    expect(oldPathRead.docPath).toBe("folder/new")
    expect(oldPathRead.content).toContain("Old")
    await expect(
      dispatchOperation("docs.write", {
        spaceId: "space",
        docPath: "old",
        content: "# Replacement",
      })
    ).rejects.toThrow("reserved")
    expect(
      (await listAnnotations("space", { target: { docPath: "old" } })).total
    ).toBe(0)

    const moved = await readAnnotation("space", created.annotation.id)
    expect("docPath" in moved.target && moved.target.docPath).toBe("folder/new")
    const catalog = await buildDocumentCatalog({
      workspaceRoot: testDir,
      spaceId: "space",
    })
    const stable = catalog.entries.find(
      (entry) =>
        entry.kind === "document" && entry.descriptor.path === "folder/new"
    )
    expect(stable?.kind).toBe("document")
    if (stable?.kind === "document") {
      expect(stable.descriptor.documentId).toBe(documentId)
      expect(stable.handle).toMatchObject({
        identity: "durable",
        source: {
          kind: "file",
          relativePath: "docs/folder/new.md",
        },
      })
    }
  })

  it("surfaces missing, ambiguous, and colliding MCP renames instead of reporting success", async () => {
    await writeDoc("space", "occupied", "# Occupied")
    await writeDoc("space", "source", "# Source")
    await claimMarkdown("source")
    await writeDoc("space", "ambiguous", "# Markdown source")
    const ambiguousJson = join(
      testDir,
      "spaces",
      "space",
      "docs",
      "ambiguous.json"
    )
    writeFileSync(ambiguousJson, "[]\n")

    await expect(
      dispatchOperation("docs.rename", {
        spaceId: "space",
        oldPath: "missing",
        newPath: "somewhere",
      })
    ).rejects.toThrow("Doc not found")
    await expect(
      dispatchOperation("docs.rename", {
        spaceId: "space",
        oldPath: "ambiguous",
        newPath: "ambiguous-target",
      })
    ).rejects.toThrow("Document sources are ambiguous at their source path")
    await expect(
      dispatchOperation("docs.rename", {
        spaceId: "space",
        oldPath: "source",
        newPath: "occupied",
      })
    ).rejects.toThrow("Target path already exists")
    expect((await readDoc("space", "source")).data).toBe("# Source")
    expect((await readDoc("space", "occupied")).data).toBe("# Occupied")
    expect(existsSync(ambiguousJson)).toBe(true)
    expect(await docExists("space", "ambiguous-target")).toBe(false)
  })

  it("rejects a noncanonical spelling of a durable or provisional source path", async () => {
    await writeDoc("space", "folder/Source", "# Source")
    await claimMarkdown("folder/Source")
    await writeDoc("space", "folder/Legacy", "# Legacy")

    const outcome = await renameDocAndSync("space", "folder//Source", "target")

    expect(outcome.renamed).toEqual([])
    expect(outcome.error).toContain("exact current path")
    expect(outcome.error).toContain("folder/Source")
    expect(await docExists("space", "folder/Source")).toBe(true)
    expect(await docExists("space", "target")).toBe(false)

    const provisional = await renameDocAndSync(
      "space",
      "folder//Legacy",
      "legacy-target"
    )
    expect(provisional.renamed).toEqual([])
    expect(provisional.error).toContain("exact current path")
    expect(provisional.error).toContain("folder/Legacy")
    expect(await docExists("space", "folder/Legacy")).toBe(true)
    expect(await docExists("space", "legacy-target")).toBe(false)
  })

  it("keeps an idempotent same-path MCP retry honest and canonical", async () => {
    await writeDoc("space", "notes", "# Notes")
    const result = await dispatchOperation("docs.rename", {
      spaceId: "space",
      oldPath: "/notes",
      newPath: "notes",
    })
    expect(result).toEqual({ ok: true, oldPath: "notes", newPath: "notes" })

    await expect(
      dispatchOperation("docs.rename", {
        spaceId: "space",
        oldPath: "/absent",
        newPath: "absent",
      })
    ).rejects.toThrow("Doc not found")
  })

  it("rejects a queued stale descendant write after a folder move", async () => {
    await writeDoc("space", "folder/doc", "# Original")
    await claimMarkdown("folder/doc")
    let enterMove = () => {}
    let releaseMove = () => {}
    const entered = new Promise<void>((resolve) => {
      enterMove = resolve
    })
    const held = new Promise<void>((resolve) => {
      releaseMove = resolve
    })
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "share-revoked") return
      enterMove()
      return held
    })

    const moving = renameDocsByPrefixAndSync("space", "folder", "archive")
    await entered
    const writing = writeDoc("space", "folder/doc", "# Stale")

    releaseMove()
    const [move, write] = await Promise.all([moving, writing])
    expect(move.error).toBeNull()
    expect(write.error).toContain("reserved")
    expect(await docExists("space", "folder/doc")).toBe(false)
    expect((await readDoc("space", "archive/doc")).data).toBe("# Original")
  })

  it("rejects a legacy annotation collision before moving any state", async () => {
    await writeDoc("space", "source", "# Source")
    const sourceAnnotation = await createAnnotation("space", {
      target: { type: "doc", docPath: "source" },
      category: "comment",
      body: "Source identity",
    })
    const targetAnnotation = await createAnnotation("space", {
      target: { type: "doc", docPath: "target" },
      category: "comment",
      body: "Target identity",
    })

    const outcome = await renameDocAndSync("space", "source", "target")

    expect(outcome.renamed).toEqual([])
    expect(outcome.error).toContain("Target annotation state already exists")
    expect(await docExists("space", "source")).toBe(true)
    expect(await docExists("space", "target")).toBe(false)
    expect(
      (await readAnnotation("space", sourceAnnotation.annotation.id)).target
    ).toMatchObject({ type: "doc", docPath: "source" })
    expect(
      (await readAnnotation("space", targetAnnotation.annotation.id)).target
    ).toMatchObject({ type: "doc", docPath: "target" })
  })

  it("rejects malformed source annotations before moving any state", async () => {
    await writeDoc("space", "source", "# Source")

    const annotationsDir = join(
      testDir,
      "spaces",
      "space",
      "annotations",
      "docs"
    )
    mkdirSync(annotationsDir, { recursive: true })
    writeFileSync(join(annotationsDir, "source.annotations.json"), "{}\n")
    await expect(renameDocAndSync("space", "source", "target")).rejects.toThrow(
      "Invalid annotation file"
    )
    expect(await docExists("space", "source")).toBe(true)
    expect(await docExists("space", "target")).toBe(false)
  })

  it("rejects cyclic synced alias state before moving a document", async () => {
    await writeDoc("space", "source", "# Source")
    await claimMarkdown("source")
    writeFileSync(
      getDocAliasesPath("space"),
      JSON.stringify({
        type: "worktable.doc-aliases",
        version: 1,
        exact: { a: "b", b: "a" },
        prefixes: {},
      }),
      "utf8"
    )

    const outcome = await renameDocAndSync("space", "source", "target")

    expect(outcome.error).toContain("cycle or hop limit")
    expect(await docExists("space", "source")).toBe(true)
    expect(await docExists("space", "target")).toBe(false)
  })

  it("rejects an unsafe folder plan before moving any document", async () => {
    await writeDoc("space", "folder/one", "# One")
    await writeDoc("space", "folder/two", "# Two")
    const occupied = await writeWidget(
      "space",
      buildWidgetFile({
        id: "relocated/two",
        name: "Occupied",
        createdBy: "test",
        updatedBy: "test",
      }),
      "<h1>Occupied</h1>"
    )
    occupied.release?.()
    await claimMarkdown("folder/one")

    const outcome = await moveDocumentFolder("space", "folder", "relocated")

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("Target path already exists"),
    })
    expect(await docExists("space", "folder/one")).toBe(true)
    expect(await docExists("space", "folder/two")).toBe(true)
    expect(await docExists("space", "relocated/one")).toBe(false)
    expect(await readWidgetHtml("space", "relocated/two")).toMatchObject({
      data: "<h1>Occupied</h1>",
    })
    expect((await resolveDocAlias("space", "folder/one")).path).toBe(
      "folder/one"
    )

    const descendant = await renameDocsByPrefixAndSync(
      "space",
      "folder",
      "FOLDER/nested"
    )
    expect(descendant.error).toContain("into itself")
    expect(await docExists("space", "folder/one")).toBe(true)

    const htmlAncestor = await writeWidget(
      "space",
      buildWidgetFile({
        id: "occupied",
        name: "Occupied ancestor",
        createdBy: "test",
        updatedBy: "test",
      }),
      "<h1>Ancestor</h1>"
    )
    htmlAncestor.release?.()
    const htmlChild = await writeWidget(
      "space",
      buildWidgetFile({
        id: "source/child",
        name: "Source child",
        createdBy: "test",
        updatedBy: "test",
      }),
      "<h1>Child</h1>"
    )
    htmlChild.release?.()
    const nestedHtml = await moveDocumentFolder(
      "space",
      "source",
      "occupied/sub"
    )
    expect(nestedHtml).toMatchObject({
      ok: false,
      error: expect.stringContaining("inside an existing HTML document"),
    })
    expect(await readWidgetHtml("space", "source/child")).toMatchObject({
      data: "<h1>Child</h1>",
    })
    expect(await readWidgetHtml("space", "occupied")).toMatchObject({
      data: "<h1>Ancestor</h1>",
    })

    await writeDoc("space", "A/B", "# Parent")
    await writeDoc("space", "A/B/B", "# Child")
    const overlapping = await moveDocumentFolder("space", "A/B", "a")
    expect(overlapping).toMatchObject({
      ok: false,
      error: expect.stringContaining("would overlap"),
    })
    expect(await docExists("space", "A/B")).toBe(true)
    expect(await docExists("space", "A/B/B")).toBe(true)
    expect(await docExists("space", "a")).toBe(false)

    writeFileSync(join(testDir, "spaces", "space", "docs", "future.bin"), "x")
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "folder/future",
          format: { id: "future.diagram", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/future.bin" },
        },
      ],
    })
    const unsupported = await moveDocumentFolder("space", "folder", "another")
    expect(unsupported).toMatchObject({
      ok: false,
      error: expect.stringContaining("can't be moved yet"),
    })
    expect(await docExists("space", "folder/one")).toBe(true)
    expect(await docExists("space", "another/one")).toBe(false)
  })

  it("uses exact aliases when an ancestor move would overlap canonical targets", async () => {
    await writeDoc("space", "a/b/b/c", "# Nested")
    const written = await writeWidget(
      "space",
      buildWidgetFile({
        id: "a/b/dashboard",
        name: "Dashboard",
        createdBy: "test",
        updatedBy: "test",
      }),
      "<h1>Dashboard</h1>"
    )
    written.release?.()

    const outcome = await moveDocumentFolder("space", "a/b", "a")

    expect(outcome.ok).toBe(true)
    expect(await docExists("space", "a/b/c")).toBe(true)
    expect((await readWidget("space", "a/dashboard")).data?.id).toBe(
      "a/dashboard"
    )
    expect((await resolveDocAlias("space", "a/b/b/c")).path).toBe("a/b/c")
    expect((await resolveDocAlias("space", "a/b/dashboard")).path).toBe(
      "a/dashboard"
    )
    expect((await resolveDocAlias("space", "a/b/c")).path).toBe("a/b/c")
  })

  it("moves folder annotations without rewriting referring document content", async () => {
    await writeDoc("space", "folder/target", "# Target")
    await writeDoc("space", "linker", "See [target](/folder/target).\n")
    const created = await createAnnotation("space", {
      target: { type: "doc", docPath: "folder/target" },
      category: "comment",
      body: "Follow the folder move.",
    })

    const outcome = await renameDocsByPrefixAndSync(
      "space",
      "folder",
      "archive"
    )
    expect(outcome).toEqual({
      renamed: [{ from: "folder/target", to: "archive/target" }],
      error: null,
    })
    const movedAnnotation = await readAnnotation("space", created.annotation.id)
    expect(
      "docPath" in movedAnnotation.target && movedAnnotation.target.docPath
    ).toBe("archive/target")
    expect((await readDoc("space", "linker")).data).toBe(
      "See [target](/folder/target).\n"
    )
    expect((await resolveDocAlias("space", "folder/another")).path).toBe(
      "archive/another"
    )
  })
})
