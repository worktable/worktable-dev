import { createHash } from "node:crypto"
import {
  DrawingsReadRequestSchema,
  DrawingsWriteRequestSchema,
  emptyQuickdrawDocument,
  parseQuickdrawDocument,
  QUICKDRAW_FORMAT,
  createDrawingRecordComparator,
  type DrawingsReadRequest,
  type DrawingsWriteRequest,
  type QuickdrawDocument,
} from "@worktable/types"
import {
  createRegisteredDocument,
  readRegisteredDocumentSource,
  readRegisteredDocumentSourceLocked,
  replaceRegisteredDocument,
  replayRegisteredDocumentMutation,
  DocumentWriteError,
  type DocumentWriteResult,
} from "./document-write-service.ts"
import {
  listDocumentGenerationsV2,
  readDocumentGenerationV2,
} from "./document-version-store-v2.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import { getDocLifetimeView } from "./store.ts"
import {
  drawingCanonical as canonical,
  drawingDiff as diff,
} from "../../types/src/drawing-engine.ts"
import {
  prepareDrawingOperations,
  measureDrawing,
  reconcileDrawingBindings,
} from "./drawing-native.ts"
import type { DrawingBounds } from "./drawing-geometry.ts"

type RecordValue = QuickdrawDocument["snapshot"]["document"]["store"][string]
type Shape = Extract<RecordValue, { typeName: "shape" }>
const retention =
  "Request receipts and undo/redo are available while their document history generations are retained. Undo also needs the before generation; retention cleanup or document deletion can expire them. Reuse request IDs only to retry the same request."
const encode = (drawing: QuickdrawDocument) =>
  new TextEncoder().encode(`${JSON.stringify(drawing)}\n`)
function invalid(message: string): never {
  throw new DocumentWriteError("invalid", message)
}
function conflict(message: string): never {
  throw new DocumentWriteError("conflict", message)
}
function sourceDrawing(
  source: Awaited<ReturnType<typeof readRegisteredDocumentSource>>
) {
  if (source.format.id !== QUICKDRAW_FORMAT)
    invalid("This document is not a drawing")
  return parseQuickdrawDocument(source.bytes)
}
function objectType(shape: Shape) {
  return shape.type === "geo" ? shape.props.geo : shape.type
}
function textOf(shape: Shape) {
  return shape.type === "text" || shape.type === "note"
    ? shape.props.text
    : shape.type === "geo"
      ? (shape.props.label ?? "")
      : ""
}
function summary(record: RecordValue, bounds?: DrawingBounds) {
  if (record.typeName === "asset")
    return {
      id: record.id,
      type: "asset",
      width: record.w,
      height: record.h,
      mimeType: record.src.slice(5, record.src.indexOf(";")),
    }
  const props: Record<string, unknown> = { ...record.props }
  for (const [internal, exposed] of [
    ["label", "text"],
    ["w", "width"],
    ["h", "height"],
  ] as const) {
    if (internal in props) {
      props[exposed] = props[internal]
      delete props[internal]
    }
  }
  if (record.type === "note") props.width = 200 * (record.props.scale ?? 1)
  if (typeof props.text === "string" && props.text.length > 1000) {
    props.textLength = props.text.length
    props.text = props.text.slice(0, 1000)
    props.textTruncated = true
  }
  if ("pts" in props) {
    props.pointCount = (props.pts as number[]).length / 3
    delete props.pts
  }
  return {
    id: record.id,
    type: objectType(record),
    x: record.x,
    y: record.y,
    rotation: record.rot,
    z: record.z,
    bounds,
    ...props,
  }
}

