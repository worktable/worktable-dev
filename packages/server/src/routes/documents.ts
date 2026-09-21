import { documentSourceDisposition } from "../content-disposition.ts"
import { Hono } from "hono"
import { z } from "zod"
import {
  DOCUMENT_ARCHIVE_REASON_MAX_LENGTH,
  DocumentAnnotationSelectorSchema,
  DocumentFormatClaimSchema,
} from "@worktable/types"
import {
  canManageUserSettings,
  isHostedBrowserOwner,
  requireScope,
} from "../auth.ts"
import { setDocumentFolderArchived } from "../document-folder-archive.ts"
import { deleteDocumentFolder } from "../document-folder-delete.ts"
import { moveDocumentFolder } from "../document-folder-move.ts"
import {
  DocumentSourceReadError,
  readDocumentAnnotations,
  readDocumentPage,
  readDocumentVersions,
  readRawDocumentSource,
} from "../document-page-service.ts"
import { analyzeDocumentPath } from "../document-path.ts"
import { listDocuments, resolveDocumentNavigation } from "../document-query.ts"
import { getHostedDocumentSharingConfig } from "../hosted.ts"
import { readSpace, slugifyDocPath } from "../store.ts"
import { hasScope } from "../token-store.ts"
import {
  checkpointRegisteredDocument,
  createRegisteredDocument,
  deleteRegisteredDocument,
  DocumentWriteError,
  moveRegisteredDocument,
  readRegisteredDocumentSource,
  replaceRegisteredDocument,
  restoreRegisteredDocumentVersion,
  setRegisteredDocumentArchived,
} from "../document-write-service.ts"
import {
  createDocumentAnnotationForPath,
  DocumentAnnotationError,
  replyDocumentAnnotation,
  resolveDocumentAnnotation,
  updateDocumentAnnotation,
} from "../document-annotation-service.ts"
import { wsManager } from "../ws.ts"

/** Format-neutral document collection for common browser surfaces. */
export const documentsRouter = new Hono()

const ResolveDocumentSchema = z.strictObject({
  path: z.string().min(1).max(4096),
})

const AnnotationPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})

const EncodedSourceSchema = z.object({
  source: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
})

const CreateDocumentSchema = EncodedSourceSchema.extend({
  path: z.string().min(1).max(4096),
  format: DocumentFormatClaimSchema,
  reason: z.string().max(2048).optional(),
})

const ReplaceDocumentSchema = EncodedSourceSchema.extend({
  path: z.string().min(1).max(4096),
  expectedRevision: z.string().min(1).max(256),
  reason: z.string().max(2048).optional(),
})

const CheckpointDocumentSchema = z.object({
  path: z.string().min(1).max(4096),
  expectedRevision: z.string().min(1).max(256),
  label: z.string().min(1).max(256).optional(),
  reason: z.string().max(2048).optional(),
})

const RestoreDocumentVersionSchema = z.object({
  path: z.string().min(1).max(4096),
  versionId: z.string().min(1).max(256),
  store: z.enum(["v2", "legacy-v1"]).optional(),
  expectedRevision: z.string().min(1).max(256),
  reason: z.string().max(2048).optional(),
})

const MoveDocumentSchema = z.object({
  path: z.string().min(1).max(4096),
  to: z.string().min(1).max(4096),
})

const ArchiveDocumentSchema = z.object({
  path: z.string().min(1).max(4096),
  reason: z.string().max(DOCUMENT_ARCHIVE_REASON_MAX_LENGTH).optional(),
})

const ExactDocumentSchema = z.object({
  path: z.string().min(1).max(4096),
})

