// ============================================================
// Worktable MCP Tool Schemas (Zod)
// Single source of truth shared between stdio and HTTP transports.
// ============================================================

import { z } from "zod"
import {
  AnnotationTargetSchema,
  ConversationIdentityIdSchema,
  DOCUMENT_ARCHIVE_REASON_MAX_LENGTH,
  DocumentFormatClaimSchema,
  THREAD_IDENTITY_NAME_MAX_LENGTH,
  ThreadDeliveryStateSchema,
  ThreadLocationSchema,
  ThreadMessageIdSchema,
} from "@worktable/types"

// ---- Core CRUD schemas ----

export const VALID_GROUPS = [
  "work",
  "side-quests",
  "career",
  "church",
  "meta",
] as const

export const DEFAULT_ICON = "folder"

export const CreateSpaceInput = z.object({
  name: z.string().describe("Space name in Title Case, e.g. 'CMS Research'"),
  description: z.string().optional().describe("Optional description"),
  icon: z
    .string()
    .optional()
    .describe(
      `Lucide icon name in kebab-case (e.g. 'flask-conical', 'bar-chart-3', 'layout-dashboard'). Any icon from lucide.dev works. Defaults to '${DEFAULT_ICON}'.`
    ),
  group: z
    .enum(VALID_GROUPS)
    .optional()
    .describe(`Category: ${VALID_GROUPS.join(", ")}`),
})

export const GetStateInput = z.object({
  spaceId: z
    .string()
    .optional()
    .describe("If provided, return full detail for this space"),
  includeArchived: z
    .boolean()
    .optional()
    .describe("When true, include archived spaces and docs in the response."),
})

// ---- Doc schemas ----

export const SpaceIndexInput = z.object({
  spaceId: z.string().describe("ID of the space to build the index for"),
})

export const ListDocsInput = z.object({
  spaceId: z.string().describe("ID of the space to list documents in"),
  includeArchived: z
    .boolean()
    .optional()
    .describe("When true, include archived documents in the results."),
})

export const ReadDocInput = z.object({
  spaceId: z.string({ error: "spaceId is required" }),
  docPath: z
    .string({ error: "docPath is required" })
    .describe("Extensionless path, e.g. 'notes/readme'"),
})

export const WriteDocInput = z.object({
  spaceId: z.string().describe("ID of the space to write the document to"),
  docPath: z.string().describe("Path of the document to create or update"),
  content: z
    .union([z.string(), z.array(z.unknown())])
    .describe(
      "Document content. String = markdown (stored as .md). Array = BlockNote blocks (stored as .json). If writing markdown to an existing .json doc with rich formatting, rejected unless force=true."
    ),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, allows overwriting a .json document containing rich formatting with markdown, accepting data loss."
    ),
})

export const PatchDocInput = z.object({
  spaceId: z.string().describe("ID of the space containing the document"),
  docPath: z.string().describe("Path of the document to patch"),
  operations: z
    .array(
      z.object({
        action: z
          .enum([
            "replace",
            "insert_after",
            "insert_before",
            "delete",
            "append",
          ])
          .describe(
            "replace: replace targeted section. insert_after/before: insert adjacent to target. delete: remove targeted section. append: add to end of document."
          ),
        target: z
          .object({
            blockId: z.string().optional().describe("Exact block ID"),
            heading: z
              .string()
              .optional()
              .describe(
                "Find section by heading text (matches first heading containing this text). For replace/delete, targets the heading AND all content until the next heading of equal or higher level."
              ),
            index: z.number().optional().describe("Block index (0-based)"),
            search: z
              .string()
              .optional()
              .describe("Find first block containing this text"),
          })
          .optional()
          .describe(
            "How to find the block(s) to act on. Not required for 'append'."
          ),
        content: z
          .union([z.string(), z.array(z.unknown())])
          .optional()
          .describe(
            "New content. String = markdown, Array = BlockNote blocks. Not required for 'delete'."
          ),
      })
    )
    .describe("Patch operations applied sequentially."),
})

export const DeleteDocInput = z.object({
  spaceId: z.string().describe("ID of the space containing the document"),
  docPath: z.string().describe("Path of the document to delete"),
})

export const RenameDocInput = z.object({
  spaceId: z.string().describe("ID of the space containing the document"),
  oldPath: z.string().describe("Current path of the document"),
  newPath: z.string().describe("New path to move/rename the document to"),
})

