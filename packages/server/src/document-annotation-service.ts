import { commentAccess } from "./team-policy.ts"
import { noteCommentActivity } from "./activity-log.ts"
import type { AnnotationWriteGuard } from "./annotation-origin.ts"
import { nanoid } from "nanoid"
import { NON_ENGAGING_ACTORS, noteDocumentActivity } from "./document-activity.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import { lstat, opendir } from "node:fs/promises"
import { join } from "node:path"
import { DocumentIdSchema } from "@worktable/types"
import type {
  Annotation,
  AnnotationAuthor,
  AnnotationRecipient,
  AnnotationCategory,
  AnnotationStatus,
  AnnotationTarget,
  DocumentAnnotationSelector,
  DocumentAnnotationV2,
  DocumentId,
} from "@worktable/types"
import { mapWithConcurrency } from "./bounded-concurrency.ts"
import { addRequests, requestsAfterReply, type CommentReplier } from "./annotation-requests.ts"
import { buildDocumentCatalog } from "./document-catalog.ts"
import {
  readDocumentAnnotationsV2,
  translateDocumentAnnotationTargetV2ToLegacy,
  translateLegacyDocumentAnnotationTarget,
  writeDocumentAnnotationsV2,
} from "./document-data-v2.ts"
import {
  readDocumentCatalogSnapshot,
  useResolvedDocumentHandle,
} from "./document-query.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import { FingerprintCache, fingerprintOf } from "./file-fingerprint.ts"
import { readModelEnabled } from "./workspace-read-model.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import {
  documentDataV2RootDirectory,
  readWorkspaceStorageLayoutAt,
} from "./workspace-storage-v2.ts"

const ANNOTATION_OWNER_READ_CONCURRENCY = 32

const DEFAULT_AUTHOR: AnnotationAuthor = {
  type: "agent",
  id: "worktable",
  name: "Worktable",
}

export class DocumentAnnotationError extends Error {
  readonly reason: "not-found" | "conflict"

  constructor(reason: "not-found" | "conflict", message: string) {
    super(message)
    this.name = "DocumentAnnotationError"
    this.reason = reason
  }
}

export interface DocumentAnnotationCreateInput {
  selector?: DocumentAnnotationSelector
  category: AnnotationCategory
  body: string
  title?: string
  author?: AnnotationAuthor
  labels?: string[]
  idempotencyKey?: string
  metadata?: Record<string, unknown>
  /** People and agents the comment is sent to, already checked. */
  to?: AnnotationRecipient[]
}

export interface DocumentAnnotationUpdatePatch {
  title?: string
  body?: string
  status?: AnnotationStatus
  labels?: string[]
  metadata?: Record<string, unknown>
}

interface AnnotationDocument {
  documentId: DocumentId
  path: string
  formatId: string
}

interface AnnotationOwner {
  document: AnnotationDocument
  annotations: DocumentAnnotationV2[]
  revision: string | null
}

async function requireV2AnnotationWrites(): Promise<void> {
  const layout = await readWorkspaceStorageLayoutAt(getWorkspaceRoot())
  if (layout.kind !== "v2") {
    throw new DocumentAnnotationError(
      "conflict",
      "Common document annotation writes require Storage V2"
    )
  }
}

function legacyKind(document: AnnotationDocument): "docs" | "widgets" {
  return document.formatId === "worktable.html" ? "widgets" : "docs"
}

async function useDurableDocument<T>(
  spaceId: string,
  path: string,
  use: (document: AnnotationDocument) => Promise<T>,
  options: {
    materializeIdentity?: boolean
    identityAccess?: "read" | "edit"
    snapshot?: boolean
  } = {}
): Promise<T> {
  const resolution = await useResolvedDocumentHandle(
    {
      spaceId,
      path,
      includeArchived: true,
      materializeIdentity: options.materializeIdentity,
      identityAccess: options.identityAccess,
      snapshot: options.snapshot,
    },
    (handle) => {
      if (handle.identity !== "durable") {
        throw new DocumentAnnotationError(
          "conflict",
          "Document needs a durable identity before annotations"
        )
      }
      return use({
        documentId: handle.documentId,
        path: handle.document.path,
        formatId: handle.document.format.id,
      })
    }
  )
  if (
    resolution !== null &&
    typeof resolution === "object" &&
    "kind" in resolution &&
    (resolution.kind === "not-found" ||
      resolution.kind === "alias-error" ||
      resolution.kind === "conflict")
  ) {
    throw new DocumentAnnotationError(
      resolution.kind === "not-found" ? "not-found" : "conflict",
      resolution.kind === "not-found"
        ? "Document not found"
        : "Document path cannot be resolved"
    )
  }
  return resolution
}