const CreateDocumentAnnotationSchema = z.object({
  path: z.string().min(1).max(4096),
  selector: DocumentAnnotationSelectorSchema.optional(),
  category: z.enum(["comment", "instruction"]),
  body: z.string().min(1),
  title: z.string().optional(),
  labels: z.array(z.string()).optional(),
  idempotencyKey: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const UpdateDocumentAnnotationSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  status: z.enum(["open", "resolved"]).optional(),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const ReplyDocumentAnnotationSchema = z.object({
  body: z.string().min(1),
})

const ResolveDocumentAnnotationSchema = z.object({
  reason: z.string().optional(),
})

function decodeSource(source: string, encoding: "utf8" | "base64"): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(source)
  const normalized = source.replace(/=+$/u, "")
  const bytes = Buffer.from(source, "base64")
  if (bytes.toString("base64").replace(/=+$/u, "") !== normalized) {
    throw new DocumentWriteError(
      "invalid",
      "Document source is not valid base64"
    )
  }
  return bytes
}

function documentWriteAttribution(principal: {
  id: string
  type: "human" | "agent" | "system"
}): { actor: string; source: string } {
  if (principal.type === "human") {
    return { actor: "user", source: "rest-api" }
  }
  if (principal.type === "agent") {
    return { actor: `agent:${principal.id}`, source: "rest-api" }
  }
  return { actor: "system", source: "system" }
}

function documentWriteStatus(error: DocumentWriteError): 400 | 404 | 409 {
  if (error.reason === "not-found") return 404
  if (error.reason === "invalid") return 400
  return 409
}

function broadcastAnnotation(
  spaceId: string,
  annotationId: string,
  event: "created" | "updated" | "replied" | "resolved",
  annotation: unknown
): void {
  wsManager.broadcast(spaceId, {
    type: "annotation_update",
    spaceId,
    data: { annotationId, annotation, event },
  })
}

function documentAnnotationStatus(error: DocumentAnnotationError): 404 | 409 {
  return error.reason === "not-found" ? 404 : 409
}

function exactDocumentPath(value: unknown): string | null {
  const parsed = ResolveDocumentSchema.safeParse({ path: value })
  if (!parsed.success || !analyzeDocumentPath(parsed.data.path).safe) {
    return null
  }
  return parsed.data.path
}

documentsRouter.get("/resolve", requireScope("documents:read"), async (c) => {
  const parsed = ResolveDocumentSchema.safeParse(c.req.query())
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }
  if (!analyzeDocumentPath(parsed.data.path).safe) {
    return c.json(
      { error: "Enter a valid document path.", code: "VALIDATION_ERROR" },
      400
    )
  }
  const spaceId = c.req.param("spaceId") ?? ""
  const { data: space, error } = await readSpace(spaceId)
  if (error || !space) {
    return c.json({ error: error ?? "Not found", code: "NOT_FOUND" }, 404)
  }
  const result = await resolveDocumentNavigation({
    spaceId,
    path: parsed.data.path,
    includeArchived: true,
  })
  if (result.kind === "target") {
    return c.json({ target: result.target })
  }
  if (result.kind === "not-found") {
    return c.json({ error: "Document not found.", code: "NOT_FOUND" }, 404)
  }
  if (result.kind === "conflict") {
    return c.json(
      {
        error: "This document path has a conflict and cannot be opened.",
        code: "CONFLICT",
      },
      409
    )
  }
  return c.json(
    { error: "This document path cannot be resolved.", code: "CONFLICT" },
    409
  )
})

documentsRouter.get("/page", requireScope("documents:read"), async (c) => {
  const path = exactDocumentPath(c.req.query("path"))
  if (!path) {
    return c.json(
      { error: "Enter a valid document path.", code: "VALIDATION_ERROR" },
      400
    )
  }
  const page = await readDocumentPage({
    spaceId: c.req.param("spaceId") ?? "",
    path,
    includeArchived: true,
    rawSourceAuthorized: canManageUserSettings(c),
    annotationsAuthorized: hasScope(
      c.get("identity").scopes,
      "annotations:read"
    ),
    sharingAuthorized:
      isHostedBrowserOwner(c) && Boolean(getHostedDocumentSharingConfig()),
  })
  if (!page) {
    return c.json({ error: "Document not found.", code: "NOT_FOUND" }, 404)
  }
  if (page.kind === "alias-error") {
    return c.json(
      { error: "This document alias cannot be resolved.", code: "CONFLICT" },
      409
    )
  }
  return c.json({ page })
})