export const MoveDocumentFolderInput = z.object({
  spaceId: z.string().describe("ID of the space containing the folder"),
  oldPath: z.string().describe("Current extensionless folder path"),
  newPath: z.string().describe("New extensionless folder path"),
})

export const ArchiveDocumentFolderInput = z.object({
  spaceId: z.string().describe("ID of the space containing the folder"),
  path: z.string().describe("Extensionless folder path to archive"),
  reason: z
    .string()
    .max(DOCUMENT_ARCHIVE_REASON_MAX_LENGTH)
    .optional()
    .describe("Optional archive reason"),
})

export const RestoreDocumentFolderInput = z.object({
  spaceId: z.string().describe("ID of the space containing the folder"),
  path: z.string().describe("Extensionless folder path to restore"),
})

export const DeleteDocumentFolderInput = z.object({
  spaceId: z.string().describe("ID of the space containing the folder"),
  path: z.string().describe("Extensionless folder path to permanently delete"),
})

// Narrative document writes validate Mermaid automatically. These helpers
// remain useful for Mermaid embedded in arbitrary HTML and for older clients.
export const ValidateMermaidInput = z.object({
  source: z.string().describe("Raw Mermaid source to validate."),
})

export const PreviewMermaidInput = z.object({
  source: z.string().describe("Raw Mermaid source to validate and render."),
  theme: z
    .enum(["light", "dark"])
    .optional()
    .default("dark")
    .describe("Preview theme."),
})

export const SearchInput = z.object({
  spaceId: z
    .string()
    .optional()
    .describe("ID of the space to search in. Omit to search all spaces."),
  query: z
    .string()
    .describe(
      "Search query. Supports fuzzy matching, prefix search, and relevance ranking."
    ),
  includeArchived: z
    .boolean()
    .optional()
    .describe("When true, include archived spaces and documents in results."),
})

// ---- Widget schemas ----

const WidgetPermissionsInput = z
  .object({
    records: z
      .record(
        z.string(),
        z.object({
          read: z.boolean().optional(),
          create: z.boolean().optional(),
          update: z.boolean().optional(),
          delete: z.boolean().optional(),
        })
      )
      .optional(),
    state: z
      .object({ read: z.boolean().optional(), write: z.boolean().optional() })
      .optional(),
    network: z.boolean().optional(),
  })
  .describe(
    "HTML doc bridge permissions. Grant record permissions for every collection the HTML doc calls through worktable.records. Use state for HTML-doc-local UI state and Records for canonical shared data. Set network=true to allow the HTML doc to make outbound https requests (default off)."
  )