async function ownerForDocument(
  spaceId: string,
  document: AnnotationDocument
): Promise<AnnotationOwner> {
  const file = await readDocumentAnnotationsV2({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    documentId: document.documentId,
  })
  return {
    document,
    annotations: file?.annotations ?? [],
    revision: file?.revision ?? null,
  }
}

async function ownerForPath(
  spaceId: string,
  path: string
): Promise<AnnotationOwner> {
  return useDurableDocument(
    spaceId,
    path,
    (document) => ownerForDocument(spaceId, document),
    { snapshot: true }
  )
}

async function writeOwner(
  spaceId: string,
  owner: AnnotationOwner,
  beforeWrite?: AnnotationWriteGuard
): Promise<void> {
  try {
    if (beforeWrite) await beforeWrite(owner.document.documentId)
    const written = await writeDocumentAnnotationsV2({
      workspaceRoot: getWorkspaceRoot(),
      spaceId,
      documentId: owner.document.documentId,
      logicalPath: owner.document.path,
      annotations: owner.annotations,
      expectedRevision: owner.revision,
    })
    owner.revision = written.revision
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "document annotations changed before write"
    ) {
      throw new DocumentAnnotationError(
        "conflict",
        "Document annotations changed. Read them again before retrying."
      )
    }
    throw error
  }
}

function newAnnotation(
  spaceId: string,
  owner: AnnotationOwner,
  input: DocumentAnnotationCreateInput
): DocumentAnnotationV2 {
  const now = new Date().toISOString()
  return {
    id: `ann_${nanoid(12)}`,
    spaceId,
    target: {
      type: "document",
      documentId: owner.document.documentId,
      path: owner.document.path,
      ...(input.selector ? { selector: input.selector } : {}),
    },
    category: input.category,
    status: "open",
    ...(input.title ? { title: input.title } : {}),
    body: input.body,
    author: input.author ?? DEFAULT_AUTHOR,
    labels: input.labels ?? [],
    thread: [],
    createdAt: now,
    updatedAt: now,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: input.metadata ?? {},
    ...(input.to?.length ? { requests: addRequests([], input.to, now) } : {}),
  }
}