documentsRouter.get("/versions", requireScope("documents:read"), async (c) => {
  const path = exactDocumentPath(c.req.query("path"))
  if (!path) {
    return c.json(
      { error: "Enter a valid document path.", code: "VALIDATION_ERROR" },
      400
    )
  }
  const result = await readDocumentVersions({
    spaceId: c.req.param("spaceId") ?? "",
    path,
    includeArchived: true,
    checkpointsOnly: c.req.query("all") !== "true",
  })
  if (result.kind === "versions") {
    return c.json({ versions: result.versions })
  }
  if (result.kind === "not-found") {
    return c.json({ error: "Document not found.", code: "NOT_FOUND" }, 404)
  }
  if (result.kind === "unsupported") {
    return c.json(
      {
        error: "Version history is not available for this document.",
        code: "UNSUPPORTED",
      },
      409
    )
  }
  return c.json(
    { error: "This document path cannot be read.", code: "CONFLICT" },
    409
  )
})

documentsRouter.get(
  "/annotations",
  requireScope("documents:read"),
  requireScope("annotations:read"),
  async (c) => {
    const path = exactDocumentPath(c.req.query("path"))
    if (!path) {
      return c.json(
        { error: "Enter a valid document path.", code: "VALIDATION_ERROR" },
        400
      )
    }
    const page = AnnotationPageSchema.safeParse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    })
    if (!page.success) {
      return c.json(
        { error: page.error.message, code: "VALIDATION_ERROR" },
        400
      )
    }
    const result = await readDocumentAnnotations({
      spaceId: c.req.param("spaceId") ?? "",
      path,
      includeArchived: true,
      includeResolved: c.req.query("includeResolved") === "true",
      limit: page.data.limit,
      offset: page.data.offset,
    })
    if (result.kind === "annotations") {
      return c.json({
        annotations: result.annotations,
        total: result.total,
        ...(result.nextOffset !== undefined
          ? { nextOffset: result.nextOffset }
          : {}),
      })
    }
    if (result.kind === "not-found") {
      return c.json({ error: "Document not found.", code: "NOT_FOUND" }, 404)
    }
    if (result.kind === "unsupported") {
      return c.json(
        {
          error: "Annotations are not available for this document.",
          code: "UNSUPPORTED",
        },
        409
      )
    }
    return c.json(
      { error: "This document path cannot be read.", code: "CONFLICT" },
      409
    )
  }
)

documentsRouter.get("/source", requireScope("documents:read"), async (c) => {
  if (!canManageUserSettings(c)) {
    return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403)
  }
  const path = exactDocumentPath(c.req.query("path"))
  if (!path) {
    return c.json(
      { error: "Enter a valid document path.", code: "VALIDATION_ERROR" },
      400
    )
  }
  try {
    const result = await readRawDocumentSource({
      spaceId: c.req.param("spaceId") ?? "",
      path,
      includeArchived: true,
    })
    if (result.kind === "not-found") {
      return c.json({ error: "Document not found.", code: "NOT_FOUND" }, 404)
    }
    if (result.kind !== "source") {
      return c.json(
        { error: "This document path cannot be downloaded.", code: "CONFLICT" },
        409
      )
    }
    return new Response(new Uint8Array(result.source.bytes).buffer, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": documentSourceDisposition(result.source.fileName),
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    if (error instanceof DocumentSourceReadError) {
      return c.json(
        {
          error:
            error.reason === "too-large"
              ? "This source is too large to download here."
              : "This source could not be downloaded safely.",
          code:
            error.reason === "too-large"
              ? "PAYLOAD_TOO_LARGE"
              : "SOURCE_UNAVAILABLE",
        },
        error.reason === "too-large" ? 413 : 409
      )
    }
    throw error
  }
})