export const CreateWidgetInput = z.object({
  spaceId: z.string().describe("ID of the space to create the HTML doc in"),
  id: z
    .string()
    .optional()
    .describe(
      "Optional portable HTML doc path. Slash-separated segments nest it in sidebar folders. Omit to derive a flat path from name."
    ),
  name: z.string().min(1).describe("Display name"),
  description: z
    .string()
    .optional()
    .describe("Short description shown in Worktable"),
  html: z
    .string()
    .min(1)
    .describe(
      "Complete self-contained HTML document. Must follow the Worktable HTML Doc Authoring Contract."
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional YAML-safe metadata"),
  permissions: WidgetPermissionsInput.optional().describe(
    "Optional HTML doc bridge permissions. Include per-collection record access for every worktable.records call the HTML doc makes."
  ),
})

export const UpdateWidgetInput = z.object({
  spaceId: z.string().describe("ID of the space containing the HTML doc"),
  widgetId: z.string().describe("ID of the HTML doc to update"),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Updated display name. Omit to keep current name."),
  description: z
    .string()
    .optional()
    .describe("Updated description. Omit to keep current description."),
  html: z
    .string()
    .min(1)
    .describe(
      "Complete self-contained HTML document. Must follow the Worktable HTML Doc Authoring Contract."
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional YAML-safe metadata. Omit to keep current metadata."),
  permissions: WidgetPermissionsInput.optional().describe(
    "Optional HTML doc bridge permissions. Omit to keep current permissions. Include per-collection record access for every worktable.records call the HTML doc makes."
  ),
})

export const RenameWidgetInput = z.object({
  spaceId: z.string().describe("ID of the space containing the HTML doc"),
  widgetId: z.string().describe("ID of the HTML doc to rename"),
  name: z.string().min(1).describe("Updated display name"),
  description: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Updated description. Null clears it, omit to keep current description."
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional YAML-safe metadata. Omit to keep current metadata."),
})

export const MoveWidgetInput = z.object({
  spaceId: z.string().describe("ID of the space containing the HTML doc"),
  widgetId: z.string().describe("Current path of the HTML doc"),
  newPath: z.string().describe("New path to move the HTML doc to"),
})

export const ArchiveWidgetInput = z.object({
  spaceId: z.string().describe("ID of the space containing the HTML doc"),
  widgetId: z.string().describe("ID of the HTML doc to archive"),
  reason: z.string().optional().describe("Optional archive reason"),
})

export const RestoreWidgetInput = z.object({
  spaceId: z.string().describe("ID of the space containing the HTML doc"),
  widgetId: z.string().describe("ID of the HTML doc to restore"),
})

export const DeleteWidgetInput = z.object({
  spaceId: z.string().describe("ID of the space containing the HTML doc"),
  widgetId: z.string().describe("ID of the HTML doc to permanently delete"),
})

export const ListWidgetsInput = z.object({
  spaceId: z.string().describe("ID of the space to list HTML docs in"),
  includeArchived: z
    .boolean()
    .optional()
    .describe("When true, include archived HTML docs in the results."),
})

export const ReadWidgetInput = z.object({
  spaceId: z.string().describe("ID of the space containing the HTML doc"),
  widgetId: z.string().describe("ID of the HTML doc to read"),
  includeHtml: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "When true, include the index.html content. Set false for metadata-only reads."
    ),
})

// Loose like the REST route: unknown keys/types from newer Worktables round-trip.
const RecordFieldInput = z.looseObject({
  type: z
    .string()
    .min(1)
    .describe(
      "Field type: string, text, number, boolean, date, datetime, url, email, person, select, multi_select, relation, document, json (enum/reference are v1 aliases). Unknown types are stored as-is and treated as read-only."
    ),
  name: z
    .string()
    .optional()
    .describe("Display name; the slug key stays the field's identity"),
  required: z.boolean().optional(),
  values: z
    .array(z.string())
    .optional()
    .describe("Allowed values for select / multi_select fields"),
  references: z
    .string()
    .optional()
    .describe("Target collection id for relation fields"),
  description: z
    .string()
    .optional()
    .describe(
      "Optional concise clarification when the field name, type, and choices do not already make its meaning clear"
    ),
  many: z
    .boolean()
    .optional()
    .describe(
      "relation/document: field holds an array of record ids or portable document paths"
    ),
  inverse: z
    .string()
    .optional()
    .describe(
      "relation only: name for the derived backlink on the target collection"
    ),
  onDelete: z
    .enum(["restrict", "setNull", "none"])
    .optional()
    .describe(
      "relation only: what happens to this field when the referenced record is deleted"
    ),
  unit: z.string().optional().describe("number only: display unit"),
})

export const ListRecordCollectionsInput = z.object({
  spaceId: z.string().describe("ID of the space to list record collections in"),
})

export const UpsertRecordCollectionInput = z.object({
  spaceId: z.string(),
  collectionId: z.string(),
  name: z.string().optional(),
  description: z
    .string()
    .optional()
    .describe(
      "Very concise statement of what belongs in this collection; surfaced to agents"
    ),
  wellKnownType: z
    .string()
    .optional()
    .describe(
      'Optional well-known type hint, e.g. "schema:Person". Ignorable; never a constraint.'
    ),
  fields: z.record(z.string(), RecordFieldInput).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const QueryRecordsInput = z.object({
  spaceId: z.string(),
  collectionId: z.string(),
  where: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Either a flat field map ({status: "open"} / {due: {gte: "2026-01-01"}}) or a predicate tree: {and|or: [...]}, {not: ...}, {field, op, value} with ops eq/neq/in/contains/has/gt/gte/lt/lte/isEmpty (has = exact membership for array fields like multi_select and many-relation id lists; contains = substring). Predicate fields may be one-hop relation paths like "project.status".'
    ),
  search: z.string().optional(),
  orderBy: z
    .union([
      z.string(),
      z.array(
        z.object({ field: z.string(), dir: z.enum(["asc", "desc"]).optional() })
      ),
    ])
    .optional()
    .describe("Field name, or an array for multi-key sort"),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().min(0).max(1000).optional(),
  includeArchived: z.boolean().optional(),
  expand: z
    .record(z.string(), z.union([z.literal(true), z.array(z.string())]))
    .optional()
    .describe(
      "Embed referenced records: {<relationField>: true | [dataKeys...]}. Returned in a side map keyed by collection and id."
    ),
  backlinks: z
    .object({ collection: z.string(), field: z.string() })
    .optional()
    .describe(
      "For each result, list ids of records in <collection> whose <field> points at it"
    ),
  aggregate: z
    .object({
      groupBy: z.string().optional(),
      select: z.record(
        z.string(),
        z.object({
          fn: z.enum(["count", "sum", "avg", "min", "max", "unique"]),
          field: z.string().optional(),
        })
      ),
    })
    .optional()
    .describe("Return aggregated groups instead of records"),
  select: z
    .array(z.string())
    .optional()
    .describe("Project record data down to these keys"),
  cursor: z
    .string()
    .optional()
    .describe("Keyset pagination cursor from a previous response's nextCursor"),
})

export const ReadRecordInput = z.object({
  spaceId: z.string(),
  collectionId: z.string(),
  recordId: z.string(),
})

export const CreateRecordInput = z.object({
  spaceId: z.string(),
  collectionId: z.string(),
  recordId: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const UpdateRecordInput = z.object({
  spaceId: z.string(),
  collectionId: z.string(),
  recordId: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const DeleteRecordInput = z.object({
  spaceId: z.string(),
  collectionId: z.string(),
  recordId: z.string(),
})

// ---- Annotation schemas ----

// Canonical target union from @worktable/types (shared with the store and the
// REST surface) — includes the doc-level `widget` target for HTML docs.
// Storable subset: the store only persists doc/block/text/widget targets.
const AnnotationTargetInput = AnnotationTargetSchema.refine(
  (target) => ["doc", "block", "text", "widget"].includes(target.type),
  { message: "Annotation target must be doc, block, text, or widget" }
)

export const ListAnnotationsInput = z.object({
  spaceId: z.string(),
  docPath: z.string().optional().describe("Filter to one doc's annotations"),
  widgetId: z
    .string()
    .optional()
    .describe("Filter to one HTML doc's (widget's) annotations"),
  blockId: z.string().optional(),
  status: z.array(z.enum(["open", "resolved"])).optional(),
  category: z.array(z.enum(["comment", "instruction"])).optional(),
  createdBy: z.string().optional(),
  labels: z.array(z.string()).optional(),
  includeResolved: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
})

export const ReadAnnotationInput = z.object({
  spaceId: z.string(),
  annotationId: z.string(),
  includeTargetContext: z.boolean().optional(),
})

export const CreateAnnotationInput = z.object({
  spaceId: z.string(),
  target: AnnotationTargetInput,
  category: z.enum(["comment", "instruction"]),
  body: z.string().min(1),
  title: z.string().optional(),
  labels: z.array(z.string()).optional(),
  idempotencyKey: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const ReplyAnnotationInput = z.object({
  spaceId: z.string(),
  annotationId: z.string(),
  body: z.string().min(1),
})

export const UpdateAnnotationInput = z.object({
  spaceId: z.string(),
  annotationId: z.string(),
  patch: z.object({
    title: z.string().optional(),
    body: z.string().optional(),
    status: z.enum(["open", "resolved"]).optional(),
    labels: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
})

export const ResolveAnnotationInput = z.object({
  spaceId: z.string(),
  annotationId: z.string(),
  reason: z.string().optional(),
})

export const GetAnnotationContextInput = z.object({
  spaceId: z.string(),
  annotationId: z.string(),
})

export const ListThreadsInput = z.object({
  location: ThreadLocationSchema.optional(),
  spaceId: z.string().min(1).optional(),
  participantId: z.string().optional(),
  deliveryState: ThreadDeliveryStateSchema.optional(),
})

export const ReadThreadInput = z.object({
  location: ThreadLocationSchema.optional(),
  spaceId: z.string().min(1).optional(),
  threadId: z.string().min(1),
  after: z.number().int().nonnegative().optional(),
  before: z.number().int().positive().optional(),
})

export const ReadThreadMessageInput = z.object({
  location: ThreadLocationSchema.optional(),
  spaceId: z.string().min(1).optional(),
  threadId: z.string().min(1),
  messageId: ThreadMessageIdSchema,
})

export const WaitThreadInput = z.object({
  location: ThreadLocationSchema.optional(),
  spaceId: z.string().min(1).optional(),
  threadId: z.string().min(1),
  after: z.number().int().nonnegative(),
  activityRevision: z.number().int().min(-1).optional(),
  messageId: z.string().optional(),
  waitSeconds: z.number().min(0).max(25).optional(),
})

export const PostThreadInput = z.object({
  location: ThreadLocationSchema.optional(),
  spaceId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  body: z.string().min(1).max(100_000),
  idempotencyKey: z.string().trim().min(1).max(200),
  authorIdentityId: ConversationIdentityIdSchema.optional(),
  deliveryLeaseId: z
    .string()
    .regex(/^lease_[A-Za-z0-9_-]{12,}$/)
    .optional()
    .describe(
      "Delivery-owned authorization for replying as the exact requested identity."
    ),
  notifyIdentityIds: z
    .array(ConversationIdentityIdSchema)
    .max(100)
    .optional()
    .describe(
      "Identities mentioned passively in the message body. Include a visible @Identity name in body for each id. A mention does not activate an agent or require a reply."
    ),
  responseIdentityId: ConversationIdentityIdSchema.nullable()
    .optional()
    .describe(
      "The one identity assigned to reply. An assignment already directs attention, so omit it from notifyIdentityIds. Pass null for no assignment."
    ),
  inReplyTo: ThreadMessageIdSchema.optional(),
  responseTo: ThreadMessageIdSchema.nullable()
    .optional()
    .describe(
      "The assigned message this reply completes. inReplyTo alone adds context and does not complete an assignment."
    ),
  expectsReply: z.boolean().optional(),
  waitSeconds: z.number().min(0).max(25).optional(),
})

export const ClaimThreadDeliveryInput = z.object({
  waitSeconds: z.number().min(0).max(25).optional(),
  threadLocationVersion: z.literal(2).optional(),
})

export const ThreadManagementBaseInput = z.object({
  location: ThreadLocationSchema,
  threadId: z.string().min(1),
})

export const AssignResponseRequestInput = ThreadManagementBaseInput.extend({
  messageId: ThreadMessageIdSchema,
  identityId: ConversationIdentityIdSchema.nullable(),
})

export const AcceptThreadDeliveryInput = z.object({
  messageId: z.string().min(1),
  leaseId: z.string().min(1),
})

export const ProgressThreadDeliveryInput = AcceptThreadDeliveryInput.extend({
  phase: z.enum(["working", "receiving"]),
  receivedCharacters: z.number().int().nonnegative().optional(),
})

export const FailThreadDeliveryInput = AcceptThreadDeliveryInput.extend({
  retryable: z.boolean(),
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(500),
})

// ---- Public capability schemas ----
//
// MCP SDK 1.27 validates a top-level discriminated union but serializes it as
// an empty tools/list schema. Nesting the union under `request` preserves the
// action-specific JSON Schema agents see while keeping validation strict.

function actionSchema<const Action extends string, Shape extends z.ZodRawShape>(
  action: Action,
  shape: Shape
) {
  return z.strictObject({ action: z.literal(action), ...shape })
}

export const DiscoverInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("state", GetStateInput.shape),
    actionSchema("search", SearchInput.shape),
    actionSchema("space_index", SpaceIndexInput.shape),
  ]),
})

export const SpacesInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("create", CreateSpaceInput.shape),
  ]),
})

export const DocsReadInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("list", ListDocsInput.shape),
    actionSchema("read", ReadDocInput.shape),
  ]),
})