export async function drawingRead(
  raw: DrawingsReadRequest,
  options: { signal?: AbortSignal } = {}
) {
  options.signal?.throwIfAborted()
  const request = DrawingsReadRequestSchema.parse(raw)
  // Inspect reports the lifetime from the same snapshot as the source.
  const { source, lifetime } = await withDocPathLock(
    request.spaceId,
    async () => {
      const source = await readRegisteredDocumentSourceLocked(request)
      return {
        source,
        lifetime:
          request.action === "inspect"
            ? await getDocLifetimeView(request.spaceId, source.path, {
                updatedAt: source.updatedAt,
              })
            : {},
      }
    }
  )
  if (
    "expectedRevision" in request &&
    request.expectedRevision &&
    request.expectedRevision !== source.sourceRevision
  )
    conflict(
      "Drawing changed since the requested revision. Read it again before rendering or editing."
    )
  let drawing = sourceDrawing(source)
  const address = {
    workspaceRoot: getWorkspaceRoot(),
    spaceId: request.spaceId,
    documentId: source.documentId,
  }
  if (request.action === "changes") {
    const generations = await listDocumentGenerationsV2(address)
    const retained = new Set(generations.map((g) => g.id))
    const all = generations
      .filter((g) => g.agentMutation)
      .map((g) => {
        const mutation = g.agentMutation!
        const changes = mutation.changes
        const verb = {
          create: "Created drawing",
          edit: "Edited drawing",
          undo: "Undid batch",
          redo: "Redid batch",
        }[mutation.operation]
        const details = changes
          ? [
              ...(["added", "changed", "removed"] as const).flatMap((kind) => {
                const count = changes[`${kind}Ids`].length
                return count
                  ? [`${kind} ${count} item${count === 1 ? "" : "s"}`]
                  : []
              }),
              ...(changes.titleChanged ? ["changed title"] : []),
            ]
          : null
        return {
          changeId: g.id,
          operation: mutation.operation,
          summary: `${verb}: ${changes?.description ?? (details ? details.join(", ") || "no content changes" : "item details unavailable")}.`,
          ...(changes
            ? {
                addedIds: changes.addedIds.slice(0, 100),
                changedIds: changes.changedIds.slice(0, 100),
                removedIds: changes.removedIds.slice(0, 100),
                addedCount: changes.addedIds.length,
                changedCount: changes.changedIds.length,
                removedCount: changes.removedIds.length,
                affectedIdsTruncated: [
                  changes.addedIds,
                  changes.changedIds,
                  changes.removedIds,
                ].some((ids) => ids.length > 100),
                titleChanged: changes.titleChanged,
              }
            : {}),
          createdAt: g.createdAt,
          createdBy: g.createdBy,
          state: mutation.state,
          reverses: mutation.reverses,
          undoAvailable:
            mutation.state === "committed" &&
            (!mutation.beforeGenerationId ||
              retained.has(mutation.beforeGenerationId)),
        }
      })
    const offset = request.offset ?? 0,
      limit = request.limit ?? 50
    return {
      documentId: source.documentId,
      path: source.path,
      sourceRevision: source.sourceRevision,
      changes: all.slice(offset, offset + limit),
      total: all.length,
      nextOffset: offset + limit < all.length ? offset + limit : null,
      retention,
    }
  }
  let sourceRevision = source.sourceRevision
  if (request.versionId) {
    const historical = await readDocumentGenerationV2({
      ...address,
      generationId: request.versionId,
    })
    const bytes = historical?.authoredSource.entries[0]?.bytes
    if (
      !historical ||
      !bytes ||
      historical.manifest.format.id !== QUICKDRAW_FORMAT
    )
      throw new DocumentWriteError(
        "not-found",
        "Drawing version is unavailable or has expired"
      )
    drawing = parseQuickdrawDocument(bytes)
    sourceRevision =
      historical.manifest.agentMutation?.sourceRevision ??
      `history:${request.versionId}`
  }
  const shapes = Object.values(drawing.snapshot.document.store)
    .filter((r): r is Shape => r.typeName === "shape")
    .sort((a, b) => a.z - b.z || a.id.localeCompare(b.id))
  const candidates = shapes.filter((shape) => {
    if (request.ids && !request.ids.includes(shape.id)) return false
    if (request.types && !request.types.includes(objectType(shape)))
      return false
    if (
      request.text &&
      !textOf(shape).toLowerCase().includes(request.text.toLowerCase())
    )
      return false
    return true
  })
  const offset = request.offset ?? 0,
    limit = request.limit ?? 100
  // Cheap filters and pagination precede text measurement. A render action
  // returns source for the adapter and does not manufacture discarded summaries.
  const measurable =
    request.action === "render"
      ? []
      : request.region
        ? candidates
        : candidates.slice(offset, offset + limit)
  const measurements = await measureDrawing(
    drawing,
    measurable.map((shape) => shape.id),
    options
  )
  const filtered =
    request.action === "render"
      ? candidates
      : candidates.filter((shape) => {
          if (request.region) {
            const b = measurements[shape.id]!.page,
              r = request.region
            if (
              b.x + b.w < r.x ||
              b.x > r.x + r.w ||
              b.y + b.h < r.y ||
              b.y > r.y + r.h
            )
              return false
          }
          return true
        })
  const objects = (request.action === "render" ? [] : filtered)
    .slice(offset, offset + limit)
    .map((shape) =>
      summary(
        measurements[shape.id]!.shape ?? shape,
        measurements[shape.id]!.page
      )
    )
  const assets = Object.values(drawing.snapshot.document.store).filter(
    (r) => r.typeName === "asset"
  )
  return {
    documentId: source.documentId,
    path: source.path,
    sourceRevision,
    title: drawing.title,
    drawing,
    objects,
    total: filtered.length,
    nextOffset: offset + limit < filtered.length ? offset + limit : null,
    assets: assets.slice(0, 100).map((asset) => summary(asset)),
    assetsTruncated: assets.length > 100,
    stats: {
      shapes: shapes.length,
      assets: Object.values(drawing.snapshot.document.store).filter(
        (r) => r.typeName === "asset"
      ).length,
    },
    ...(request.versionId
      ? { versionId: request.versionId, historical: true }
      : {}),
    ...lifetime,
    retention,
  }
}