export async function listDocumentAnnotationsForPath(options: {
  spaceId: string
  path: string
  includeResolved?: boolean
  limit?: number
  offset?: number
}): Promise<{
  annotations: DocumentAnnotationV2[]
  total: number
  nextOffset?: number
}> {
  const owner = await ownerForPath(options.spaceId, options.path)
  const all = owner.annotations
    .filter(
      (annotation) =>
        options.includeResolved || annotation.status !== "resolved"
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const offset = options.offset ?? 0
  const limit = options.limit ?? 100
  return {
    annotations: all.slice(offset, offset + limit),
    total: all.length,
    ...(offset + limit < all.length ? { nextOffset: offset + limit } : {}),
  }
}

export async function listDocumentAnnotationsForHandle(options: {
  spaceId: string
  documentId: DocumentId
  path: string
  formatId: string
  includeResolved?: boolean
  limit?: number
  offset?: number
}): Promise<{
  annotations: DocumentAnnotationV2[]
  total: number
  nextOffset?: number
}> {
  const owner = await ownerForDocument(options.spaceId, {
    documentId: options.documentId,
    path: options.path,
    formatId: options.formatId,
  })
  const all = owner.annotations
    .filter(
      (annotation) =>
        options.includeResolved || annotation.status !== "resolved"
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const offset = options.offset ?? 0
  const limit = options.limit ?? 100
  return {
    annotations: all.slice(offset, offset + limit),
    total: all.length,
    ...(offset + limit < all.length ? { nextOffset: offset + limit } : {}),
  }
}

export async function createDocumentAnnotationForPath(options: {
  spaceId: string
  path: string
  input: DocumentAnnotationCreateInput
}): Promise<{ annotation: DocumentAnnotationV2; created: boolean }> {
  await requireV2AnnotationWrites()
  const result = await useDurableDocument(options.spaceId, options.path, async (document) => {
    const owner = await ownerForDocument(options.spaceId, document)
    if (options.input.idempotencyKey) {
      const existing = owner.annotations.find(
        (annotation) =>
          annotation.idempotencyKey === options.input.idempotencyKey
      )
      if (existing) {
        return { annotation: existing, created: false, path: owner.document.path }
      }
    }
    const annotation = newAnnotation(options.spaceId, owner, options.input)
    owner.annotations.push(annotation)
    await writeOwner(options.spaceId, owner)
    return { annotation, created: true, path: owner.document.path }
  }, { materializeIdentity: true })
  if (result.created && options.input.author?.type !== "system") {
    await noteDocumentActivity(options.spaceId, [result.path])
    noteCommentActivity({
      spaceId: options.spaceId,
      action: "comment.created",
      path: result.path,
      author: result.annotation.author,
      body: result.annotation.body,
      category: result.annotation.category,
    })
  }
  return { annotation: result.annotation, created: result.created }
}

/**
 * Annotation files parsed for read-only listings, by path, kept while their
 * fingerprints stay the same. Shared with every listing: callers must not
 * mutate what they receive.
 */
const parsedAnnotationFiles = new FingerprintCache<
  Awaited<ReturnType<typeof readDocumentAnnotationsV2>>
>(20_000)

/**
 * Every document in the Space that has annotations. Writers read every file
 * and the catalog fresh. A read-only listing takes the catalog from the
 * Space's read-model snapshot and re-reads only annotation files whose
 * fingerprint changed, so another process's edit is still seen at once.
 */
async function allAnnotationOwners(
  spaceId: string,
  options: { snapshot?: boolean; namespaceLockHeld?: boolean } = {}
): Promise<AnnotationOwner[]> {
  const workspaceRoot = getWorkspaceRoot()
  const root = documentDataV2RootDirectory(workspaceRoot, spaceId)
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return []
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("document annotation V2 root is not a real directory")
  }
  const candidateIds: DocumentId[] = []
  const directory = await opendir(root)
  for await (const entry of directory) {
    if (entry.isSymbolicLink()) {
      throw new Error("document annotation V2 owner is not a real directory")
    }
    if (!entry.isDirectory()) continue
    const parsed = DocumentIdSchema.safeParse(entry.name)
    if (parsed.success) candidateIds.push(parsed.data)
  }
  const observedAt = Date.now()
  const annotationFiles = new Map(
    (
      await mapWithConcurrency(
        candidateIds,
        ANNOTATION_OWNER_READ_CONCURRENCY,
        async (documentId) => {
          const path = join(root, documentId, "annotations.json")
          try {
            const annotationInfo = await lstat(path, { bigint: true })
            if (!annotationInfo.isFile() || annotationInfo.isSymbolicLink()) {
              throw new Error("document annotation V2 file is not a real file")
            }
            return [
              [
                documentId,
                { path, ...fingerprintOf(annotationInfo, observedAt) },
              ],
            ] as const
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === "ENOENT" || code === "ENOTDIR") return []
            throw error
          }
        }
      )
    ).flat()
  )
  if (annotationFiles.size === 0) return []
  const catalog = options.snapshot
    ? await readDocumentCatalogSnapshot(spaceId, {
        ...(options.namespaceLockHeld ? { lockHeld: true } : {}),
      })
    : await buildDocumentCatalog({ workspaceRoot, spaceId })
  const documents: AnnotationDocument[] = []
  for (const entry of catalog.entries) {
    if (
      entry.kind !== "document" ||
      entry.handle.identity !== "durable" ||
      !annotationFiles.has(entry.handle.documentId)
    ) {
      continue
    }
    documents.push({
      documentId: entry.handle.documentId,
      path: entry.descriptor.path,
      formatId: entry.descriptor.format.id,
    })
  }
  if (!options.snapshot || !readModelEnabled()) {
    return mapWithConcurrency(
      documents,
      ANNOTATION_OWNER_READ_CONCURRENCY,
      (document) => ownerForDocument(spaceId, document)
    )
  }
  return mapWithConcurrency(
    documents,
    ANNOTATION_OWNER_READ_CONCURRENCY,
    async (document): Promise<AnnotationOwner> => {
      const { path, key, racy } = annotationFiles.get(document.documentId)!
      // The fingerprint was taken before the read, so a file that changes
      // while it is read is read again next time.
      let file = parsedAnnotationFiles.get(path, key)
      if (file === undefined) {
        file = await readDocumentAnnotationsV2({
          workspaceRoot,
          spaceId,
          documentId: document.documentId,
        })
        if (racy) parsedAnnotationFiles.delete(path)
        else parsedAnnotationFiles.set(path, key, file)
      }
      return {
        document,
        annotations: file?.annotations ?? [],
        revision: file?.revision ?? null,
      }
    }
  )
}

