// ============================================================
// Worktable MCP operation dispatcher. Public capability tools adapt to these
// transport-agnostic operation ids in tools.ts.
// ============================================================

import {
  listSpaces,
  readSpace,
  writeSpace,
  slugify,
  deduplicateSlug,
  listDocsDetailed,
  readDoc,
  readDocSourceSnapshot,
  sanitizeDocPath,
  writeDoc,
  deleteDoc,
  docExists,
  docStat,
  getDocArchiveInfo,
  getDocProvenance,
  getSpaceArchiveInfo,
} from "../store.ts"
import {
  ensureWorkspaceManifest,
  workspaceProvenanceMode,
} from "../workspace.ts"
import {
  listWidgets,
  readWidget,
  readWidgetDocument,
  setWidgetArchived,
  updateWidgetMetadata,
  withWidgetWriteLock,
  writeWidget,
} from "../widget-store.ts"
import {
  captureWidgetVersionContent,
  recordWidgetVersion,
} from "../widget-version-store.ts"
import { deleteHtmlDocument } from "../html-document-delete.ts"
import { moveHtmlDocument } from "../html-document-move.ts"
import { createHtmlDocument } from "../html-document-create.ts"
import { withCanonicalHtmlDocumentPath } from "../html-document-path.ts"
import {
  buildRecordCollectionSchema,
  createRecord,
  deleteRecord,
  findRecordBounded,
  getRecordDiagnostics,
  listRecordCollections,
  queryRecords,
  readRecord,
  readRecordCollectionSchema,
  updateRecord,
  writeRecordCollectionSchema,
} from "../record-store.ts"
import {
  buildWidgetFile,
  getHtmlAuthoringGuide,
  getBlockingWidgetIssue,
  validateWidgetHtml,
  WIDGET_STYLE_TOKENS,
} from "../widget-authoring.ts"
import {
  WidgetIdSchema,
  type AnnotationAuthor,
  type RecordCollectionSchema,
  type SpaceFile,
  type WidgetFile,
} from "@worktable/types"
import {
  isHtmlDocumentPath,
  usesHtmlDocumentStorageV2,
} from "../html-document-storage-v2.ts"
import { DEFAULT_AGENT_PRINCIPAL } from "./helpers.ts"
import { listDocuments, readDocument } from "../document-query.ts"
import { readDocumentVersions } from "../document-page-service.ts"
import {
  checkpointRegisteredDocument,
  createRegisteredDocument,
  deleteRegisteredDocument,
  moveRegisteredDocument,
  readRegisteredDocumentSource,
  replaceRegisteredDocument,
  restoreRegisteredDocumentVersion,
  setRegisteredDocumentArchived,
} from "../document-write-service.ts"
import {
  hasScope,
  type RequestPrincipal,
  type TokenIdentity,
} from "../token-store.ts"
import { resolveDocAlias } from "../doc-aliases.ts"
import { withDocPathLock } from "../doc-path-lock.ts"
import {
  extractMarkdownMermaid,
  prepareDocumentContent,
  protectEscapedMermaidFences,
  restoreEscapedMermaidFences,
} from "../mermaid-document.ts"
import {
  logRecordPracticeWarnings,
  recordPracticeIdentitiesMatch,
  recordPracticeIdentity,
  reviewRecordCreate,
  reviewRecordSchema,
} from "./record-practices.ts"
import { OPERATION_DEFINITIONS, type OperationId } from "./operations.ts"
import {
  search as miniSearch,
  invalidateSearchIndex,
  noteRecordMutated,
} from "../search-index.ts"
import {
  decorateDocsWithFreshness,
  evictFreshness,
  getDocFreshness,
} from "../freshness.ts"
import {
  decorateWidgetsWithFreshness,
  getWidgetFreshness,
} from "../widget-freshness.ts"
import { decorateDocsWithBacklinkCounts, getDocLinks } from "../link-graph.ts"
import { buildSpaceIndex } from "../space-index.ts"
import {
  validateDocConventions,
  type DocConventionIssue,
} from "../doc-conventions.ts"
import { getWikiConfig } from "../wiki-config.ts"
import { yjsManager } from "../yjs-manager.ts"
import { renameDocAndSync } from "../doc-rename.ts"
import { moveDocumentFolder } from "../document-folder-move.ts"
import { setDocumentFolderArchived } from "../document-folder-archive.ts"
import { deleteDocumentFolder } from "../document-folder-delete.ts"
import { wsManager } from "../ws.ts"
import { FORMAT_SPEC } from "./format-spec.ts"
import {
  isMarkdownSafe,
  blocksToMarkdownSafe,
  markdownToBlocks,
  extractMarkdownHeadings,
  extractHeadings,
  containsMermaidBlock,
  getRichBlockTypes,
  summarizeBlocks,
  applyPatchOperations,
  type PatchOperation,
} from "../markdown.ts"
import { previewMermaid, validateMermaid } from "../mermaid.ts"
import {
  createAnnotation,
  getAnnotationContext,
  listAnnotations,
  readAnnotation,
  replyAnnotation,
  resolveAnnotation,
  updateAnnotation,
} from "../annotation-store.ts"
import {
  DEFAULT_ICON,
  VALID_GROUPS,
  SpaceIndexInput,
  ListAnnotationsInput,
  ReadAnnotationInput,
  CreateAnnotationInput,
  ReplyAnnotationInput,
  UpdateAnnotationInput,
  ResolveAnnotationInput,
  GetAnnotationContextInput,
  ListThreadsInput,
  ReadThreadInput,
  ReadThreadMessageInput,
  WaitThreadInput,
  PostThreadInput,
  AssignResponseRequestInput,
  ClaimThreadDeliveryInput,
  AcceptThreadDeliveryInput,
  ProgressThreadDeliveryInput,
  FailThreadDeliveryInput,
  MoveDocumentFolderInput,
  ArchiveDocumentFolderInput,
  RestoreDocumentFolderInput,
  DeleteDocumentFolderInput,
} from "./schemas.ts"

import { resolveParticipant } from "../participant-store.ts"
import {
  acceptDelivery,
  assignResponseRequest,
  claimNextThreadDelivery,
  failDelivery,
  listThreadParticipants,
  listThreadSummaries,
  postThreadMessage,
  progressDelivery,
  readThreadMessages,
  readThreadMessage,
  waitForThreadReply,
  type ThreadProgressUpdate,
} from "../thread-service.ts"