documentsRouter.get(
  "/editable-source",
  requireScope("documents:read"),
  async (c) => {
    const path = exactDocumentPath(c.req.query("path"))
    if (!path) {
      return c.json(
        { error: "Enter a valid document path.", code: "VALIDATION_ERROR" },
        400
      )
    }
    try {
      const result = await readRegisteredDocumentSource({
        spaceId: c.req.param("spaceId") ?? "",
        path,
      })
      return c.json({
        documentId: result.documentId,
        path: result.path,
        format: result.format,
        source: Buffer.from(result.bytes).toString("base64"),
        encoding: "base64" as const,
        byteLength: result.bytes.byteLength,
        sourceRevision: result.sourceRevision,
      })
    } catch (error) {
      if (error instanceof DocumentWriteError) {
        return c.json(
          { error: error.message, code: error.reason.toUpperCase() },
          documentWriteStatus(error)
        )
      }
      throw error
    }
  }
)

documentsRouter.post("/", requireScope("documents:write"), async (c) => {
  const parsed = CreateDocumentSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }
  try {
    const principal = c.get("identity").principal
    const attribution = documentWriteAttribution(principal)
    const result = await createRegisteredDocument({
      spaceId: c.req.param("spaceId") ?? "",
      path: parsed.data.path,
      format: parsed.data.format,
      bytes: decodeSource(parsed.data.source, parsed.data.encoding),
      createdBy: attribution.actor,
      source: attribution.source,
      reason: parsed.data.reason,
    })
    return c.json({ ok: true, ...result }, 201)
  } catch (error) {
    if (error instanceof DocumentWriteError) {
      return c.json(
        { error: error.message, code: error.reason.toUpperCase() },
        documentWriteStatus(error)
      )
    }
    throw error
  }
})

documentsRouter.put("/", requireScope("documents:write"), async (c) => {
  const parsed = ReplaceDocumentSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }
  try {
    const principal = c.get("identity").principal
    const attribution = documentWriteAttribution(principal)
    const result = await replaceRegisteredDocument({
      spaceId: c.req.param("spaceId") ?? "",
      path: parsed.data.path,
      bytes: decodeSource(parsed.data.source, parsed.data.encoding),
      expectedRevision: parsed.data.expectedRevision,
      updatedBy: attribution.actor,
      source: attribution.source,
      reason: parsed.data.reason,
    })
    return c.json({ ok: true, ...result })
  } catch (error) {
    if (error instanceof DocumentWriteError) {
      return c.json(
        { error: error.message, code: error.reason.toUpperCase() },
        documentWriteStatus(error)
      )
    }
    throw error
  }
})

documentsRouter.post(
  "/checkpoint",
  requireScope("documents:write"),
  async (c) => {
    const parsed = CheckpointDocumentSchema.safeParse(
      await c.req.json().catch(() => null)
    )
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.message, code: "VALIDATION_ERROR" },
        400
      )
    }
    try {
      const principal = c.get("identity").principal
      const attribution = documentWriteAttribution(principal)
      const result = await checkpointRegisteredDocument({
        spaceId: c.req.param("spaceId") ?? "",
        path: parsed.data.path,
        expectedRevision: parsed.data.expectedRevision,
        createdBy: attribution.actor,
        source: attribution.source,
        label: parsed.data.label,
        reason: parsed.data.reason,
      })
      return c.json({ ok: true, ...result })
    } catch (error) {
      if (error instanceof DocumentWriteError) {
        return c.json(
          { error: error.message, code: error.reason.toUpperCase() },
          documentWriteStatus(error)
        )
      }
      throw error
    }
  }
)