async function findAnnotation(
  spaceId: string,
  annotationId: string
): Promise<{
  owner: AnnotationOwner
  index: number
  annotation: DocumentAnnotationV2
}> {
  let found:
    | {
        owner: AnnotationOwner
        index: number
        annotation: DocumentAnnotationV2
      }
    | undefined
  for (const owner of await allAnnotationOwners(spaceId)) {
    const index = owner.annotations.findIndex(
      (annotation) => annotation.id === annotationId
    )
    if (index < 0) continue
    if (found) {
      throw new DocumentAnnotationError(
        "conflict",
        `Annotation id is ambiguous: ${annotationId}`
      )
    }
    found = { owner, index, annotation: owner.annotations[index]! }
  }
  if (!found) {
    throw new DocumentAnnotationError(
      "not-found",
      `Annotation not found: ${annotationId}`
    )
  }
  return found
}

export async function updateDocumentAnnotation(options: {
  spaceId: string
  annotationId: string
  patch: DocumentAnnotationUpdatePatch
  updatedBy: string
}): Promise<DocumentAnnotationV2> {
  await requireV2AnnotationWrites()
  return withDocPathLock(options.spaceId, async () => {
    const found = await findAnnotation(options.spaceId, options.annotationId)
    const annotation: DocumentAnnotationV2 = {
      ...found.annotation,
      ...options.patch,
      metadata: options.patch.metadata
        ? { ...found.annotation.metadata, ...options.patch.metadata }
        : found.annotation.metadata,
      updatedAt: new Date().toISOString(),
      updatedBy: options.updatedBy,
    }
    found.owner.annotations[found.index] = annotation
    await writeOwner(options.spaceId, found.owner)
    return annotation
  })
}

export async function replyDocumentAnnotation(options: {
  spaceId: string
  annotationId: string
  body: string
  author?: AnnotationAuthor
  replier?: CommentReplier
  to?: AnnotationRecipient[]
}): Promise<{ annotation: DocumentAnnotationV2; replyId: string }> {
  await requireV2AnnotationWrites()
  const author = options.author ?? DEFAULT_AUTHOR
  const result = await withDocPathLock(options.spaceId, async () => {
    const found = await findAnnotation(options.spaceId, options.annotationId)
    const now = new Date().toISOString()
    const replyId = `msg_${nanoid(12)}`
    const requests = requestsAfterReply(
      found.annotation.requests ?? [],
      options.replier,
      replyId,
      now,
      options.to
    )
    const annotation: DocumentAnnotationV2 = {
      ...found.annotation,
      thread: [
        ...found.annotation.thread,
        { id: replyId, author, body: options.body, createdAt: now },
      ],
      updatedAt: now,
      updatedBy: author.id,
      ...(requests.length ? { requests } : {}),
    }
    found.owner.annotations[found.index] = annotation
    await writeOwner(options.spaceId, found.owner)
    return { annotation, replyId, path: found.owner.document.path }
  })
  if (author.type !== "system") {
    await noteDocumentActivity(options.spaceId, [result.path], { access: commentAccess() })
    noteCommentActivity({
      spaceId: options.spaceId,
      action: "comment.replied",
      path: result.path,
      author,
      body: options.body,
      category: result.annotation.category,
    })
  }
  return { annotation: result.annotation, replyId: result.replyId }
}

