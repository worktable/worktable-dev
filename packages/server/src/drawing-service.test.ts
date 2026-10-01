import { previewTest as it } from "./test-support/synthetic-preview.ts"
import {
  PreviewBrowserPool,
  PreviewBrowserError,
  runWithPreviewBrowserPool,
} from "./document-preview-browser.ts"
import { recordIndex } from "./record-index.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DrawingsWriteRequest, SpaceFile } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { drawingRead, drawingWrite } from "./drawing-service.ts"
import { measureDrawing } from "./drawing-native.ts"
import {
  readRegisteredDocumentSource,
  moveRegisteredDocument,
  replaceRegisteredDocument,
} from "./document-write-service.ts"
import { listDocumentGenerationsV2 } from "./document-version-store-v2.ts"
import { documentGenerationV2Directory } from "./workspace-storage-v2.ts"
import { writeSpace } from "./store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

let root = "",
  app = ""
const spaceId = "agent-drawings",
  path = "drawings/checkout"
const attribution = { actor: "diagram-agent", source: "mcp" }
const address = { spaceId, path }
const write = (request: DrawingsWriteRequest) =>
  drawingWrite(request, attribution)
async function create() {
  const result = await write({
    action: "create",
    ...address,
    requestId: "create",
    title: "Checkout",
    operations: [
      {
        op: "add",
        ref: "browser",
        object: {
          type: "rectangle",
          x: 0,
          y: 0,
          width: 180,
          height: 100,
          text: "Browser",
        },
      },
      {
        op: "add",
        ref: "api",
        object: { type: "rectangle", x: 300, y: 0, text: "API", color: "blue" },
      },
      {
        op: "add",
        ref: "request",
        object: { type: "arrow", x: 180, y: 50, dx: 120, dy: 0 },
      },
      {
        op: "add",
        ref: "retry",
        object: {
          type: "note",
          x: 300,
          y: 180,
          text: "Retry on timeout",
          width: 240,
        },
      },
    ],
  })
  if (!("changeId" in result) || !result.sourceRevision)
    throw new Error("Expected saved drawing")
  return result
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-drawing-service-"))
  app = await mkdtemp(join(tmpdir(), "worktable-drawing-app-"))
  setWorkspaceRootOverride(root)
  setAppDirOverride(app)
  await ensureWorkspaceManifest()
  const manifestPath = join(root, "worktable.workspace.json"),
    manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: 2 }))
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Drawing agents",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  } satisfies SpaceFile)
})
afterEach(async () => {
  recordIndex.stop()
  invalidateSearchIndex()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await Promise.all(
    [root, app].map((p) => rm(p, { recursive: true, force: true }))
  )
})