documentsRouter.post(
  "/restore-version",
  requireScope("documents:write"),
  async (c) => {
    const parsed = RestoreDocumentVersionSchema.safeParse(
      await c.req.json().catch(() => null)
    )
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.message, code: "VALIDATION_ERROR" },
        400
      )
    }
    try {
      const principal = c.get("identity").principal
      const attribution = documentWriteAttribution(principal)
      const result = await restoreRegisteredDocumentVersion({
        spaceId: c.req.param("spaceId") ?? "",
        path: parsed.data.path,
        versionId: parsed.data.versionId,
        store: parsed.data.store,
        expectedRevision: parsed.data.expectedRevision,
        restoredBy: attribution.actor,
        source: attribution.source,
        reason: parsed.data.reason,
      })
      return c.json({ ok: true, ...result })
    } catch (error) {
      if (error instanceof DocumentWriteError) {
        return c.json(
          { error: error.message, code: error.reason.toUpperCase() },
          documentWriteStatus(error)
        )
      }
      throw error
    }
  }
)

documentsRouter.post("/move", requireScope("documents:write"), async (c) => {
  const parsed = MoveDocumentSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }
  try {
    return c.json({
      ok: true,
      ...(await moveRegisteredDocument({
        spaceId: c.req.param("spaceId") ?? "",
        path: parsed.data.path,
        to: parsed.data.to,
      })),
    })
  } catch (error) {
    if (error instanceof DocumentWriteError) {
      return c.json(
        { error: error.message, code: error.reason.toUpperCase() },
        documentWriteStatus(error)
      )
    }
    throw error
  }
})

documentsRouter.post("/archive", requireScope("documents:write"), async (c) => {
  const parsed = ArchiveDocumentSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }
  try {
    return c.json({
      ok: true,
      ...(await setRegisteredDocumentArchived({
        spaceId: c.req.param("spaceId") ?? "",
        path: parsed.data.path,
        archived: true,
        archivedBy: c.get("identity").principal.id,
        reason: parsed.data.reason,
      })),
    })
  } catch (error) {
    if (error instanceof DocumentWriteError) {
      return c.json(
        { error: error.message, code: error.reason.toUpperCase() },
        documentWriteStatus(error)
      )
    }
    throw error
  }
})

documentsRouter.post("/restore", requireScope("documents:write"), async (c) => {
  const parsed = ExactDocumentSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }
  try {
    return c.json({
      ok: true,
      ...(await setRegisteredDocumentArchived({
        spaceId: c.req.param("spaceId") ?? "",
        path: parsed.data.path,
        archived: false,
        archivedBy: c.get("identity").principal.id,
      })),
    })
  } catch (error) {
    if (error instanceof DocumentWriteError) {
      return c.json(
        { error: error.message, code: error.reason.toUpperCase() },
        documentWriteStatus(error)
      )
    }
    throw error
  }
})

documentsRouter.post("/delete", requireScope("documents:write"), async (c) => {
  const parsed = ExactDocumentSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }
  try {
    return c.json({
      ok: true,
      ...(await deleteRegisteredDocument({
        spaceId: c.req.param("spaceId") ?? "",
        path: parsed.data.path,
      })),
    })
  } catch (error) {
    if (error instanceof DocumentWriteError) {
      return c.json(
        { error: error.message, code: error.reason.toUpperCase() },
        documentWriteStatus(error)
      )
    }
    throw error
  }
})

documentsRouter.post(
  "/annotations",
  requireScope("annotations:write"),
  async (c) => {
    const parsed = CreateDocumentAnnotationSchema.safeParse(
      await c.req.json().catch(() => null)
    )
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.message, code: "VALIDATION_ERROR" },
        400
      )
    }
    const principal = c.get("identity").principal
    const spaceId = c.req.param("spaceId") ?? ""
    const { path, ...input } = parsed.data
    try {
      const result = await createDocumentAnnotationForPath({
        spaceId,
        path,
        input: {
          ...input,
          author: {
            type: principal.type === "human" ? "user" : principal.type,
            id: principal.id,
            ...(principal.displayName ? { name: principal.displayName } : {}),
          },
        },
      })
      if (result.created) {
        broadcastAnnotation(
          spaceId,
          result.annotation.id,
          "created",
          result.annotation
        )
      }
      return c.json({
        ok: true,
        created: result.created,
        annotation: result.annotation,
      })
    } catch (error) {
      if (error instanceof DocumentAnnotationError) {
        return c.json(
          { error: error.message, code: error.reason.toUpperCase() },
          documentAnnotationStatus(error)
        )
      }
      throw error
    }
  }
)