export async function resolveDocumentAnnotation(options: {
  spaceId: string
  annotationId: string
  reason?: string
  resolvedBy: string
}): Promise<DocumentAnnotationV2> {
  await requireV2AnnotationWrites()
  const result = await withDocPathLock(options.spaceId, async () => {
    const found = await findAnnotation(options.spaceId, options.annotationId)
    const now = new Date().toISOString()
    const annotation: DocumentAnnotationV2 = {
      ...found.annotation,
      status: "resolved",
      updatedAt: now,
      updatedBy: options.resolvedBy,
      resolution: {
        resolvedAt: now,
        resolvedBy: options.resolvedBy,
        ...(options.reason ? { reason: options.reason } : {}),
        status: "resolved",
      },
    }
    found.owner.annotations[found.index] = annotation
    await writeOwner(options.spaceId, found.owner)
    return { annotation, path: found.owner.document.path }
  })
  if (!NON_ENGAGING_ACTORS.has(options.resolvedBy)) {
    await noteDocumentActivity(options.spaceId, [result.path])
    noteCommentActivity({
      spaceId: options.spaceId,
      action: "comment.resolved",
      path: result.path,
      author: resolverAuthor(options.resolvedBy),
      body: result.annotation.body,
      category: result.annotation.category,
    })
  }
  return result.annotation
}

/** Resolutions record only an actor string; classify it like other writes. */
function resolverAuthor(resolvedBy: string): AnnotationAuthor {
  if (resolvedBy === "worktable" || resolvedBy === "system") {
    return { type: "system", id: resolvedBy }
  }
  const human =
    resolvedBy === "user" ||
    resolvedBy === "local:owner" ||
    resolvedBy.startsWith("workos:")
  return { type: human ? "user" : "agent", id: resolvedBy }
}

function legacyTargetAtPath(
  target: AnnotationTarget,
  path: string
): AnnotationTarget {
  if (target.type === "widget") return { ...target, widgetId: path }
  if ("docPath" in target) return { ...target, docPath: path }
  return target
}

function legacyAnnotation(
  owner: AnnotationOwner,
  annotation: DocumentAnnotationV2
): Annotation | null {
  const translated = translateDocumentAnnotationTargetV2ToLegacy(
    annotation.target,
    legacyKind(owner.document)
  )
  return translated.kind === "resolved"
    ? ({ ...annotation, target: translated.target } as Annotation)
    : null
}

export async function listLegacyCompatibleAnnotationsV2(
  spaceId: string,
  path?: string,
  options: {
    namespaceLockHeld?: boolean
    /** A read that may use the read-model snapshot. */
    snapshot?: boolean
  } = {}
): Promise<Annotation[]> {
  let owners: AnnotationOwner[]
  if (path) {
    if (!analyzeDocumentPath(path).safe) return []
    const result = await useResolvedDocumentHandle({
      spaceId, path, includeArchived: true, ...options,
    }, async (handle) => handle.identity === "durable" ? [await ownerForDocument(spaceId, {
      documentId: handle.documentId, path: handle.document.path, formatId: handle.document.format.id,
    })] : [])
    // A newly discovered file has no durable annotation owner yet. Reading
    // it must neither mint an identity nor prevent its content from opening.
    if (!Array.isArray(result)) {
      throw new DocumentAnnotationError(result.kind === "not-found" ? "not-found" : "conflict", "Document path cannot be resolved")
    }
    owners = result
  } else {
    owners = await allAnnotationOwners(spaceId, options)
  }
  return owners.flatMap((owner) =>
    owner.annotations.flatMap((annotation) => {
      const projected = legacyAnnotation(owner, annotation)
      return projected ? [projected] : []
    })
  )
}