export const DocumentsReadInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("list", ListDocsInput.shape),
    actionSchema("read", {
      spaceId: ReadDocInput.shape.spaceId,
      path: z
        .string({ error: "path is required" })
        .describe("Extensionless document path, e.g. 'notes/readme'"),
      includeArchived: ListDocsInput.shape.includeArchived,
    }),
    actionSchema("read_source", {
      spaceId: ReadDocInput.shape.spaceId,
      path: z.string().min(1).max(4096),
    }),
    actionSchema("versions", {
      spaceId: ReadDocInput.shape.spaceId,
      path: z.string().min(1).max(4096),
      all: z.boolean().optional().default(false),
    }),
  ]),
})

const GenericDocumentSourceInput = {
  source: z.string().max(90_000_000),
  encoding: z.enum(["utf8", "base64"]).optional().default("utf8"),
}

export const DocumentsWriteInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("create", {
      spaceId: ReadDocInput.shape.spaceId,
      path: z.string().min(1).max(4096),
      format: DocumentFormatClaimSchema,
      ...GenericDocumentSourceInput,
      reason: z.string().max(2048).optional(),
    }),
    actionSchema("replace", {
      spaceId: ReadDocInput.shape.spaceId,
      path: z.string().min(1).max(4096),
      ...GenericDocumentSourceInput,
      expectedRevision: z.string().min(1).max(256),
      reason: z.string().max(2048).optional(),
    }),
    actionSchema("checkpoint", {
      spaceId: ReadDocInput.shape.spaceId,
      path: z.string().min(1).max(4096),
      expectedRevision: z.string().min(1).max(256),
      label: z.string().min(1).max(256).optional(),
      reason: z.string().max(2048).optional(),
    }),
    actionSchema("restore_version", {
      spaceId: ReadDocInput.shape.spaceId,
      path: z.string().min(1).max(4096),
      versionId: z.string().min(1).max(256),
      store: z.enum(["v2", "legacy-v1"]).optional().default("v2"),
      expectedRevision: z.string().min(1).max(256),
      reason: z.string().max(2048).optional(),
    }),
    actionSchema("move", {
      spaceId: ReadDocInput.shape.spaceId,
      path: z.string().min(1).max(4096),
      to: z.string().min(1).max(4096),
    }),
    actionSchema("archive", {
      spaceId: ReadDocInput.shape.spaceId,
      path: z.string().min(1).max(4096),
      reason: z.string().max(DOCUMENT_ARCHIVE_REASON_MAX_LENGTH).optional(),
    }),
    actionSchema("restore", {
      spaceId: ReadDocInput.shape.spaceId,
      path: z.string().min(1).max(4096),
    }),
    actionSchema("move_folder", MoveDocumentFolderInput.shape),
    actionSchema("archive_folder", ArchiveDocumentFolderInput.shape),
    actionSchema("restore_folder", RestoreDocumentFolderInput.shape),
  ]),
})