documentsRouter.patch(
  "/annotations/:annotationId",
  requireScope("annotations:write"),
  async (c) => {
    const parsed = UpdateDocumentAnnotationSchema.safeParse(
      await c.req.json().catch(() => null)
    )
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.message, code: "VALIDATION_ERROR" },
        400
      )
    }
    const spaceId = c.req.param("spaceId") ?? ""
    try {
      const annotation = await updateDocumentAnnotation({
        spaceId,
        annotationId: c.req.param("annotationId") ?? "",
        patch: parsed.data,
        updatedBy: c.get("identity").principal.id,
      })
      broadcastAnnotation(spaceId, annotation.id, "updated", annotation)
      return c.json({ ok: true, annotation })
    } catch (error) {
      if (error instanceof DocumentAnnotationError) {
        return c.json(
          { error: error.message, code: error.reason.toUpperCase() },
          documentAnnotationStatus(error)
        )
      }
      throw error
    }
  }
)

documentsRouter.post(
  "/annotations/:annotationId/replies",
  requireScope("annotations:write"),
  async (c) => {
    const parsed = ReplyDocumentAnnotationSchema.safeParse(
      await c.req.json().catch(() => null)
    )
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.message, code: "VALIDATION_ERROR" },
        400
      )
    }
    const principal = c.get("identity").principal
    const spaceId = c.req.param("spaceId") ?? ""
    try {
      const result = await replyDocumentAnnotation({
        spaceId,
        annotationId: c.req.param("annotationId") ?? "",
        body: parsed.data.body,
        author: {
          type: principal.type === "human" ? "user" : "agent",
          id: principal.id,
          ...(principal.displayName ? { name: principal.displayName } : {}),
        },
      })
      broadcastAnnotation(
        spaceId,
        result.annotation.id,
        "replied",
        result.annotation
      )
      return c.json({ ok: true, ...result })
    } catch (error) {
      if (error instanceof DocumentAnnotationError) {
        return c.json(
          { error: error.message, code: error.reason.toUpperCase() },
          documentAnnotationStatus(error)
        )
      }
      throw error
    }
  }
)

documentsRouter.post(
  "/annotations/:annotationId/resolve",
  requireScope("annotations:write"),
  async (c) => {
    const parsed = ResolveDocumentAnnotationSchema.safeParse(
      await c.req.json().catch(() => ({}))
    )
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.message, code: "VALIDATION_ERROR" },
        400
      )
    }
    const spaceId = c.req.param("spaceId") ?? ""
    try {
      const annotation = await resolveDocumentAnnotation({
        spaceId,
        annotationId: c.req.param("annotationId") ?? "",
        reason: parsed.data.reason,
        resolvedBy: c.get("identity").principal.id,
      })
      broadcastAnnotation(spaceId, annotation.id, "resolved", annotation)
      return c.json({ ok: true, annotation })
    } catch (error) {
      if (error instanceof DocumentAnnotationError) {
        return c.json(
          { error: error.message, code: error.reason.toUpperCase() },
          documentAnnotationStatus(error)
        )
      }
      throw error
    }
  }
)

documentsRouter.get("/", requireScope("documents:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? ""
  const { data: space, error } = await readSpace(spaceId)
  if (error || !space) {
    return c.json({ error: error ?? "Not found", code: "NOT_FOUND" }, 404)
  }
  const documents = await listDocuments({
    spaceId,
    includeArchived: c.req.query("includeArchived") === "true",
  })
  return c.json({ documents })
})

const MoveFolderSchema = z.strictObject({
  oldPath: z.string().min(1),
  newPath: z.string().min(1),
})

const ArchiveFolderSchema = z.strictObject({
  path: z.string().min(1),
  reason: z.string().max(DOCUMENT_ARCHIVE_REASON_MAX_LENGTH).optional(),
})