function decodeGenericDocumentSource(
  source: string,
  encoding: "utf8" | "base64"
): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(source)
  const normalized = source.replace(/=+$/u, "")
  const bytes = Buffer.from(source, "base64")
  if (bytes.toString("base64").replace(/=+$/u, "") !== normalized) {
    throw new Error("Document source is not valid base64")
  }
  return bytes
}

function buildBlockDocMetadata(blocks: unknown[]) {
  const headings = extractHeadings(blocks)
  const blockCount = blocks.length
  const lossy = isMarkdownSafe(blocks)
  const richBlockTypes = getRichBlockTypes(blocks)
  const containsMermaid = containsMermaidBlock(blocks)

  return {
    headings,
    blockCount,
    lossyFields: lossy.lossyFields,
    readFormatHint: lossy.safe ? ("markdown" as const) : ("blocknote" as const),
    richBlockTypes,
    containsMermaid,
    blockSummary: summarizeBlocks(blocks),
  }
}

function buildMarkdownDocMetadata(markdown: string) {
  return {
    headings: extractMarkdownHeadings(markdown),
    blockCount: null,
    lossyFields: [] as string[],
    readFormatHint: "markdown" as const,
    richBlockTypes: [] as string[],
    containsMermaid: extractMarkdownMermaid(markdown).length > 0,
    blockSummary: [] as ReturnType<typeof summarizeBlocks>,
  }
}

async function restoreProtectedEscapedMermaidBlocks(
  blocks: unknown[],
  protection: ReturnType<typeof protectEscapedMermaidFences>
): Promise<unknown[]> {
  const replacements = new Map<string, unknown[]>()
  for (const literal of protection.literals) {
    replacements.set(
      literal.placeholder,
      await markdownToBlocks(literal.markdown)
    )
  }

  const restore = (values: unknown[]): unknown[] =>
    values.flatMap((value) => {
      if (!value || typeof value !== "object") return [value]
      const block = value as Record<string, unknown>
      const text = Array.isArray(block.content)
        ? block.content
            .map((inline) =>
              inline && typeof inline === "object"
                ? ((inline as Record<string, unknown>).text ?? "")
                : ""
            )
            .join("")
        : ""
      const replacement = replacements.get(String(text))
      if (replacement) return replacement
      const content = Array.isArray(block.content)
        ? block.content.map((inline) => {
            if (!inline || typeof inline !== "object") return inline
            const item = inline as Record<string, unknown>
            if (typeof item.text !== "string") return inline
            let restoredText = item.text
            for (const literal of protection.literals) {
              restoredText = restoredText.replace(
                literal.placeholder,
                literal.markdown
              )
            }
            return restoredText === item.text
              ? inline
              : { ...item, text: restoredText }
          })
        : block.content
      return [
        {
          ...block,
          content,
          ...(Array.isArray(block.children)
            ? { children: restore(block.children) }
            : {}),
        },
      ]
    })

  return restore(blocks)
}

function parsePatchOperations(raw: unknown): PatchOperation[] {
  if (Array.isArray(raw)) return raw as PatchOperation[]
  throw new Error("docs.patch operations must be an array")
}

/**
 * Convention guidance computed on the doc's final written state. Warnings
 * only — agents are guided, never blocked (humans via the UI skip this
 * path entirely). Mirrors the widget-validation result shape.
 */
async function docWriteWarnings(
  spaceId: string,
  docPath: string
): Promise<DocConventionIssue[]> {
  try {
    const doc = await readDoc(spaceId, docPath)
    if (doc.error || doc.data === null) return []
    const [space, { links }] = await Promise.all([
      readSpace(spaceId),
      getDocLinks(spaceId, docPath),
    ])
    return validateDocConventions({
      docPath,
      content: doc.data as string | unknown[],
      links,
      cfg: getWikiConfig(space.data),
    })
  } catch {
    // Guidance must never fail a successful write.
    return []
  }
}

async function syncDocAfterToolWrite(
  spaceId: string,
  docPath: string
): Promise<void> {
  invalidateSearchIndex()
  evictFreshness(spaceId, docPath)

  const doc = await readDoc(spaceId, docPath)
  if (!doc.error && Array.isArray(doc.data)) {
    await yjsManager.replaceContent(spaceId, docPath, doc.data)
  }

  const statResult = await docStat(spaceId, docPath)
  const provenance = await getDocProvenance(spaceId, docPath)
  const freshness = await getDocFreshness(spaceId, docPath, { provenance })
  wsManager.broadcast(spaceId, {
    type: "doc_update",
    spaceId,
    docPath,
    data: {
      path: docPath,
      content: doc.data,
      updatedAt: statResult?.updatedAt ?? Date.now(),
      provenance,
      freshness,
    },
  })
}

interface ToolDispatchContext {
  principal?: RequestPrincipal
  identity?: Pick<TokenIdentity, "agent" | "credentialClass" | "principal">
  scopes?: string[]
  canReadRecords?: boolean
  onThreadProgress?: (update: ThreadProgressUpdate) => void | Promise<void>
}

export async function dispatchOperation(
  operationId: OperationId,
  args: Record<string, unknown>,
  context: ToolDispatchContext = {}
): Promise<unknown> {
  const result = await _dispatchOperationInner(operationId, args, {
    ...context,
    principal: context.principal ?? DEFAULT_AGENT_PRINCIPAL,
  })
  const operation = OPERATION_DEFINITIONS[operationId]
  if (operation?.mutation === "records") {
    noteRecordMutated()
  } else if (operation?.mutation === "workspace") {
    invalidateSearchIndex()
  }
  return result
}