export const DocsWriteInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("write", WriteDocInput.shape),
    actionSchema("patch", PatchDocInput.shape),
    actionSchema("rename", RenameDocInput.shape),
  ]),
})

const HtmlIdInput = z.string().describe("ID of the HTML doc")

export const HtmlReadInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("guide", {
      profile: z.literal("runtime").optional().default("runtime"),
    }),
    actionSchema("list", ListWidgetsInput.shape),
    actionSchema("read", {
      spaceId: ReadWidgetInput.shape.spaceId,
      htmlId: HtmlIdInput,
      includeHtml: ReadWidgetInput.shape.includeHtml,
    }),
  ]),
})

export const HtmlWriteInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("create", CreateWidgetInput.shape),
    actionSchema("update", {
      spaceId: UpdateWidgetInput.shape.spaceId,
      htmlId: HtmlIdInput,
      name: UpdateWidgetInput.shape.name,
      description: UpdateWidgetInput.shape.description,
      html: UpdateWidgetInput.shape.html,
      metadata: UpdateWidgetInput.shape.metadata,
      permissions: UpdateWidgetInput.shape.permissions,
    }),
    actionSchema("rename", {
      spaceId: RenameWidgetInput.shape.spaceId,
      htmlId: HtmlIdInput,
      name: RenameWidgetInput.shape.name,
      description: RenameWidgetInput.shape.description,
      metadata: RenameWidgetInput.shape.metadata,
    }),
    actionSchema("move", {
      spaceId: MoveWidgetInput.shape.spaceId,
      htmlId: HtmlIdInput,
      newPath: MoveWidgetInput.shape.newPath,
    }),
    actionSchema("archive", {
      spaceId: ArchiveWidgetInput.shape.spaceId,
      htmlId: HtmlIdInput,
      reason: ArchiveWidgetInput.shape.reason,
    }),
    actionSchema("restore", {
      spaceId: RestoreWidgetInput.shape.spaceId,
      htmlId: HtmlIdInput,
    }),
  ]),
})