const RestoreFolderSchema = z.strictObject({
  path: z.string().min(1),
})

const DeleteFolderSchema = z.strictObject({
  path: z.string().min(1),
})

documentsRouter.post(
  "/delete-folder",
  requireScope("documents:write"),
  async (c) => {
    const parsed = DeleteFolderSchema.safeParse(
      await c.req.json().catch(() => null)
    )
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.message, code: "VALIDATION_ERROR" },
        400
      )
    }
    const result = await deleteDocumentFolder(
      c.req.param("spaceId") ?? "",
      parsed.data.path
    )
    if (!result.ok) {
      const status = result.kind === "not-found" ? 404 : 409
      return c.json(
        {
          error: result.error,
          code: result.kind === "not-found" ? "NOT_FOUND" : "CONFLICT",
        },
        status
      )
    }
    return c.json({
      ok: true,
      path: result.path,
      count: result.paths.length,
      paths: result.paths,
    })
  }
)

documentsRouter.post(
  "/move-folder",
  requireScope("documents:write"),
  async (c) => {
    const parsed = MoveFolderSchema.safeParse(
      await c.req.json().catch(() => null)
    )
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.message, code: "VALIDATION_ERROR" },
        400
      )
    }
    const newPath = slugifyDocPath(parsed.data.newPath)
    if (!newPath) {
      return c.json(
        {
          error: "New name is empty after normalization",
          code: "VALIDATION_ERROR",
        },
        400
      )
    }
    const spaceId = c.req.param("spaceId") ?? ""
    const result = await moveDocumentFolder(
      spaceId,
      parsed.data.oldPath,
      newPath
    )
    if (!result.ok) {
      const status = result.kind === "not-found" ? 404 : 409
      return c.json(
        {
          error: result.error,
          code: result.kind === "not-found" ? "NOT_FOUND" : "CONFLICT",
        },
        status
      )
    }
    return c.json({
      ok: true,
      oldPath: result.from,
      newPath: result.to,
      renamed: result.renamed,
      count: result.renamed.length,
    })
  }
)

documentsRouter.post(
  "/archive-folder",
  requireScope("documents:write"),
  async (c) => {
    const parsed = ArchiveFolderSchema.safeParse(
      await c.req.json().catch(() => null)
    )
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.message, code: "VALIDATION_ERROR" },
        400
      )
    }
    const result = await setDocumentFolderArchived({
      spaceId: c.req.param("spaceId") ?? "",
      path: parsed.data.path,
      archived: true,
      archivedBy: c.get("identity").principal.id,
      reason: parsed.data.reason,
    })
    if (!result.ok) {
      const status = result.kind === "not-found" ? 404 : 409
      return c.json(
        {
          error: result.error,
          code: result.kind === "not-found" ? "NOT_FOUND" : "CONFLICT",
        },
        status
      )
    }
    return c.json({
      ok: true,
      path: result.path,
      archived: true,
      count: result.paths.length,
      paths: result.paths,
    })
  }
)

documentsRouter.post(
  "/restore-folder",
  requireScope("documents:write"),
  async (c) => {
    const parsed = RestoreFolderSchema.safeParse(
      await c.req.json().catch(() => null)
    )
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.message, code: "VALIDATION_ERROR" },
        400
      )
    }
    const result = await setDocumentFolderArchived({
      spaceId: c.req.param("spaceId") ?? "",
      path: parsed.data.path,
      archived: false,
      archivedBy: c.get("identity").principal.id,
    })
    if (!result.ok) {
      const status = result.kind === "not-found" ? 404 : 409
      return c.json(
        {
          error: result.error,
          code: result.kind === "not-found" ? "NOT_FOUND" : "CONFLICT",
        },
        status
      )
    }
    return c.json({
      ok: true,
      path: result.path,
      archived: false,
      count: result.paths.length,
      paths: result.paths,
    })
  }
)