async function _dispatchOperationInner(
  operationId: OperationId,
  args: Record<string, unknown>,
  context: ToolDispatchContext & { principal: RequestPrincipal }
): Promise<unknown> {
  const { principal } = context
  const identity = {
    ...(context.identity ?? {
      agent: principal.type === "agent" ? principal.displayName : null,
      principal,
    }),
    scopes: context.scopes ?? ["*"],
  }
  const actorId = principal.id
  const annotationAuthor: AnnotationAuthor = {
    type: principal.type === "human" ? "user" : principal.type,
    id: actorId,
    name: principal.displayName,
  }
  const threadLocationInput = (
    location:
      | { kind: "worktable" }
      | { kind: "space"; spaceId: string }
      | undefined,
    spaceId: string | undefined
  ) => {
    if (
      location &&
      spaceId &&
      (location.kind !== "space" || location.spaceId !== spaceId)
    ) {
      throw new Error(
        "location and deprecated spaceId must identify the same Space"
      )
    }
    return (
      location ?? (spaceId ? { kind: "space" as const, spaceId } : undefined)
    )
  }
  switch (operationId) {
    case "threads.participants": {
      return { participants: await listThreadParticipants(identity) }
    }
    case "threads.list": {
      const parsed = ListThreadsInput.parse(args)
      return {
        threads: await listThreadSummaries(
          identity,
          threadLocationInput(parsed.location, parsed.spaceId),
          parsed.participantId,
          parsed.deliveryState
        ),
      }
    }
    case "threads.read": {
      const parsed = ReadThreadInput.parse(args)
      if (parsed.after !== undefined && parsed.before !== undefined) {
        throw new Error("Use after or before, not both")
      }
      return await readThreadMessages(identity, parsed.threadId, {
        location: threadLocationInput(parsed.location, parsed.spaceId),
        after: parsed.after,
        before: parsed.before,
      })
    }
    case "threads.message": {
      const parsed = ReadThreadMessageInput.parse(args)
      return await readThreadMessage(identity, {
        threadId: parsed.threadId,
        messageId: parsed.messageId,
        location: threadLocationInput(parsed.location, parsed.spaceId),
      })
    }
    case "threads.wait": {
      const parsed = WaitThreadInput.parse(args)
      return await waitForThreadReply(identity, {
        ...parsed,
        location: threadLocationInput(parsed.location, parsed.spaceId),
        onProgress: context.onThreadProgress,
      })
    }
    case "threads.post": {
      const parsed = PostThreadInput.parse(args)
      return await postThreadMessage(
        identity,
        {
          ...parsed,
          location: threadLocationInput(parsed.location, parsed.spaceId),
        },
        context.onThreadProgress
      )
    }
    case "threads.assign_response": {
      const parsed = AssignResponseRequestInput.parse(args)
      const thread = await assignResponseRequest(identity, parsed)
      const message = thread.messages.find(
        (candidate) => candidate.id === parsed.messageId
      )
      if (!message) throw new Error("Assigned thread message was not returned")
      return {
        threadId: thread.id,
        revision: thread.revision,
        messageId: message.id,
        responseRequest: message.responseRequest ?? null,
      }
    }
    case "thread_delivery.register_participant": {
      const name = String(args["name"] ?? "").trim()
      if (!name || name.length > 120) {
        throw new Error("name is required to register a participant")
      }
      return await resolveParticipant(identity, {
        name,
        // Self-registration is a new adapter-only operation, so it always opts
        // into Worktable-wide V2 thread locations without another public flag.
        threadLocationVersion: 2,
      })
    }
    case "thread_delivery.claim": {
      const parsed = ClaimThreadDeliveryInput.parse(args)
      return {
        delivery: await claimNextThreadDelivery(
          identity,
          parsed.waitSeconds,
          parsed.threadLocationVersion
        ),
      }
    }
    case "thread_delivery.accept": {
      const parsed = AcceptThreadDeliveryInput.parse(args)
      return {
        activity: await acceptDelivery(
          identity,
          parsed.messageId,
          parsed.leaseId
        ),
      }
    }
    case "thread_delivery.progress": {
      const parsed = ProgressThreadDeliveryInput.parse(args)
      return {
        activity: await progressDelivery(identity, parsed),
      }
    }
    case "thread_delivery.fail": {
      const parsed = FailThreadDeliveryInput.parse(args)
      return {
        activity: await failDelivery(identity, parsed),
      }
    }
    case "spaces.create": {
      const rawName = args["name"] as string
      const description = args["description"] as string | undefined
      const rawIcon = args["icon"] as string | undefined
      const rawGroup = args["group"] as string | undefined

      // Title Case the name
      const name = rawName.replace(/\b\w/g, (c) => c.toUpperCase())

      // Validate icon: must be a Lucide name, no emoji
      let icon = rawIcon ?? DEFAULT_ICON
      if ([...icon].some((character) => character.codePointAt(0)! > 127)) {
        icon = DEFAULT_ICON // reject emoji, use default
      }

      // Validate group
      const group =
        rawGroup && (VALID_GROUPS as readonly string[]).includes(rawGroup)
          ? rawGroup
          : undefined

      const existing = await listSpaces()
      const spaceId = await deduplicateSlug(
        slugify(name),
        existing.map((s) => s.id)
      )
      const now = new Date().toISOString()
      const space: SpaceFile = {
        type: "worktable.space",
        version: 1,
        id: spaceId,
        name,
        description,
        icon,
        createdAt: now,
        updatedAt: now,
        createdBy: actorId,
        settings: {},
        group,
      }
      await writeSpace(space)
      return { spaceId }
    }
    case "html.guide": {
      return {
        profile: "runtime" as const,
        guide: getHtmlAuthoringGuide(),
        tokens: WIDGET_STYLE_TOKENS,
      }
    }
    case "documents.list": {
      return {
        documents: await listDocuments({
          spaceId: args["spaceId"] as string,
          includeArchived:
            (args["includeArchived"] as boolean | undefined) ?? false,
        }),
      }
    }
    case "documents.read": {
      return {
        result: await readDocument({
          spaceId: args["spaceId"] as string,
          path: args["path"] as string,
          includeArchived:
            (args["includeArchived"] as boolean | undefined) ?? false,
        }),
      }
    }
    case "documents.read_source": {
      const result = await readRegisteredDocumentSource({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
      })
      return {
        documentId: result.documentId,
        path: result.path,
        format: result.format,
        source: Buffer.from(result.bytes).toString("base64"),
        encoding: "base64" as const,
        byteLength: result.bytes.byteLength,
        sourceRevision: result.sourceRevision,
      }
    }
    case "documents.versions": {
      const result = await readDocumentVersions({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        includeArchived: true,
        checkpointsOnly: !((args["all"] as boolean | undefined) ?? false),
      })
      if (result.kind !== "versions") {
        throw new Error(
          result.kind === "not-found"
            ? "Document not found"
            : result.kind === "unsupported"
              ? "Version history is not available for this document"
              : "Document path cannot be resolved"
        )
      }
      return { versions: result.versions }
    }
    case "documents.create": {
      const result = await createRegisteredDocument({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        format: args["format"] as {
          id: string
          sourceVersion: number
        },
        bytes: decodeGenericDocumentSource(
          args["source"] as string,
          (args["encoding"] as "utf8" | "base64" | undefined) ?? "utf8"
        ),
        createdBy: actorId,
        source: "mcp",
        reason: args["reason"] as string | undefined,
      })
      return { ok: true, ...result }
    }
    case "documents.replace": {
      const result = await replaceRegisteredDocument({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        bytes: decodeGenericDocumentSource(
          args["source"] as string,
          (args["encoding"] as "utf8" | "base64" | undefined) ?? "utf8"
        ),
        expectedRevision: args["expectedRevision"] as string,
        updatedBy: actorId,
        source: "mcp",
        reason: args["reason"] as string | undefined,
      })
      return { ok: true, ...result }
    }
    case "documents.checkpoint": {
      const result = await checkpointRegisteredDocument({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        expectedRevision: args["expectedRevision"] as string,
        createdBy: actorId,
        source: "mcp",
        label: args["label"] as string | undefined,
        reason: args["reason"] as string | undefined,
      })
      return { ok: true, ...result }
    }
    case "documents.restore_version": {
      const result = await restoreRegisteredDocumentVersion({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        versionId: args["versionId"] as string,
        store: (args["store"] as "v2" | "legacy-v1" | undefined) ?? "v2",
        expectedRevision: args["expectedRevision"] as string,
        restoredBy: actorId,
        source: "mcp",
        reason: args["reason"] as string | undefined,
      })
      return { ok: true, ...result }
    }
    case "documents.move": {
      const moved = await moveRegisteredDocument({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        to: args["to"] as string,
      })
      return {
        ok: true,
        ...moved,
        path: moved.to,
      }
    }
    case "documents.archive": {
      return {
        ok: true,
        ...(await setRegisteredDocumentArchived({
          spaceId: args["spaceId"] as string,
          path: args["path"] as string,
          archived: true,
          archivedBy: actorId,
          reason: args["reason"] as string | undefined,
        })),
      }
    }
    case "documents.restore": {
      return {
        ok: true,
        ...(await setRegisteredDocumentArchived({
          spaceId: args["spaceId"] as string,
          path: args["path"] as string,
          archived: false,
          archivedBy: actorId,
        })),
      }
    }
    case "documents.delete": {
      return {
        ok: true,
        ...(await deleteRegisteredDocument({
          spaceId: args["spaceId"] as string,
          path: args["path"] as string,
        })),
      }
    }
    case "html.list": {
      const spaceId = args["spaceId"] as string
      const includeArchived =
        (args["includeArchived"] as boolean | undefined) ?? false
      const { data: space, error } = await readSpace(spaceId)
      if (error || !space) throw new Error(error ?? "Space not found")
      return {
        widgets: await decorateWidgetsWithFreshness(
          spaceId,
          await listWidgets(spaceId, { includeArchived })
        ),
      }
    }
    case "html.read": {
      const spaceId = args["spaceId"] as string
      const requestedWidgetId = args["widgetId"] as string
      const includeHtml = (args["includeHtml"] as boolean | undefined) ?? true
      return withDocPathLock(spaceId, async () => {
        const aliasResolution = await resolveDocAlias(
          spaceId,
          requestedWidgetId
        )
        if (!aliasResolution.path) {
          throw new Error(
            aliasResolution.error ?? "Document alias resolution failed"
          )
        }
        const widgetId = aliasResolution.path
        return withWidgetWriteLock(spaceId, widgetId, async () => {
          if (!includeHtml) {
            const { data: widget, error } = await readWidget(spaceId, widgetId)
            if (error || !widget) throw new Error(error ?? "Widget not found")
            return { widget, freshness: await getWidgetFreshness(spaceId, widget) }
          }
          const { data, error } = await readWidgetDocument(spaceId, widgetId)
          if (error || !data) throw new Error(error ?? "Widget content not found")
          return {
            widget: data.widget,
            freshness: await getWidgetFreshness(spaceId, data.widget),
            html: data.html,
            warnings: validateWidgetHtml(data.html, data.widget.permissions),
          }
        })
      })
    }
    case "records.list_collections": {
      const spaceId = args["spaceId"] as string
      return { collections: await listRecordCollections(spaceId) }
    }
    case "records.upsert_collection": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      const existing = await readRecordCollectionSchema(spaceId, collectionId)
      const schema = buildRecordCollectionSchema({
        id: collectionId,
        name: args["name"] as string | undefined,
        description: args["description"] as string | undefined,
        wellKnownType: args["wellKnownType"] as string | undefined,
        fields: args["fields"] as RecordCollectionSchema["fields"],
        metadata: args["metadata"] as Record<string, unknown> | undefined,
        createdBy: actorId,
        existing: existing.data ?? undefined,
      })
      const warnings = reviewRecordSchema({
        schema,
        existingSchema: existing.data,
      })
      const result = await writeRecordCollectionSchema(spaceId, schema)
      if (result.error || !result.data)
        throw new Error(result.error ?? "Write failed")
      wsManager.broadcast(spaceId, {
        type: "record_collection_update",
        spaceId,
        collectionId,
        data: result.data,
      })
      logRecordPracticeWarnings("schema_upsert", warnings, {
        fieldCount: Object.keys(schema.fields).length,
      })
      return {
        collection: result.data,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    }
    case "records.query": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      const result = await queryRecords(spaceId, collectionId, args)
      const diagnostics = await getRecordDiagnostics(spaceId, collectionId)
      if (diagnostics.length === 0) return result
      return {
        ...result,
        warnings: [
          ...(result.warnings ?? []),
          `${diagnostics.length} record file(s) in this collection are unreadable and excluded from results. Files: ${diagnostics.map((d) => d.file).join(", ")}`,
        ],
      }
    }
    case "records.read": {
      const { data, error } = await readRecord(
        args["spaceId"] as string,
        args["collectionId"] as string,
        args["recordId"] as string
      )
      if (error || !data) throw new Error(error ?? "Record not found")
      return { record: data }
    }
    case "records.create": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      const data = args["data"] as Record<string, unknown>
      const schema = await readRecordCollectionSchema(spaceId, collectionId)
      const identity = recordPracticeIdentity(data, schema.data)
      const duplicate =
        context.canReadRecords !== false && identity
          ? await findRecordBounded(
              spaceId,
              collectionId,
              (record) => {
                const existing = recordPracticeIdentity(
                  record.data,
                  schema.data
                )
                return (
                  existing !== null &&
                  recordPracticeIdentitiesMatch(existing, identity)
                )
              },
              { includeArchived: true, maxFiles: 100 }
            )
          : null
      const existingRecords = duplicate ? [duplicate] : []
      const warnings = reviewRecordCreate({
        schema: schema.data,
        data,
        existingRecords,
      })
      const result = await createRecord(spaceId, collectionId, {
        id: args["recordId"] as string | undefined,
        data,
        metadata: args["metadata"] as Record<string, unknown> | undefined,
        createdBy: actorId,
      })
      if (result.error || !result.data)
        throw new Error(result.error ?? "Write failed")
      wsManager.broadcast(spaceId, {
        type: "record_update",
        spaceId,
        collectionId,
        recordId: result.data.id,
        data: result.data,
      })
      logRecordPracticeWarnings("record_create", warnings, {
        duplicateMatchCount: existingRecords.length,
      })
      return {
        record: result.data,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    }
    case "records.update": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      const recordId = args["recordId"] as string
      const result = await updateRecord(spaceId, collectionId, recordId, {
        data: args["data"] as Record<string, unknown> | undefined,
        metadata: args["metadata"] as Record<string, unknown> | undefined,
        updatedBy: actorId,
      })
      if (result.error || !result.data)
        throw new Error(result.error ?? "Update failed")
      wsManager.broadcast(spaceId, {
        type: "record_update",
        spaceId,
        collectionId,
        recordId,
        data: result.data,
      })
      return { record: result.data }
    }
    case "records.delete": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      const recordId = args["recordId"] as string
      const result = await deleteRecord(spaceId, collectionId, recordId)
      if (result.error) throw new Error(result.error)
      wsManager.broadcast(spaceId, {
        type: "record_deleted",
        spaceId,
        collectionId,
        recordId,
      })
      return { ok: true }
    }
    case "html.create": {
      const spaceId = args["spaceId"] as string
      const { data: space, error: sErr } = await readSpace(spaceId)
      if (sErr || !space) throw new Error(sErr ?? "Space not found")
      const name = args["name"] as string
      const description = args["description"] as string | undefined
      const html = args["html"] as string
      const metadata = args["metadata"] as Record<string, unknown> | undefined
      const permissions = args["permissions"] as WidgetFile["permissions"]
      const explicitId = args["id"] as string | undefined
      const storageV2 = await usesHtmlDocumentStorageV2()
      if (
        explicitId !== undefined &&
        (storageV2
          ? !isHtmlDocumentPath(explicitId)
          : !WidgetIdSchema.safeParse(explicitId).success)
      ) {
        throw new Error(
          storageV2
            ? `Invalid HTML document path "${explicitId}".`
            : `Invalid widget id "${explicitId}". Ids are slash-separated segments of lowercase letters, digits, and hyphens (nesting it in sidebar folders); nested ids may not use reserved segment names (records, state, content, archive, restore, versions, review).`
        )
      }
      const warnings = validateWidgetHtml(html, permissions)
      const blockingIssue = getBlockingWidgetIssue(warnings)
      if (blockingIssue)
        throw new Error(`${blockingIssue.code}: ${blockingIssue.message}`)
      const created = await createHtmlDocument({
        spaceId,
        explicitId,
        name,
        description,
        html,
        createdBy: actorId,
        metadata,
        permissions,
        versionSource: "mcp",
        versionUpdatedBy: actorId,
      })
      if (!created.data) throw new Error(created.error ?? "Widget write failed")
      const widgetId = created.data.id
      wsManager.broadcast(spaceId, {
        type: "widget_update",
        spaceId,
        widgetId,
        data: created.data,
      })
      return { widgetId, widget: created.data, warnings }
    }
    case "html.update": {
      const spaceId = args["spaceId"] as string
      const widgetId = args["widgetId"] as string
      const html = args["html"] as string
      const updated = await withCanonicalHtmlDocumentPath(
        spaceId,
        widgetId,
        () =>
          withWidgetWriteLock(spaceId, widgetId, async () => {
            const { data: existing, error } = await readWidget(spaceId, widgetId)
            if (error || !existing) throw new Error(error ?? "Widget not found")
            const permissions =
              (args["permissions"] as WidgetFile["permissions"]) ??
              existing.permissions
            const warnings = validateWidgetHtml(html, permissions)
            const blockingIssue = getBlockingWidgetIssue(warnings)
            if (blockingIssue)
              throw new Error(`${blockingIssue.code}: ${blockingIssue.message}`)
            const beforeContent = await captureWidgetVersionContent(
              spaceId,
              widgetId
            )
            const result = await writeWidget(
              spaceId,
              buildWidgetFile({
                id: widgetId,
                name: (args["name"] as string | undefined) ?? existing.name,
                description:
                  (args["description"] as string | undefined) ??
                  existing.description,
                updatedBy: actorId,
                metadata: args["metadata"] as
                  | Record<string, unknown>
                  | undefined,
                permissions,
                existing,
              }),
              html
            )
            if (result.error || !result.data)
              throw new Error(result.error ?? "Widget write failed")
            await recordWidgetVersion(spaceId, widgetId, beforeContent, {
              source: "mcp",
              updatedBy: actorId,
            })
            result.release?.()
            return { data: result.data, warnings }
          }),
        { materialize: true }
      )
      wsManager.broadcast(spaceId, {
        type: "widget_update",
        spaceId,
        widgetId,
        data: updated.data,
      })
      return { widgetId, widget: updated.data, warnings: updated.warnings }
    }
    case "html.rename": {
      const spaceId = args["spaceId"] as string
      const widgetId = args["widgetId"] as string
      const renamed = await withCanonicalHtmlDocumentPath(
        spaceId,
        widgetId,
        () =>
          withWidgetWriteLock(spaceId, widgetId, async () => {
            const beforeContent = await captureWidgetVersionContent(
              spaceId,
              widgetId
            )
            const result = await updateWidgetMetadata(spaceId, widgetId, {
              name: args["name"] as string,
              description: args["description"] as string | null | undefined,
              metadata: args["metadata"] as Record<string, unknown> | undefined,
              updatedBy: actorId,
            })
            if (result.error || !result.data)
              throw new Error(result.error ?? "Widget update failed")
            await recordWidgetVersion(spaceId, widgetId, beforeContent, {
              source: "mcp",
              updatedBy: actorId,
            })
            result.release?.()
            return result.data
          }),
        { materialize: true }
      )
      wsManager.broadcast(spaceId, {
        type: "widget_update",
        spaceId,
        widgetId,
        data: renamed,
      })
      return { widgetId, widget: renamed }
    }
    case "html.move": {
      const spaceId = args["spaceId"] as string
      const widgetId = args["widgetId"] as string
      const newPath = args["newPath"] as string
      const result = await moveHtmlDocument(spaceId, widgetId, newPath)
      if (!result.ok) throw new Error(result.error)
      return {
        widgetId: result.to,
        oldPath: result.from,
        newPath: result.to,
      }
    }
    case "html.archive": {
      const spaceId = args["spaceId"] as string
      const widgetId = args["widgetId"] as string
      const result = await withCanonicalHtmlDocumentPath(spaceId, widgetId, () =>
        setWidgetArchived(
          spaceId,
          widgetId,
          true,
          actorId,
          args["reason"] as string | undefined
        ),
        { materialize: true, transactionOwnsPathLock: true }
      )
      if (result.error || !result.data)
        throw new Error(result.error ?? "Widget archive failed")
      wsManager.broadcast(spaceId, {
        type: "widget_update",
        spaceId,
        widgetId,
        data: result.data,
      })
      return { ok: true, widgetId, widget: result.data }
    }
    case "html.restore": {
      const spaceId = args["spaceId"] as string
      const widgetId = args["widgetId"] as string
      const result = await withCanonicalHtmlDocumentPath(spaceId, widgetId, () =>
        setWidgetArchived(spaceId, widgetId, false, actorId),
        { materialize: true, transactionOwnsPathLock: true }
      )
      if (result.error || !result.data)
        throw new Error(result.error ?? "Widget restore failed")
      wsManager.broadcast(spaceId, {
        type: "widget_update",
        spaceId,
        widgetId,
        data: result.data,
      })
      return { ok: true, widgetId, widget: result.data }
    }
    case "html.delete": {
      const spaceId = args["spaceId"] as string
      const widgetId = args["widgetId"] as string
      const result = await deleteHtmlDocument(spaceId, widgetId)
      if (!result.ok) throw new Error(result.error)
      return { ok: true, widgetId }
    }
    case "workspace.state": {
      const spaceId = args["spaceId"] as string | undefined
      const includeArchived =
        (args["includeArchived"] as boolean | undefined) ?? false
      if (!spaceId) {
        const spaces = (await listSpaces()).filter(
          (space) => includeArchived || !getSpaceArchiveInfo(space)
        )
        const spacesWithDetail = await Promise.all(
          spaces.map(async (space) => {
            const docs = await listDocsDetailed(space.id, { includeArchived })
            return {
              id: space.id,
              name: space.name,
              description: space.description,
              docCount: docs.length,
            }
          })
        )
        const manifest = ensureWorkspaceManifest()
        const mode = workspaceProvenanceMode(manifest)
        return {
          // Surface workspace identity + provenance so an orienting agent immediately
          // learns whether this is the real workspace or a disposable sandbox copy.
          workspace: {
            name: manifest.name,
            mode,
            ...(mode !== "daily" && manifest.provenance?.source?.label
              ? { source: { label: manifest.provenance.source.label } }
              : {}),
          },
          spaces: spacesWithDetail,
          hint: "Use worktable_discover actions state, space_index, or search to drill into workspace content.",
        }
      }
      const { data: space, error: spaceErr } = await readSpace(spaceId)
      if (spaceErr || !space) throw new Error(spaceErr ?? "Space not found")
      if (!includeArchived && getSpaceArchiveInfo(space)) {
        throw new Error(
          `Space is archived: ${spaceId}. Re-run with includeArchived=true to inspect it.`
        )
      }
      const docs = await decorateDocsWithBacklinkCounts(
        spaceId,
        await decorateDocsWithFreshness(
          spaceId,
          await listDocsDetailed(spaceId, { includeArchived })
        )
      )
      return { space, docs }
    }
    case "workspace.search": {
      const spaceId = args["spaceId"] as string | undefined
      const query = args["query"] as string
      const includeArchived = args["includeArchived"] as boolean | undefined
      const commonDocuments = hasScope(identity.scopes, "documents:read")

      const results = await miniSearch(query, {
        spaceId,
        searchBlocks: false,
        includeArchived: includeArchived ?? false,
        maxResults: 50,
        documentAccess: commonDocuments ? "common" : "legacy",
      })

      // Doc hits carry trust signals so consumers can weight unreviewed
      // agent-written content down at query time.
      const decorated = await Promise.all(
        results.map(async (hit) => {
          if (hit.type !== "doc" || !hit.path) return hit
          if (hit.documentKind) {
            if (hit.documentKind !== "document" || hit.health !== "supported") {
              return hit
            }
            if (hit.documentView === "html") {
              const { data: widget } = await readWidget(hit.spaceId, hit.path)
              if (!widget) return hit
              const freshness = await getWidgetFreshness(hit.spaceId, widget)
              return {
                ...hit,
                humanReviewed: freshness.humanReviewed,
                lastHumanTouch: freshness.lastHumanTouch,
              }
            }
            if (hit.documentView !== "doc") return hit
          }
          const freshness = await getDocFreshness(hit.spaceId, hit.path)
          return {
            ...hit,
            humanReviewed: freshness.humanReviewed,
            lastHumanTouch: freshness.lastHumanTouch,
          }
        })
      )

      return { results: decorated }
    }
    case "annotations.list": {
      const parsed = ListAnnotationsInput.parse(args)
      return await listAnnotations(parsed.spaceId, {
        target: parsed.docPath
          ? {
              docPath: parsed.docPath,
              ...(parsed.blockId ? { blockId: parsed.blockId } : {}),
            }
          : parsed.widgetId
            ? { widgetId: parsed.widgetId }
            : undefined,
        status: parsed.status as never,
        category: parsed.category as never,
        createdBy: parsed.createdBy,
        labels: parsed.labels,
        includeResolved: parsed.includeResolved,
        limit: parsed.limit,
        offset: parsed.offset,
      })
    }
    case "annotations.read": {
      const parsed = ReadAnnotationInput.parse(args)
      const annotation = await readAnnotation(
        parsed.spaceId,
        parsed.annotationId
      )
      const context = parsed.includeTargetContext
        ? await getAnnotationContext(parsed.spaceId, parsed.annotationId)
        : undefined
      return { annotation, context }
    }
    case "annotations.create": {
      const parsed = CreateAnnotationInput.parse(args)
      const result = await createAnnotation(parsed.spaceId, {
        target: parsed.target as never,
        category: parsed.category,
        body: parsed.body,
        title: parsed.title,
        author: annotationAuthor,
        labels: parsed.labels,
        idempotencyKey: parsed.idempotencyKey,
        metadata: parsed.metadata,
      })
      wsManager.broadcast(parsed.spaceId, {
        type: "annotation_update",
        spaceId: parsed.spaceId,
        data: {
          annotationId: result.annotation.id,
          annotation: result.annotation,
          event: "created",
        },
      })
      return {
        ok: true,
        annotationId: result.annotation.id,
        annotation: result.annotation,
        created: result.created,
      }
    }
    case "annotations.reply": {
      const parsed = ReplyAnnotationInput.parse(args)
      const result = await replyAnnotation(
        parsed.spaceId,
        parsed.annotationId,
        parsed.body,
        annotationAuthor
      )
      wsManager.broadcast(parsed.spaceId, {
        type: "annotation_update",
        spaceId: parsed.spaceId,
        data: {
          annotationId: result.annotation.id,
          annotation: result.annotation,
          event: "replied",
        },
      })
      return {
        ok: true,
        replyId: result.replyId,
        annotation: result.annotation,
      }
    }
    case "annotations.update": {
      const parsed = UpdateAnnotationInput.parse(args)
      const annotation = await updateAnnotation(
        parsed.spaceId,
        parsed.annotationId,
        parsed.patch as never,
        actorId
      )
      wsManager.broadcast(parsed.spaceId, {
        type: "annotation_update",
        spaceId: parsed.spaceId,
        data: { annotationId: annotation.id, annotation, event: "updated" },
      })
      return { ok: true, annotation }
    }
    case "annotations.resolve": {
      const parsed = ResolveAnnotationInput.parse(args)
      const annotation = await resolveAnnotation(
        parsed.spaceId,
        parsed.annotationId,
        parsed.reason,
        actorId
      )
      wsManager.broadcast(parsed.spaceId, {
        type: "annotation_update",
        spaceId: parsed.spaceId,
        data: { annotationId: annotation.id, annotation, event: "resolved" },
      })
      return { ok: true, annotation }
    }
    case "annotations.context": {
      const parsed = GetAnnotationContextInput.parse(args)
      return {
        context: await getAnnotationContext(
          parsed.spaceId,
          parsed.annotationId
        ),
      }
    }
    case "docs.read": {
      const spaceId = args["spaceId"] as string
      const requestedDocPath = sanitizeDocPath(args["docPath"] as string)
      const aliasResolution = await resolveDocAlias(spaceId, requestedDocPath)
      if (!aliasResolution.path) {
        throw new Error(
          aliasResolution.error ?? "Document alias resolution failed"
        )
      }
      const docPath = aliasResolution.path
      const exists = await docExists(spaceId, docPath)
      if (!exists) throw new Error(`Document not found: ${docPath}`)
      const result = await readDoc(spaceId, docPath)
      if (result.error || result.data === null)
        throw new Error(result.error ?? "Failed to read document")
      const archived = await getDocArchiveInfo(spaceId, docPath)
      // Trust signals ride along on every read so the agent can weight
      // stale or unreviewed content without a second call.
      const freshness = await getDocFreshness(spaceId, docPath)
      const { links, backlinks } = await getDocLinks(spaceId, docPath)

      // If stored as JSON, try to return markdown for agent convenience
      if (result.storedAs === "json" && Array.isArray(result.data)) {
        const metadata = buildBlockDocMetadata(result.data)

        if (metadata.readFormatHint === "markdown") {
          // Convert to markdown for the agent. Conversion must never
          // fail the read: foreign props/styles from other BlockNote
          // versions fall back to returning the raw blocks below.
          const markdown = await blocksToMarkdownSafe(result.data)
          if (markdown !== null) {
            return {
              docPath,
              content: markdown,
              format: "markdown",
              storedAs: "json",
              archived,
              links,
              backlinks,
              ...freshness,
              ...metadata,
            }
          }
        }

        // Return JSON with metadata about why
        return {
          docPath,
          content: result.data,
          format: "blocknote",
          storedAs: "json",
          archived,
          links,
          backlinks,
          ...freshness,
          ...metadata,
          reason:
            metadata.lossyFields.length > 0
              ? `Document contains rich formatting (${metadata.lossyFields.join(", ")}) that cannot be represented in markdown`
              : "Markdown conversion unavailable for this document; returning raw blocks",
        }
      }

      // Stored as .md: return markdown directly
      if (result.storedAs === "md" && typeof result.data === "string") {
        const metadata = buildMarkdownDocMetadata(result.data)
        return {
          docPath,
          content: result.data,
          format: "markdown",
          storedAs: "md",
          archived,
          links,
          backlinks,
          ...freshness,
          ...metadata,
        }
      }

      // Fallback
      return {
        docPath,
        content: result.data,
        format: result.format,
        storedAs: result.storedAs,
        archived,
        links,
        backlinks,
        ...freshness,
      }
    }
    case "docs.write": {
      const spaceId = args["spaceId"] as string
      const docPath = args["docPath"] as string
      const content = args["content"] as unknown[] | string
      const force = (args["force"] as boolean) ?? false

      const result = await writeDoc(spaceId, docPath, content, {
        force,
        updatedBy: actorId,
        source: "mcp",
        managedIdentity: true,
        mermaidValidation: "strict",
      })
      if (!result.ok) {
        throw new Error(result.error ?? "Write failed")
      }
      await syncDocAfterToolWrite(spaceId, docPath)
      return {
        ok: true,
        docPath,
        storedAs: result.storedAs,
        repairs: result.repairs ?? [],
        warnings: await docWriteWarnings(spaceId, docPath),
      }
    }
    case "docs.patch": {
      const spaceId = args["spaceId"] as string
      const docPath = args["docPath"] as string
      const operations = parsePatchOperations(args["operations"])

      const exists = await docExists(spaceId, docPath)
      if (!exists) throw new Error(`Document not found: ${docPath}`)

      const mermaidRepairs: import("@worktable/types").MermaidDocumentRepair[] =
        []

      // Load doc and convert to blocks
      const snapshot = await readDocSourceSnapshot(spaceId, docPath)
      const doc = snapshot.result
      if (doc.error || doc.data === null)
        throw new Error(doc.error ?? "Failed to read document")
      if (!snapshot.revision)
        throw new Error("Failed to capture document source revision")

      let blocks: Awaited<ReturnType<typeof markdownToBlocks>>
      let escapedFenceProtection: ReturnType<
        typeof protectEscapedMermaidFences
      > | null = null
      if (doc.storedAs === "md" && typeof doc.data === "string") {
        escapedFenceProtection = protectEscapedMermaidFences(doc.data)
        blocks = await markdownToBlocks(escapedFenceProtection.markdown)
      } else if (Array.isArray(doc.data)) {
        const prepared = await prepareDocumentContent(doc.data, {
          validation: "allow-invalid",
        })
        blocks = prepared.content as Awaited<
          ReturnType<typeof markdownToBlocks>
        >
      } else {
        throw new Error("Unexpected document format")
      }

      // Apply operations
      const result = await applyPatchOperations(blocks, operations, {
        prepareContent: async (content) => {
          const prepared = await prepareDocumentContent(content, {
            validation: "strict",
          })
          mermaidRepairs.push(...prepared.repairs)
          return prepared.content
        },
      })
      if (result.operationsApplied === 0 && operations.length > 0) {
        const detail = result.skipped
          .map(
            (skip) => `op ${skip.index + 1} (${skip.action}): ${skip.reason}`
          )
          .join("; ")
        throw new Error(
          `No patch operations applied. ${detail || "All operations were skipped."}`
        )
      }

      // Save back in the original format (or upgrade if needed)
      let finalStoredAs = doc.storedAs
      if (doc.storedAs === "md") {
        const safety = isMarkdownSafe(result.blocks)
        // Conversion failure must not eat the patch — fall back to .json.
        let md = safety.safe ? await blocksToMarkdownSafe(result.blocks) : null
        if (md !== null && escapedFenceProtection) {
          md = restoreEscapedMermaidFences(md, escapedFenceProtection)
        }
        if (md !== null) {
          const written = await writeDoc(spaceId, docPath, md, {
            updatedBy: actorId,
            source: "mcp",
            reason: "Patched markdown document",
            mermaidValidation: "strict",
            repairEscapedMermaidFences: false,
            sourceRevision: snapshot.revision,
            managedIdentity: true,
          })
          if (!written.ok) throw new Error(written.error ?? "Write failed")
          mermaidRepairs.push(...(written.repairs ?? []))
          finalStoredAs = "md"
        } else {
          // New content has lossy blocks: upgrade to .json
          const blocksToWrite = escapedFenceProtection
            ? await restoreProtectedEscapedMermaidBlocks(
                result.blocks,
                escapedFenceProtection
              )
            : result.blocks
          const written = await writeDoc(spaceId, docPath, blocksToWrite, {
            updatedBy: actorId,
            source: "mcp",
            reason: "Patched markdown document and upgraded to BlockNote",
            mermaidValidation: "strict",
            sourceRevision: snapshot.revision,
            managedIdentity: true,
          })
          if (!written.ok) throw new Error(written.error ?? "Write failed")
          mermaidRepairs.push(...(written.repairs ?? []))
          finalStoredAs = "json"
        }
      } else {
        // Was .json, stays .json
        const written = await writeDoc(spaceId, docPath, result.blocks, {
          updatedBy: actorId,
          source: "mcp",
          reason: "Patched BlockNote document",
          mermaidValidation: "strict",
          sourceRevision: snapshot.revision,
          managedIdentity: true,
        })
        if (!written.ok) throw new Error(written.error ?? "Write failed")
        mermaidRepairs.push(...(written.repairs ?? []))
        finalStoredAs = "json"
      }

      await syncDocAfterToolWrite(spaceId, docPath)

      const headings = extractHeadings(result.blocks)
      return {
        ok: true,
        docPath,
        storedAs: finalStoredAs,
        repairs: mermaidRepairs,
        operationsApplied: result.operationsApplied,
        skipped: result.skipped,
        blockCount: result.blocks.length,
        headings,
        warnings: await docWriteWarnings(spaceId, docPath),
      }
    }
    case "docs.delete": {
      const spaceId = args["spaceId"] as string
      const docPath = args["docPath"] as string
      const deleteResult = await deleteDoc(spaceId, docPath)
      if (deleteResult.error) throw new Error(deleteResult.error)
      if (deleteResult.notFound) {
        throw new Error(`Document not found: ${docPath}`)
      }
      evictFreshness(spaceId, docPath)
      return { ok: true, docPath }
    }
    case "docs.rename": {
      const spaceId = args["spaceId"] as string
      const oldPath = args["oldPath"] as string
      const newPath = args["newPath"] as string
      const outcome = await renameDocAndSync(spaceId, oldPath, newPath)
      if (outcome.error) throw new Error(outcome.error)
      const move = outcome.renamed[0]!
      return { ok: true, oldPath: move.from, newPath: move.to }
    }
    case "documents.move_folder": {
      const parsed = MoveDocumentFolderInput.parse(args)
      const result = await moveDocumentFolder(
        parsed.spaceId,
        parsed.oldPath,
        parsed.newPath
      )
      if (!result.ok) throw new Error(result.error)
      return {
        ok: true,
        oldPath: result.from,
        newPath: result.to,
        count: result.renamed.length,
        renamed: result.renamed,
      }
    }
    case "documents.archive_folder": {
      const parsed = ArchiveDocumentFolderInput.parse(args)
      const result = await setDocumentFolderArchived({
        spaceId: parsed.spaceId,
        path: parsed.path,
        archived: true,
        archivedBy: actorId,
        reason: parsed.reason,
      })
      if (!result.ok) throw new Error(result.error)
      return {
        ok: true,
        path: result.path,
        archived: true,
        count: result.paths.length,
        paths: result.paths,
      }
    }
    case "documents.restore_folder": {
      const parsed = RestoreDocumentFolderInput.parse(args)
      const result = await setDocumentFolderArchived({
        spaceId: parsed.spaceId,
        path: parsed.path,
        archived: false,
        archivedBy: actorId,
      })
      if (!result.ok) throw new Error(result.error)
      return {
        ok: true,
        path: result.path,
        archived: false,
        count: result.paths.length,
        paths: result.paths,
      }
    }
    case "documents.delete_folder": {
      const parsed = DeleteDocumentFolderInput.parse(args)
      const result = await deleteDocumentFolder(parsed.spaceId, parsed.path)
      if (!result.ok) throw new Error(result.error)
      return {
        ok: true,
        path: result.path,
        count: result.paths.length,
        paths: result.paths,
      }
    }
    case "docs.list": {
      const spaceId = args["spaceId"] as string
      const includeArchived =
        (args["includeArchived"] as boolean | undefined) ?? false
      const docs = await decorateDocsWithBacklinkCounts(
        spaceId,
        await decorateDocsWithFreshness(
          spaceId,
          await listDocsDetailed(spaceId, { includeArchived })
        )
      )
      return { docs }
    }
    case "workspace.space_index": {
      const parsed = SpaceIndexInput.parse(args)
      const index = await buildSpaceIndex(parsed.spaceId)
      if (!index) throw new Error(`Space not found: ${parsed.spaceId}`)
      return { index }
    }
    case "mermaid.validate": {
      return await validateMermaid(args["source"] as string)
    }
    case "mermaid.preview": {
      const theme = (args["theme"] as "light" | "dark" | undefined) ?? "dark"
      return await previewMermaid(args["source"] as string, theme)
    }
    case "guidance.format_spec": {
      return { spec: FORMAT_SPEC.trim() }
    }
    default:
      throw new Error(`Unknown operation: ${operationId}`)
  }
}