export const RecordsReadInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("list_collections", ListRecordCollectionsInput.shape),
    actionSchema("query", QueryRecordsInput.shape),
    actionSchema("read", ReadRecordInput.shape),
  ]),
})

export const RecordsWriteInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("upsert_collection", UpsertRecordCollectionInput.shape),
    actionSchema("create", CreateRecordInput.shape),
    actionSchema("update", UpdateRecordInput.shape),
  ]),
})

const PublicAnnotationTargetInput = z.discriminatedUnion("type", [
  AnnotationTargetSchema.options[0],
  AnnotationTargetSchema.options[1],
  AnnotationTargetSchema.options[2],
  z.strictObject({
    type: z.literal("html"),
    htmlId: HtmlIdInput,
  }),
])

export const AnnotationsReadInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("list", {
      ...ListAnnotationsInput.omit({ widgetId: true }).shape,
      htmlId: HtmlIdInput.optional().describe("Filter to one HTML doc"),
    }),
    actionSchema("read", ReadAnnotationInput.shape),
    actionSchema("context", GetAnnotationContextInput.shape),
  ]),
})

export const AnnotationsWriteInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("create", {
      ...CreateAnnotationInput.omit({ target: true }).shape,
      target: PublicAnnotationTargetInput,
    }),
    actionSchema("reply", ReplyAnnotationInput.shape),
    actionSchema("update", UpdateAnnotationInput.shape),
    actionSchema("resolve", ResolveAnnotationInput.shape),
  ]),
})