export async function createLegacyCompatibleAnnotationV2(
  spaceId: string,
  input: {
    target: AnnotationTarget
    category: AnnotationCategory
    body: string
    title?: string
    author?: AnnotationAuthor
    labels?: string[]
    idempotencyKey?: string
    metadata?: Record<string, unknown>
    to?: AnnotationRecipient[]
  },
  beforeWrite?: AnnotationWriteGuard
): Promise<{ annotation: Annotation; created: boolean }> {
  const requestedPath =
    input.target.type === "widget"
      ? input.target.widgetId
      : "docPath" in input.target
        ? input.target.docPath
        : null
  if (!requestedPath) throw new Error("Annotation target is not a document")
  return useDurableDocument(spaceId, requestedPath, async (document) => {
    const owner = await ownerForDocument(spaceId, document)
    if (input.idempotencyKey) {
      const existing = owner.annotations.find(
        (annotation) => annotation.idempotencyKey === input.idempotencyKey
      )
      if (existing) {
        if (beforeWrite) await beforeWrite(owner.document.documentId)
        const projected = legacyAnnotation(owner, existing)
        if (!projected) {
          throw new Error("Annotation selector requires the common API")
        }
        return { annotation: projected, created: false }
      }
    }
    const target = translateLegacyDocumentAnnotationTarget(
      legacyTargetAtPath(input.target, owner.document.path),
      {
        documentId: owner.document.documentId,
        logicalPath: owner.document.path,
      }
    )
    if (!target) {
      throw new Error("Annotation target does not match its document")
    }
    const annotation = newAnnotation(spaceId, owner, input)
    annotation.target = target
    owner.annotations.push(annotation)
    await writeOwner(spaceId, owner, beforeWrite)
    const projected = legacyAnnotation(owner, annotation)
    if (!projected) {
      throw new Error("Annotation selector requires the common API")
    }
    return { annotation: projected, created: true }
    // The first comment on a Doc gives it its ID; commenting needs no more.
  }, { materializeIdentity: true, identityAccess: commentAccess() })
}

export async function readLegacyCompatibleAnnotationV2(
  spaceId: string,
  annotationId: string
): Promise<Annotation> {
  const found = await findAnnotation(spaceId, annotationId)
  const projected = legacyAnnotation(found.owner, found.annotation)
  if (!projected) throw new Error("Annotation selector requires the common API")
  return projected
}

export async function updateLegacyCompatibleAnnotationV2(
  spaceId: string,
  annotationId: string,
  patch: DocumentAnnotationUpdatePatch,
  updatedBy: string
): Promise<Annotation> {
  // Legacy callers cannot represent every common selector. Reject before the
  // mutation so an error response never conceals an already-committed update.
  await readLegacyCompatibleAnnotationV2(spaceId, annotationId)
  await updateDocumentAnnotation({ spaceId, annotationId, patch, updatedBy })
  return readLegacyCompatibleAnnotationV2(spaceId, annotationId)
}

export async function replyLegacyCompatibleAnnotationV2(
  spaceId: string,
  annotationId: string,
  body: string,
  author?: AnnotationAuthor,
  options: { replier?: CommentReplier; to?: AnnotationRecipient[] } = {}
): Promise<{ annotation: Annotation; replyId: string }> {
  await readLegacyCompatibleAnnotationV2(spaceId, annotationId)
  const result = await replyDocumentAnnotation({
    spaceId,
    annotationId,
    body,
    author,
    ...options,
  })
  return {
    annotation: await readLegacyCompatibleAnnotationV2(spaceId, annotationId),
    replyId: result.replyId,
  }
}

export async function resolveLegacyCompatibleAnnotationV2(
  spaceId: string,
  annotationId: string,
  reason: string | undefined,
  resolvedBy: string
): Promise<Annotation> {
  await readLegacyCompatibleAnnotationV2(spaceId, annotationId)
  await resolveDocumentAnnotation({
    spaceId,
    annotationId,
    reason,
    resolvedBy,
  })
  return readLegacyCompatibleAnnotationV2(spaceId, annotationId)
}