function writeResult(result: DocumentWriteResult, before?: QuickdrawDocument) {
  if (!result.mutation)
    throw new Error("Drawing write did not return its mutation receipt")
  const drawing = parseQuickdrawDocument(result.mutation.bytes)
  const changes =
    result.mutation.receipt.changes ??
    (before
      ? diff(before, drawing)
      : {
          addedIds: [] as string[],
          changedIds: [] as string[],
          removedIds: [] as string[],
          titleChanged: false,
        })
  return {
    documentId: result.documentId,
    path: result.path,
    sourceRevision: result.sourceRevision,
    changeId: result.versionId,
    operation: result.mutation.receipt.operation,
    references: result.mutation.receipt.references,
    replayed: result.mutation.replayed,
    drawing,
    title: drawing.title,
    ...changes,
    stats: {
      shapes: Object.values(drawing.snapshot.document.store).filter(
        (r) => r.typeName === "shape"
      ).length,
      assets: Object.values(drawing.snapshot.document.store).filter(
        (r) => r.typeName === "asset"
      ).length,
    },
    retention,
  }
}
async function generationDrawing(
  address: { workspaceRoot: string; spaceId: string; documentId: string },
  generationId: string
) {
  const generation = await readDocumentGenerationV2({
    ...address,
    generationId,
  })
  if (
    !generation ||
    generation.manifest.format.id !== QUICKDRAW_FORMAT ||
    generation.authoredSource.entries.length !== 1
  )
    throw new DocumentWriteError(
      "not-found",
      "Drawing change history has expired or is unavailable"
    )
  return {
    generation,
    drawing: parseQuickdrawDocument(
      generation.authoredSource.entries[0]!.bytes
    ),
  }
}
async function resultWithDiff(result: DocumentWriteResult, spaceId: string) {
  const receipt = result.mutation!.receipt
  if (receipt.changes) return writeResult(result)
  let before: QuickdrawDocument | undefined
  if (receipt.beforeGenerationId) {
    before = await generationDrawing(
      {
        workspaceRoot: getWorkspaceRoot(),
        spaceId,
        documentId: result.documentId,
      },
      receipt.beforeGenerationId
    )
      .then((r) => r.drawing)
      .catch(() => undefined)
  } else
    before = emptyQuickdrawDocument(
      receipt.beforeTitle ??
        parseQuickdrawDocument(result.mutation!.bytes).title
    )
  return {
    ...writeResult(result, before),
    ...(before ? {} : { changeDetailsExpired: true }),
  }
}