export const ThreadsReadInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("participants", {}),
    actionSchema("list", ListThreadsInput.shape),
    actionSchema("read", ReadThreadInput.shape),
    actionSchema("message", ReadThreadMessageInput.shape),
    actionSchema("wait", WaitThreadInput.shape),
  ]),
})

export const ThreadsWriteInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("post", PostThreadInput.shape),
    actionSchema("assign_response", AssignResponseRequestInput.shape),
  ]),
})

export const ThreadDeliveryInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("register_participant", {
      name: z.string().trim().min(1).max(THREAD_IDENTITY_NAME_MAX_LENGTH),
    }),
    actionSchema("claim", ClaimThreadDeliveryInput.shape),
    actionSchema("accept", AcceptThreadDeliveryInput.shape),
    actionSchema("progress", ProgressThreadDeliveryInput.shape),
    actionSchema("fail", FailThreadDeliveryInput.shape),
  ]),
})

export const DeleteInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("document", {
      spaceId: ReadDocInput.shape.spaceId,
      path: z.string().min(1).max(4096),
    }),
    actionSchema("doc", DeleteDocInput.shape),
    actionSchema("html", {
      spaceId: DeleteWidgetInput.shape.spaceId,
      htmlId: HtmlIdInput,
    }),
    actionSchema("document_folder", DeleteDocumentFolderInput.shape),
    actionSchema("record", DeleteRecordInput.shape),
  ]),
})

export const GuidanceInput = z.strictObject({
  request: z.discriminatedUnion("action", [actionSchema("format_spec", {})]),
})

export const MermaidInput = z.strictObject({
  request: z.discriminatedUnion("action", [
    actionSchema("validate", ValidateMermaidInput.shape),
    actionSchema("preview", PreviewMermaidInput.shape),
  ]),
})

export type PublicCapabilityRequest =
  | z.infer<typeof DiscoverInput>
  | z.infer<typeof SpacesInput>
  | z.infer<typeof DocumentsReadInput>
  | z.infer<typeof DocumentsWriteInput>
  | z.infer<typeof DocsReadInput>
  | z.infer<typeof DocsWriteInput>
  | z.infer<typeof HtmlReadInput>
  | z.infer<typeof HtmlWriteInput>
  | z.infer<typeof RecordsReadInput>
  | z.infer<typeof RecordsWriteInput>
  | z.infer<typeof AnnotationsReadInput>
  | z.infer<typeof AnnotationsWriteInput>
  | z.infer<typeof ThreadsReadInput>
  | z.infer<typeof ThreadsWriteInput>
  | z.infer<typeof ThreadDeliveryInput>
  | z.infer<typeof DeleteInput>
  | z.infer<typeof GuidanceInput>
  | z.infer<typeof MermaidInput>