describe("drawing agent workflows", () => {
  it("creates a readable diagram, previews and edits a note, and reverses a batch while preserving unrelated human work", async () => {
    const initial = await create(),
      noteId = initial.references.retry!,
      apiId = initial.references.api!,
      arrowId = initial.references.request!
    const inspected = await drawingRead({
      action: "inspect",
      ...address,
      limit: 2,
    })
    if (!("objects" in inspected)) throw new Error("Expected objects")
    expect(inspected.objects[0]).toMatchObject({
      type: "rectangle",
      text: "Browser",
      width: 180,
      height: 100,
    })
    expect(inspected.objects[0]).not.toHaveProperty("label")
    expect(inspected.objects[0]).not.toHaveProperty("w")
    expect(inspected.total).toBe(4)
    expect(inspected.nextOffset).toBe(2)
    const query = await drawingRead({
      action: "query",
      ...address,
      text: "retry",
      region: { x: 250, y: 150, w: 250, h: 300 },
    })
    expect("objects" in query && query.objects.map((o) => o.id)).toEqual([
      noteId,
    ])
    expect("objects" in query && query.objects[0]).toMatchObject({ width: 240 })
    const edit = {
      action: "edit",
      ...address,
      requestId: "retry-label",
      expectedRevision: initial.sourceRevision,
      operations: [
        {
          op: "update",
          id: noteId,
          changes: { text: "Retry after 10 seconds", width: 300 },
        },
        {
          op: "update",
          id: arrowId,
          changes: { startBinding: { shapeId: noteId, anchor: "right" } },
        },
      ],
    } as const
    const candidate = await write({
      ...edit,
      operations: [...edit.operations],
      previewOnly: true,
    })
    expect("previewOnly" in candidate && candidate.previewOnly).toBe(true)
    const proposedNote = candidate.drawing.snapshot.document.store[noteId]!
    expect(
      proposedNote.typeName === "shape" &&
        proposedNote.type === "note" &&
        proposedNote.props.scale
    ).toBe(1.5)
    expect((await readRegisteredDocumentSource(address)).sourceRevision).toBe(
      initial.sourceRevision
    )
    const edited = await write({ ...edit, operations: [...edit.operations] })
    if (!("changeId" in edited)) throw new Error("Expected commit")
    await expect(
      write({ ...edit, operations: [...edit.operations], previewOnly: true })
    ).rejects.toThrow("Drawing changed")
    const human = await drawingWrite(
      {
        action: "edit",
        ...address,
        requestId: "human-note",
        expectedRevision: edited.sourceRevision,
        operations: [
          { op: "update", id: apiId, changes: { text: "Payments API" } },
        ],
      },
      { actor: "human", source: "test" }
    )
    if (!human.sourceRevision) throw new Error("Expected revision")
    // A browser may save an unrelated edit while its font metrics differ.
    // The attachment and free endpoint still express the same authored intent.
    const browserSource = structuredClone(human.drawing)
    const cachedArrow = browserSource.snapshot.document.store[arrowId]!
    if (cachedArrow.typeName !== "shape" || cachedArrow.type !== "arrow")
      throw new Error("Expected connector")
    cachedArrow.x += 12
    cachedArrow.props.dx -= 12
    const browserSave = await replaceRegisteredDocument({
      ...address,
      expectedRevision: human.sourceRevision,
      bytes: new TextEncoder().encode(JSON.stringify(browserSource)),
      updatedBy: "human",
      source: "test",
    })
    const undone = await write({
      action: "undo",
      ...address,
      requestId: "undo-label",
      expectedRevision: browserSave.sourceRevision,
      changeId: edited.changeId,
    })
    if (!("changeId" in undone)) throw new Error("Expected undo")
    expect(JSON.stringify(undone.drawing)).toContain("Payments API")
    expect(JSON.stringify(undone.drawing)).toContain("Retry on timeout")
    const redone = await write({
      action: "redo",
      ...address,
      requestId: "redo-label",
      expectedRevision: undone.sourceRevision,
      changeId: undone.changeId,
    })
    expect(JSON.stringify(redone.drawing)).toContain("Retry after 10 seconds")
    const retry = await write({
      ...edit,
      operations: [...edit.operations],
      preview: { mode: "none" },
    })
    expect("replayed" in retry && retry.replayed).toBe(true)
    expect(retry.sourceRevision).toBe(edited.sourceRevision)
    const live = await readRegisteredDocumentSource(address)
    expect(live.sourceRevision).toBe(redone.sourceRevision!)
    expect(new TextDecoder().decode(live.bytes)).toContain("Payments API")

    // Cached geometry is ignorable; actual endpoint, attachment or style edits
    // are conflicts, and rejecting them must not partially reverse the note.
    let expectedRevision = live.sourceRevision
    for (const conflict of ["free-end", "detach", "style"] as const) {
      const later = structuredClone(redone.drawing)
      const connector = later.snapshot.document.store[arrowId]!
      if (connector.typeName !== "shape" || connector.type !== "arrow")
        throw new Error("Expected connector")
      if (conflict === "free-end") connector.props.dx += 30
      if (conflict === "detach") delete connector.props.startBinding
      if (conflict === "style") connector.props.color = "red"
      const saved = await replaceRegisteredDocument({
        ...address,
        expectedRevision,
        bytes: new TextEncoder().encode(JSON.stringify(later)),
        updatedBy: "human",
        source: "test",
      })
      expectedRevision = saved.sourceRevision
      await expect(
        write({
          action: "undo",
          ...address,
          expectedRevision,
          requestId: `conflict-${conflict}`,
          changeId: edited.changeId,
        })
      ).rejects.toThrow("affected objects changed afterward")
      expect((await readRegisteredDocumentSource(address)).sourceRevision).toBe(
        expectedRevision
      )
    }
  })

  it("keeps attached connectors with their targets and reverses deletion without losing attachments", async () => {
    const initial = await create()
    const arrowId = initial.references.request!,
      apiId = initial.references.api!,
      browserId = initial.references.browser!
    const attached = await write({
      action: "edit",
      ...address,
      requestId: "attach",
      expectedRevision: initial.sourceRevision,
      operations: [
        {
          op: "update",
          id: arrowId,
          changes: {
            startBinding: { shapeId: browserId },
            endBinding: { shapeId: apiId },
          },
        },
      ],
    })
    const attachedArrow = attached.drawing.snapshot.document.store[arrowId]!
    expect(attachedArrow).toMatchObject({
      x: 180,
      y: 50,
      props: {
        dx: 120,
        dy: 0,
        startBinding: { shapeId: browserId, anchor: "right" },
        endBinding: { shapeId: apiId, anchor: "left" },
      },
    })
    const moved = await write({
      action: "edit",
      ...address,
      requestId: "move-bound",
      expectedRevision: attached.sourceRevision!,
      operations: [
        { op: "move", id: apiId, x: 500, y: 100 },
        { op: "resize", id: apiId, width: 240, height: 160 },
        { op: "rotate", id: apiId, rotation: Math.PI / 2 },
      ],
    })
    expect(moved.changedIds).toEqual(expect.arrayContaining([arrowId, apiId]))
    const arrow = moved.drawing.snapshot.document.store[arrowId]!
    expect(arrow).toMatchObject({ x: 180, y: 50, props: { dx: 440, dy: 10 } })
    const copies = await write({
      action: "edit",
      ...address,
      requestId: "copies",
      expectedRevision: moved.sourceRevision!,
      operations: [
        { op: "duplicate", id: arrowId, ref: "copy" },
        { op: "add", ref: "another", object: { type: "rectangle", x: 900 } },
        {
          op: "add",
          ref: "new-arrow",
          object: {
            type: "arrow",
            startBinding: { shapeId: apiId, anchor: "bottom" },
            endBinding: { shapeId: "another" },
          },
        },
      ],
    })
    const copy =
      copies.drawing.snapshot.document.store[copies.references.copy!]!
    expect(copy).toMatchObject({ x: 204, y: 74 })
    expect(copy.typeName === "shape" && copy.props).not.toHaveProperty(
      "startBinding"
    )
    expect(copy.typeName === "shape" && copy.props).not.toHaveProperty(
      "endBinding"
    )
    const deleted = await write({
      action: "edit",
      ...address,
      requestId: "delete-target",
      expectedRevision: copies.sourceRevision!,
      operations: [{ op: "remove", id: apiId }],
    })
    if (!("changeId" in deleted)) throw new Error("Expected saved deletion")
    const detached = deleted.drawing.snapshot.document.store[arrowId]!
    expect(detached).toMatchObject({
      x: 180,
      y: 50,
      props: { dx: 440, dy: 10, startBinding: { shapeId: browserId } },
    })
    expect(detached.typeName === "shape" && detached.props).not.toHaveProperty(
      "endBinding"
    )
    const restored = await write({
      action: "undo",
      ...address,
      requestId: "restore-target",
      expectedRevision: deleted.sourceRevision!,
      changeId: deleted.changeId,
    })
    expect(restored.drawing.snapshot.document.store[arrowId]).toEqual(arrow)
    if (!("changeId" in moved)) throw new Error("Expected saved movement")
    const revertedMove = await write({
      action: "undo",
      ...address,
      requestId: "reverse-move",
      expectedRevision: restored.sourceRevision!,
      changeId: moved.changeId,
    })
    const laterArrow =
      revertedMove.drawing.snapshot.document.store[
        copies.references["new-arrow"]!
      ]!
    expect(laterArrow).toMatchObject({ x: 390, y: 100 })
    expect(revertedMove.changedIds).toContain(laterArrow.id)
    if (!("changeId" in revertedMove)) throw new Error("Expected saved undo")
    const repeatedMove = await write({
      action: "redo",
      ...address,
      requestId: "repeat-move",
      expectedRevision: revertedMove.sourceRevision!,
      changeId: revertedMove.changeId,
    })
    expect(repeatedMove.drawing.snapshot.document.store[arrowId]).toEqual(arrow)
    const dependency = await write({
      action: "edit",
      ...address,
      requestId: "later-dependency",
      expectedRevision: repeatedMove.sourceRevision!,
      operations: [
        {
          op: "add",
          object: {
            type: "line",
            endBinding: { shapeId: copies.references.another! },
          },
        },
      ],
    })
    if (!("changeId" in copies)) throw new Error("Expected saved copies")
    await expect(
      write({
        action: "undo",
        ...address,
        requestId: "unsafe-remove-target",
        expectedRevision: dependency.sourceRevision!,
        changeId: copies.changeId,
      })
    ).rejects.toThrow("later objects depend")
    const dragged = await write({
      action: "edit",
      ...address,
      requestId: "drag-arrow",
      expectedRevision: dependency.sourceRevision!,
      operations: [{ op: "move", id: arrowId, x: 12, y: 24 }],
    })
    const draggedArrow = dragged.drawing.snapshot.document.store[arrowId]!
    expect(draggedArrow).toMatchObject({ x: 12, y: 24 })
    expect(
      draggedArrow.typeName === "shape" && draggedArrow.props
    ).not.toHaveProperty("startBinding")
    await expect(
      write({
        action: "edit",
        ...address,
        requestId: "invalid-binding",
        expectedRevision: dragged.sourceRevision!,
        operations: [
          {
            op: "update",
            id: arrowId,
            changes: { endBinding: { shapeId: "absent" } },
          },
        ],
      })
    ).rejects.toThrow("must identify an existing")
    expect((await readRegisteredDocumentSource(address)).sourceRevision).toBe(
      dragged.sourceRevision!
    )
    const textBound = await write({
      action: "edit",
      ...address,
      requestId: "attach-note",
      expectedRevision: dragged.sourceRevision!,
      operations: [
        // Text added later in a batch inherits the font of an empty original,
        // including through a duplicate ref. Its connector must use that font.
        {
          op: "add",
          ref: "empty",
          object: { type: "text", font: "mono", text: "" },
        },
        { op: "duplicate", id: "empty", ref: "caption" },
        { op: "update", id: "caption", changes: { text: "iii WWW" } },
        {
          op: "update",
          id: arrowId,
          changes: {
            startBinding: { shapeId: "caption" },
            endBinding: { shapeId: initial.references.retry! },
          },
        },
      ],
    })
    const boundArrow = textBound.drawing.snapshot.document.store[arrowId]
    if (boundArrow?.typeName !== "shape") throw new Error("Expected connector")
    // A human can save while fonts are pending. Reads resolve semantic
    // attachments with current metrics without rewriting that saved source.
    const staleGeometry = structuredClone(textBound.drawing)
    const staleArrow = staleGeometry.snapshot.document.store[arrowId]!
    if (staleArrow.typeName !== "shape") throw new Error("Expected connector")
    staleArrow.x = -900
    const measured = await measureDrawing(staleGeometry, [arrowId])
    expect(measured[arrowId]!.shape).toEqual(boundArrow)
    expect(
      staleGeometry.snapshot.document.store[arrowId]!.typeName === "shape" &&
        staleArrow.x
    ).toBe(-900)
    let launchAttempts = 0
    const unavailable = new PreviewBrowserPool({
      launch: async () => {
        launchAttempts++
        throw new PreviewBrowserError(
          "PREVIEW_UNAVAILABLE",
          "Synthetic renderer outage"
        )
      },
    })
    try {
      await runWithPreviewBrowserPool(unavailable, async () => {
        // Other text-bound connectors do not prevent a targeted read whose
        // selected connector and targets have fixed geometry.
        const fixedId = copies.references["new-arrow"]!
        const query = await drawingRead({
          action: "query",
          ...address,
          ids: [fixedId],
        })
        expect(
          "objects" in query && query.objects.map((object) => object.id)
        ).toEqual([fixedId])
        const titled = await write({
          action: "edit",
          ...address,
          requestId: "title-without-renderer",
          expectedRevision: textBound.sourceRevision!,
          operations: [{ op: "title", title: "Checkout · reviewed" }],
        })
        expect(titled.drawing.title).toBe("Checkout · reviewed")
        expect(titled.changedIds).toEqual([])
        const metadata = await write({
          action: "edit",
          ...address,
          requestId: "metadata-without-renderer",
          expectedRevision: titled.sourceRevision!,
          operations: [{ op: "reorder", id: apiId, position: "front" }],
        })
        expect(metadata.drawing.snapshot.document.store[arrowId]).toEqual(
          boundArrow
        )
        expect(launchAttempts).toBe(0)
      })
    } finally {
      await unavailable.close()
    }
  })

  it("rejects entire invalid batches, stale revisions, request-ID reuse, and undo conflicts without changing saved content", async () => {
    const initial = await create(),
      id = initial.references.api!
    await expect(
      write({
        action: "edit",
        ...address,
        requestId: "invalid",
        expectedRevision: initial.sourceRevision,
        operations: [
          { op: "move", id, x: 42, y: 42 },
          { op: "update", id: "missing", changes: { text: "lost" } },
        ],
      })
    ).rejects.toThrow("Operation 2")
    expect((await readRegisteredDocumentSource(address)).sourceRevision).toBe(
      initial.sourceRevision
    )
    await expect(
      write({
        action: "edit",
        ...address,
        requestId: "note-height",
        expectedRevision: initial.sourceRevision,
        operations: [
          {
            op: "update",
            id: initial.references.retry!,
            changes: { height: 300 },
          },
        ],
      })
    ).rejects.toThrow("set width only")
    const changed = await write({
      action: "edit",
      ...address,
      requestId: "rename",
      expectedRevision: initial.sourceRevision,
      operations: [
        {
          op: "update",
          id,
          changes: { text: "New API " + "details ".repeat(150) },
        },
      ],
    })
    if (!("changeId" in changed)) throw new Error("Expected commit")
    const reread = await drawingRead({ action: "query", ...address, ids: [id] })
    if (!("objects" in reread)) throw new Error("Expected objects")
    expect(reread.objects[0]).toMatchObject({
      textTruncated: true,
      textLength: 1208,
    })
    expect((reread.objects[0] as Record<string, unknown>).text).toHaveLength(
      1000
    )
    expect(reread.objects[0]).not.toHaveProperty("labelTruncated")
    await expect(
      write({
        action: "edit",
        ...address,
        requestId: "rename",
        expectedRevision: initial.sourceRevision,
        operations: [{ op: "remove", id }],
      })
    ).rejects.toThrow("different drawing operations")
    await expect(
      write({
        action: "edit",
        ...address,
        requestId: "stale",
        expectedRevision: initial.sourceRevision,
        operations: [{ op: "remove", id }],
      })
    ).rejects.toThrow("Drawing changed")
    await expect(
      write({
        action: "undo",
        ...address,
        requestId: "undo-create",
        expectedRevision: changed.sourceRevision,
        changeId: initial.changeId,
      })
    ).rejects.toThrow("affected objects changed afterward")
    expect((await readRegisteredDocumentSource(address)).sourceRevision).toBe(
      changed.sourceRevision
    )
  })

  it("replays concurrent creation and recovers a receipt after source publication across a document move", async () => {
    const request = {
      action: "create",
      ...address,
      requestId: "concurrent",
      title: "One board",
      operations: [
        { op: "title", title: "Renamed board" },
        {
          op: "add",
          ref: "title",
          object: { type: "text", text: "Only once" },
        },
      ],
    } satisfies DrawingsWriteRequest
    const results = await Promise.all([write(request), write(request)])
    expect(results[0].sourceRevision).toBe(results[1].sourceRevision)
    const saved = results[0]
    if (!("changeId" in saved)) throw new Error("Expected saved board")
    const location = {
      workspaceRoot: root,
      spaceId,
      documentId: saved.documentId,
    }
    expect((await listDocumentGenerationsV2(location)).length).toBe(1)
    expect(saved.drawing.title).toBe("Renamed board")
    const manifestPath = join(
      documentGenerationV2Directory(
        root,
        spaceId,
        saved.documentId,
        saved.changeId
      ),
      "manifest.json"
    )
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.agentMutation.state = "prepared"
    await writeFile(manifestPath, JSON.stringify(manifest))
    await moveRegisteredDocument({ ...address, to: "drawings/renamed" })
    const recovered = await write(request)
    expect("replayed" in recovered && recovered.replayed).toBe(true)
    expect(
      (await listDocumentGenerationsV2(location))[0]?.agentMutation?.state
    ).toBe("committed")
    expect((await listDocumentGenerationsV2(location)).length).toBe(1)
    const receipt = JSON.parse(await readFile(manifestPath, "utf8"))
    expect(receipt.agentMutation.beforeTitle).toBe("One board")
    const undo = {
      action: "undo",
      spaceId,
      path: "drawings/renamed",
      requestId: "undo-create",
      expectedRevision: (
        await readRegisteredDocumentSource({
          spaceId,
          path: "drawings/renamed",
        })
      ).sourceRevision,
      changeId: saved.changeId,
    } satisfies DrawingsWriteRequest
    // Old receipts can report a title change without retaining the original.
    // Refuse a partial reversal rather than silently leaving that title edit.
    const legacy = structuredClone(receipt)
    delete legacy.agentMutation.beforeTitle
    await writeFile(manifestPath, JSON.stringify(legacy))
    await expect(write(undo)).rejects.toThrow("original title is unavailable")
    expect((await readRegisteredDocumentSource(undo)).sourceRevision).toBe(
      undo.expectedRevision
    )
    await writeFile(manifestPath, JSON.stringify(receipt))
    const undone = await write(undo)
    if (!("changeId" in undone)) throw new Error("Expected saved undo")
    expect(undone.drawing.title).toBe("One board")
    expect(undone.drawing.snapshot.document.store).toEqual({})
    const redone = await write({
      action: "redo",
      spaceId,
      path: undo.path,
      requestId: "redo-create",
      expectedRevision: undone.sourceRevision,
      changeId: undone.changeId,
    })
    expect(redone.drawing).toEqual(saved.drawing)
  })

  it("imports assets once, uses temporary references, and protects later image dependencies on undo", async () => {
    const initial = await create()
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
      "base64"
    )
    const dataUrl = (bytes: Uint8Array) =>
      `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
    const header = (width: number, height: number) => {
      const bytes = Buffer.from(png.subarray(0, 33))
      bytes.writeUInt32BE(width, 16)
      bytes.writeUInt32BE(height, 20)
      return dataUrl(bytes)
    }
    const malformed = dataUrl(png.subarray(0, 33))
    const rejected = [
      { sources: [malformed], error: "Could not decode" },
      {
        sources: [dataUrl(png).replace("image/png", "image/jpeg")],
        error: "declared format",
      },
      { sources: [header(8193, 1)], error: "pixel budget" },
      {
        sources: [header(3000, 3000), header(3001, 3000)],
        error: "pixel budget",
      },
    ]
    const location = {
      workspaceRoot: root,
      spaceId,
      documentId: initial.documentId,
    }
    const original = await readRegisteredDocumentSource(address)
    const generations = await listDocumentGenerationsV2(location)
    for (const { sources, error } of rejected) {
      const operations = sources.map((src, index) => ({
        op: "import_image" as const,
        ref: `image-${index}`,
        width: 1,
        height: 1,
        dataUrl: src,
      }))
      // Even unplaced assets with previews disabled must decode before either
      // creation or replacement publishes source/history/a retry receipt.
      await expect(
        write({
          action: "create",
          spaceId,
          path: "drawings/invalid-image",
          title: "Invalid",
          requestId: "invalid-create",
          operations,
          preview: { mode: "none" },
        })
      ).rejects.toThrow(error)
      await expect(
        readRegisteredDocumentSource({
          spaceId,
          path: "drawings/invalid-image",
        })
      ).rejects.toThrow()
      await expect(
        write({
          action: "edit",
          ...address,
          expectedRevision: initial.sourceRevision,
          requestId: "image",
          operations,
          preview: { mode: "none" },
        })
      ).rejects.toThrow(error)
      const current = await readRegisteredDocumentSource(address)
      expect(current.sourceRevision).toBe(original.sourceRevision)
      expect(current.bytes).toEqual(original.bytes)
      expect(await listDocumentGenerationsV2(location)).toEqual(generations)
    }
    const imported = await write({
      action: "edit",
      ...address,
      requestId: "image",
      expectedRevision: initial.sourceRevision,
      operations: [
        {
          op: "import_image",
          ref: "logo",
          width: 1,
          height: 1,
          dataUrl: dataUrl(png),
        },
        {
          op: "add",
          ref: "placed",
          object: {
            type: "image",
            x: 20,
            y: 220,
            width: 40,
            height: 40,
            assetId: "logo",
          },
        },
      ],
    })
    if (!("changeId" in imported)) throw new Error("Expected saved import")
    const reused = await write({
      action: "edit",
      ...address,
      requestId: "reuse",
      expectedRevision: imported.sourceRevision,
      operations: [
        { op: "duplicate", id: imported.references.placed!, x: 100, y: 220 },
      ],
    })
    if (!reused.sourceRevision) throw new Error("Expected revision")
    await expect(
      write({
        action: "undo",
        ...address,
        requestId: "remove-asset",
        expectedRevision: reused.sourceRevision,
        changeId: imported.changeId,
      })
    ).rejects.toThrow("later objects depend")
    const read = await drawingRead({ action: "inspect", ...address })
    expect(JSON.stringify("assets" in read ? read.assets : [])).not.toContain(
      "base64"
    )
    expect((await readRegisteredDocumentSource(address)).sourceRevision).toBe(
      reused.sourceRevision
    )
    const saved = await readRegisteredDocumentSource(address)
    const history = await listDocumentGenerationsV2(location)
    const replacement = structuredClone(reused.drawing)
    const asset =
      replacement.snapshot.document.store[imported.references.logo!]!
    if (asset.typeName !== "asset") throw new Error("Expected image asset")
    asset.src = malformed
    await expect(
      replaceRegisteredDocument({
        ...address,
        expectedRevision: saved.sourceRevision,
        bytes: new TextEncoder().encode(JSON.stringify(replacement)),
        updatedBy: "human",
        source: "test",
      })
    ).rejects.toThrow("Could not decode")
    expect((await readRegisteredDocumentSource(address)).bytes).toEqual(
      saved.bytes
    )
    expect(await listDocumentGenerationsV2(location)).toEqual(history)

    let launchAttempts = 0
    const unavailable = new PreviewBrowserPool({
      launch: async () => {
        launchAttempts++
        throw new PreviewBrowserError(
          "PREVIEW_UNAVAILABLE",
          "Synthetic renderer outage"
        )
      },
    })
    try {
      await runWithPreviewBrowserPool(unavailable, async () => {
        const edited = await write({
          action: "edit",
          ...address,
          requestId: "image-metadata-outage",
          expectedRevision: saved.sourceRevision,
          operations: [
            { op: "title", title: "Images retained" },
            {
              op: "update",
              id: imported.references.placed!,
              changes: { x: 80 },
            },
          ],
        })
        expect(
          edited.drawing.snapshot.document.store[imported.references.logo!]
        ).toEqual(
          reused.drawing.snapshot.document.store[imported.references.logo!]
        )
        expect(launchAttempts).toBe(0)
        const beforeRejected = await readRegisteredDocumentSource(address)
        const beforeHistory = await listDocumentGenerationsV2(location)
        // An unused, otherwise valid import still requires the decoder.
        await expect(
          write({
            action: "edit",
            ...address,
            requestId: "unused-import-outage",
            expectedRevision: edited.sourceRevision!,
            preview: { mode: "none" },
            operations: [
              {
                op: "import_image",
                ref: "unused",
                width: 1,
                height: 1,
                dataUrl: dataUrl(png),
              },
            ],
          })
        ).rejects.toThrow("Synthetic renderer outage")
        const changed = structuredClone(edited.drawing)
        const changedAsset =
          changed.snapshot.document.store[imported.references.logo!]!
        if (changedAsset.typeName !== "asset")
          throw new Error("Expected image asset")
        changedAsset.src = dataUrl(Buffer.concat([png, Buffer.from([0])]))
        await expect(
          replaceRegisteredDocument({
            ...address,
            expectedRevision: edited.sourceRevision!,
            bytes: new TextEncoder().encode(JSON.stringify(changed)),
            updatedBy: "human",
            source: "test",
          })
        ).rejects.toThrow("Synthetic renderer outage")
        expect(launchAttempts).toBeGreaterThan(0)
        expect((await readRegisteredDocumentSource(address)).bytes).toEqual(
          beforeRejected.bytes
        )
        expect(
          (await readRegisteredDocumentSource(address)).sourceRevision
        ).toBe(beforeRejected.sourceRevision)
        expect(await listDocumentGenerationsV2(location)).toEqual(beforeHistory)
        const launchesBeforeRemoval = launchAttempts
        const removed = structuredClone(edited.drawing)
        for (const [id, record] of Object.entries(
          removed.snapshot.document.store
        ))
          if (
            record.typeName === "asset" ||
            (record.typeName === "shape" && record.type === "image")
          )
            delete removed.snapshot.document.store[id]
        await replaceRegisteredDocument({
          ...address,
          expectedRevision: edited.sourceRevision!,
          bytes: new TextEncoder().encode(JSON.stringify(removed)),
          updatedBy: "human",
          source: "test",
        })
        expect(launchAttempts).toBe(launchesBeforeRemoval)
      })
    } finally {
      await unavailable.close()
    }
  })
})