export async function drawingWrite(
  raw: DrawingsWriteRequest,
  attribution: { actor: string; source: string; signal?: AbortSignal }
) {
  attribution.signal?.throwIfAborted()
  const request = DrawingsWriteRequestSchema.parse(raw)
  // Rendering choices do not alter the mutation: a lost-response retry may request a smaller preview.
  const { preview: _preview, ...mutationRequest } = request
  const requestHash = createHash("sha256")
    .update(canonical({ ...mutationRequest, previewOnly: undefined }))
    .digest("hex")
  if (!("previewOnly" in request && request.previewOnly)) {
    const replay = await replayRegisteredDocumentMutation({
      ...request,
      actor: attribution.actor,
      requestHash,
    })
    if (replay) return resultWithDiff(replay, request.spaceId)
  }
  const seed = `${attribution.actor}:${request.requestId}:${requestHash}`
  if (request.action === "create") {
    const before = emptyQuickdrawDocument(request.title)
    const applied = await prepareDrawingOperations(
      before,
      request.operations ?? [],
      seed,
      attribution
    )
    if (request.previewOnly)
      return {
        path: request.path,
        sourceRevision: null,
        previewOnly: true,
        ...applied,
        title: applied.drawing.title,
        retention,
      }
    attribution.signal?.throwIfAborted()
    const result = await createRegisteredDocument({
      ...request,
      format: { id: QUICKDRAW_FORMAT, sourceVersion: 1 },
      bytes: encode(applied.drawing),
      createdBy: attribution.actor,
      source: attribution.source,
      agentMutation: {
        actor: attribution.actor,
        requestId: request.requestId,
        requestHash,
        operation: "create",
        beforeTitle: before.title,
        references: applied.references,
        changes: diff(before, applied.drawing),
      },
    })
    return resultWithDiff(result, request.spaceId)
  }
  const source = await readRegisteredDocumentSource(request)
  const before = sourceDrawing(source)
  if (source.sourceRevision !== request.expectedRevision)
    conflict(
      "Drawing changed since it was inspected. Read it again and submit a new requestId with the current expectedRevision."
    )
  let drawing: QuickdrawDocument,
    references: Record<string, string> = {}
  if (request.action === "edit") {
    const applied = await prepareDrawingOperations(
      before,
      request.operations,
      seed,
      attribution
    )
    drawing = applied.drawing
    references = applied.references
    if (request.previewOnly)
      return {
        documentId: source.documentId,
        path: source.path,
        sourceRevision: source.sourceRevision,
        previewOnly: true,
        ...applied,
        title: drawing.title,
        retention,
      }
  } else {
    const address = {
      workspaceRoot: getWorkspaceRoot(),
      spaceId: request.spaceId,
      documentId: source.documentId,
    }
    const target = await generationDrawing(address, request.changeId)
    const receipt = target.generation.manifest.agentMutation
    if (!receipt || receipt.state !== "committed")
      conflict("This change is not a confirmed agent drawing change")
    if (receipt.actor !== attribution.actor)
      conflict("Only the original actor can undo or redo this drawing change")
    if (request.action === "redo" && receipt.operation !== "undo")
      invalid("Redo requires the changeId returned by undo")
    if (request.action === "undo" && receipt.operation === "undo")
      invalid("Use redo to reverse an undo change")
    if (
      !receipt.beforeGenerationId &&
      receipt.changes?.titleChanged &&
      receipt.beforeTitle === undefined
    )
      conflict(
        "This change's original title is unavailable. Inspect and make a targeted correction."
      )
    const old = receipt.beforeGenerationId
      ? (await generationDrawing(address, receipt.beforeGenerationId)).drawing
      : emptyQuickdrawDocument(receipt.beforeTitle ?? target.drawing.title)
    drawing = structuredClone(before)
    const a = old.snapshot.document.store,
      b = target.drawing.snapshot.document.store,
      current = drawing.snapshot.document.store
    const same = createDrawingRecordComparator()
    const conflicts: string[] = []
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (same(a[id], b[id])) continue
      if (!same(current[id], b[id])) {
        conflicts.push(id)
        continue
      }
      if (a[id]) current[id] = structuredClone(a[id])
      else delete current[id]
    }
    if (old.title !== target.drawing.title) {
      if (drawing.title !== target.drawing.title) conflicts.push("title")
      else drawing.title = old.title
    }
    if (conflicts.length)
      conflict(
        `Cannot ${request.action}: affected objects changed afterward: ${conflicts.join(", ")}. Inspect and make a targeted correction.`
      )
    try {
      // Validate references before reconciliation: undo must not silently detach
      // a later connector that depends on an object this change would remove.
      drawing = parseQuickdrawDocument(encode(drawing))
    } catch {
      conflict(
        `Cannot ${request.action}: later objects depend on content this change would remove. Inspect and make a targeted correction.`
      )
    }
  }
  if (request.action !== "edit")
    drawing = await reconcileDrawingBindings(drawing, attribution)

  attribution.signal?.throwIfAborted()
  const result = await replaceRegisteredDocument({
    ...request,
    path: source.path,
    bytes: encode(drawing),
    updatedBy: attribution.actor,
    source: attribution.source,
    agentMutation: {
      actor: attribution.actor,
      requestId: request.requestId,
      requestHash,
      operation: request.action,
      references,
      changes: diff(before, drawing),
      ...(request.action === "undo" || request.action === "redo"
        ? { reverses: request.changeId }
        : {}),
    },
  })
  return resultWithDiff(result, request.spaceId)
}
