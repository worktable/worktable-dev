import {
  DrawingObjectTypeSchema,
  DocumentPreviewResultSchema,
  AnnotationAuthorSchema,
  AnnotationMessageSchema,
  AnnotationSchema,
  AnnotationTargetSchema,
  ArchiveInfoSchema,
  CanonicalIdSchema,
  ConversationIdentitySchema,
  DocumentFormatClaimSchema,
  DocumentHealthSchema,
  DocumentListItemSchema,
  DocumentReadResultSchema,
  DocumentVersionSummarySchema,
  LegacyThreadMessageSchema,
  ParticipantRefSchema,
  RecordCollectionSchemaSchema,
  RecordFileSchema,
  SpaceFileSchema,
  ThreadActivitySchema,
  ThreadLocationSchema,
  ThreadMemberSchema,
  ThreadMessageV3Schema,
  ThreadResponseRequestSchema,
  ThreadV3Schema,
  WidgetFileSchema,
  ResolvedStartHerePinSchema,
} from "@worktable/types"
import { z } from "zod"
import { type OperationId, type WorktableToolName } from "./operations.ts"

type OutputVariant = z.ZodObject

const PortableSpaceFileSchema = SpaceFileSchema.loose().meta({ id: "Space" })
const PortableCanonicalIdSchema = CanonicalIdSchema.meta({ id: "CanonicalId" })
const PortableHtmlIdSchema = z.string().min(1).max(4096).meta({ id: "HtmlId" })
const PortableArchiveInfoSchema = ArchiveInfoSchema.loose().meta({
  id: "ArchiveInfo",
})
const PortableHtmlDocSchema = WidgetFileSchema.omit({ id: true })
  .extend({ id: PortableHtmlIdSchema })
  .loose()
  .meta({ id: "HtmlDoc" })
const PortableDocumentListItemSchema = DocumentListItemSchema.meta({
  id: "DocumentListItem",
})
const PortableDocumentReadResultSchema = DocumentReadResultSchema.meta({
  id: "DocumentReadResult",
})
const PortableDocumentVersionSummarySchema = DocumentVersionSummarySchema.meta({
  id: "DocumentVersionSummary",
})

const DrawingBoundsOutputSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
})
const DrawingBindingOutputSchema = z.object({
  shapeId: z.string(),
  anchor: z.enum(["top", "right", "bottom", "left", "center"]),
})
const DrawingPreviewOutputSchema = DocumentPreviewResultSchema.extend({
  labels: z.array(z.object({ label: z.string(), id: z.string() })).optional(),
  bounds: DrawingBoundsOutputSchema.optional(),
})
const DocumentRenderOutputSchema = z.looseObject({
  documentId: z.string().optional(),
  path: z.string(),
  sourceRevision: z.string(),
  preview: DocumentPreviewResultSchema,
})
const DrawingResultOutputSchema = z.looseObject({
  documentId: z.string().optional(),
  path: z.string(),
  sourceRevision: z.string().nullable(),
  title: z.string().optional(),
  previewOnly: z.boolean().optional(),
  objects: z
    .array(
      z.looseObject({
        id: z.string(),
        type: DrawingObjectTypeSchema,
        x: z.number(),
        y: z.number(),
        rotation: z.number(),
        z: z.number(),
        bounds: DrawingBoundsOutputSchema,
        text: z.string().optional(),
        color: z.string().optional(),
        size: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        dx: z.number().optional(),
        dy: z.number().optional(),
        bend: z.number().optional(),
        startBinding: DrawingBindingOutputSchema.optional(),
        endBinding: DrawingBindingOutputSchema.optional(),
        pointCount: z.number().optional(),
        textTruncated: z.boolean().optional(),
        textLength: z.number().optional(),
      })
    )
    .optional(),
  assets: z
    .array(
      z.looseObject({
        id: z.string(),
        type: z.literal("asset"),
        width: z.number(),
        height: z.number(),
        mimeType: z.string(),
      })
    )
    .optional(),
  assetsTruncated: z.boolean().optional(),
  total: z.number().optional(),
  nextOffset: z.number().nullable().optional(),
  stats: z.object({ shapes: z.number(), assets: z.number() }).optional(),
  changes: z
    .array(
      z.looseObject({
        changeId: z.string(),
        operation: z.enum(["create", "edit", "undo", "redo"]),
        summary: z.string(),
        addedIds: z.array(z.string()).optional(),
        changedIds: z.array(z.string()).optional(),
        removedIds: z.array(z.string()).optional(),
        addedCount: z.number().optional(),
        changedCount: z.number().optional(),
        removedCount: z.number().optional(),
        affectedIdsTruncated: z.boolean().optional(),
        titleChanged: z.boolean().optional(),
        createdAt: z.string(),
        createdBy: z.string(),
        state: z.enum(["prepared", "committed"]),
        reverses: z.string().optional(),
        undoAvailable: z.boolean(),
      })
    )
    .optional(),
  changeId: z.string().optional(),
  references: z.record(z.string(), z.string()).optional(),
  replayed: z.boolean().optional(),
  addedIds: z.array(z.string()).optional(),
  changedIds: z.array(z.string()).optional(),
  removedIds: z.array(z.string()).optional(),
  titleChanged: z.boolean().optional(),
  description: z.string().optional(),
  retention: z.string(),
  historical: z.boolean().optional(),
  versionId: z.string().optional(),
  preview: DrawingPreviewOutputSchema.optional(),
  urlToSendInChat: z.string().optional(),
})

const LifetimeOutputFields = {
  lifetime: z.enum(["durable", "temporary"]).optional(),
  archiveOn: z
    .string()
    .optional()
    .describe("Present on temporary documents: when the document archives."),
}

const DrawingInspectOutputSchema = DrawingResultOutputSchema.extend({
  ...LifetimeOutputFields,
  createdAt: z.string().optional(),
})

const GenericDocumentMutationOutputSchema = z.looseObject({
  ok: z.literal(true),
  documentId: z.string(),
  path: z.string(),
  format: DocumentFormatClaimSchema.optional(),
  sourceRevision: z.string().optional(),
  versionId: z.string().optional(),
})
const PortableRecordCollectionSchema = RecordCollectionSchemaSchema.meta({
  id: "RecordCollection",
})
const PortableRecordSchema = RecordFileSchema.meta({ id: "Record" })
const PortableParticipantSchema = ParticipantRefSchema.loose().meta({
  id: "ThreadParticipant",
})
const PortableThreadLocationSchema = z
  .discriminatedUnion("kind", [
    ThreadLocationSchema.options[0].loose(),
    ThreadLocationSchema.options[1].loose(),
  ])
  .meta({ id: "ThreadLocation" })
const PortableThreadMessageSchema = ThreadMessageV3Schema.loose().meta({
  id: "ThreadMessage",
})
const PortableLegacyThreadMessageSchema = LegacyThreadMessageSchema.loose()
const PortableThreadSchema = ThreadV3Schema.meta({ id: "Thread" })
const PortableThreadActivitySchema = ThreadActivitySchema.loose().meta({
  id: "ThreadActivity",
})
const PortableThreadResponseRequestSchema =
  ThreadResponseRequestSchema.loose().meta({ id: "ThreadResponseRequest" })

const UrlToSendInChatSchema = z
  .string()
  .url()
  .describe("Current-install URL suitable for sending in chat.")

const ProvenanceSchema = z.looseObject({
  updatedAt: z.string(),
  updatedBy: z.string(),
  source: z.string(),
  versionId: z.string(),
  contentHash: z.string(),
})

const DocListEntrySchema = z
  .looseObject({
    path: z.string(),
    format: z.enum(["blocknote", "markdown"]),
    storedAs: z.enum(["json", "md"]).optional(),
    readFormatHint: z.enum(["blocknote", "markdown"]).optional(),
    updatedAt: z.number().optional(),
    headings: z.array(z.string()).optional(),
    blockCount: z.number().int().nonnegative().nullable().optional(),
    containsMermaid: z.boolean().optional(),
    richBlockTypes: z.array(z.string()).optional(),
    archived: PortableArchiveInfoSchema.optional(),
    createdAt: z.string().optional(),
    archiveOn: LifetimeOutputFields.archiveOn,
    provenance: ProvenanceSchema.optional(),
    backlinkCount: z.number().int().nonnegative().optional(),
  })
  .meta({ id: "DocListEntry" })

const DocLinkSchema = z.looseObject({
  target: z.string(),
  resolvedPath: z.string(),
  resolved: z.boolean(),
})

const BlockSummarySchema = z.looseObject({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  type: z.string(),
  text: z.string().optional(),
  preview: z.string().optional(),
})

const MermaidRepairSchema = z.looseObject({
  code: z.literal("ESCAPED_MERMAID_FENCE_REPAIRED"),
  diagramIndex: z.number().int().nonnegative(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
})

const GuidanceIssueSchema = z.looseObject({
  severity: z.enum(["hint", "warning"]),
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
})

const HtmlValidationIssueSchema = z.looseObject({
  severity: z.enum(["hint", "warning", "error"]),
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  suggestedPermissions: z
    .looseObject({
      network: z.boolean().optional(),
      records: z
        .record(
          z.string(),
          z.looseObject({
            read: z.boolean().optional(),
            create: z.boolean().optional(),
            update: z.boolean().optional(),
            delete: z.boolean().optional(),
          })
        )
        .optional(),
      state: z
        .looseObject({
          read: z.boolean().optional(),
          write: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
})

const RecordPracticeWarningSchema = z.looseObject({
  code: z.enum([
    "collection_description_too_long",
    "large_initial_schema",
    "many_optional_narrative_fields",
    "near_synonymous_fields",
    "system_provenance_field",
    "missing_recognizable_title",
    "duplicate_title",
    "identifier_like_title",
  ]),
  message: z.string(),
  suggestion: z.string(),
  evidence: z
    .record(z.string(), z.union([z.number(), z.array(z.string())]))
    .optional(),
})

const WorkspaceOverviewSchema = z.looseObject({
  workspace: z.looseObject({
    name: z.string(),
    mode: z.enum(["daily", "staging", "sandbox", "fixture"]),
    source: z.looseObject({ label: z.string() }).optional(),
  }),
  spaces: z.array(
    z.looseObject({
      id: PortableCanonicalIdSchema,
      name: z.string(),
      description: z.string().optional(),
      docCount: z.number().int().nonnegative(),
    })
  ),
  hint: z.string(),
})

const SpaceDetailSchema = z.looseObject({
  space: PortableSpaceFileSchema,
  startHere: z
    .array(ResolvedStartHerePinSchema)
    .optional()
    .describe("Pinned starting points; read these first."),
  docs: z.array(DocListEntrySchema),
  documents: z.array(PortableDocumentListItemSchema).optional(),
})

const ListScopeSchema = z
  .looseObject({
    spaceId: z.string().optional(),
    pathPrefix: z.string().optional(),
    includeArchived: z.boolean(),
  })
  .describe("The scope these results cover; absence of a match is only within it.")

const DocGrepMatchSchema = z.looseObject({
  spaceId: PortableCanonicalIdSchema,
  docPath: z.string(),
  revision: z.string(),
  line: z
    .number()
    .int()
    .positive()
    .describe("1-based line number in the Doc's read content"),
  text: z.string(),
  before: z.array(z.string()),
  after: z.array(z.string()),
  lineTruncated: z
    .literal(true)
    .optional()
    .describe(
      "A returned line was too long and was cut; read the Doc at this line for the full text"
    ),
})

const DocGrepSkipSchema = z.looseObject({
  spaceId: PortableCanonicalIdSchema,
  docPath: z.string(),
  reason: z.enum(["unreadable", "conversion-failed"]),
})

const SearchResultSchema = z.looseObject({
  spaceId: PortableCanonicalIdSchema,
  type: z.enum(["doc", "record"]),
  path: z.string().optional(),
  title: z.string(),
  score: z.number(),
  documentKind: z.enum(["document", "conflict"]).optional(),
  documentView: z.enum(["doc", "html"]).optional(),
  format: DocumentFormatClaimSchema.optional(),
  health: DocumentHealthSchema.optional(),
  collectionId: PortableCanonicalIdSchema.optional(),
  recordId: PortableCanonicalIdSchema.optional(),
  excerpt: z.string().optional(),
  archiveOn: LifetimeOutputFields.archiveOn,
})

const SpaceIndexSchema = z.looseObject({
  spaceId: PortableCanonicalIdSchema,
  name: z.string(),
  description: z.string().optional(),
  generatedAt: z.string(),
  docCount: z.number().int().nonnegative(),
  groups: z.array(
    z.looseObject({
      folder: z.string(),
      label: z.string(),
      docs: z.array(
        z.looseObject({
          path: z.string(),
          title: z.string(),
          headings: z.array(z.string()),
          backlinkCount: z.number().int().nonnegative(),
        })
      ),
    })
  ),
})

const DocReadOutputSchema = z.looseObject({
  docPath: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]),
  totalLines: z.number().int().nonnegative().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().nonnegative().optional(),
  format: z.enum(["markdown", "blocknote"]),
  storedAs: z.enum(["md", "json"]),
  revision: z.string().optional(),
  archived: PortableArchiveInfoSchema.optional(),
  links: z.array(DocLinkSchema),
  backlinks: z.array(z.string()),
  ...LifetimeOutputFields,
  createdAt: z.string().optional(),
  headings: z.array(z.string()).optional(),
  blockCount: z.number().int().nonnegative().nullable().optional(),
  lossyFields: z.array(z.string()).optional(),
  readFormatHint: z.enum(["markdown", "blocknote"]).optional(),
  richBlockTypes: z.array(z.string()).optional(),
  containsMermaid: z.boolean().optional(),
  blockSummary: z.array(BlockSummarySchema).optional(),
  reason: z.string().optional(),
  urlToSendInChat: UrlToSendInChatSchema,
})

const DocWriteOutputSchema = z.looseObject({
  ok: z.literal(true),
  docPath: z.string(),
  storedAs: z.enum(["md", "json"]),
  ...LifetimeOutputFields,
  repairs: z.array(MermaidRepairSchema),
  warnings: z.array(GuidanceIssueSchema),
  urlToSendInChat: UrlToSendInChatSchema,
})

const PatchTargetSchema = z.looseObject({
  blockId: z.string().optional(),
  heading: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  search: z.string().optional(),
})

const DocPatchOutputSchema = DocWriteOutputSchema.extend({
  operationsApplied: z.number().int().nonnegative(),
  skipped: z.array(
    z.looseObject({
      index: z.number().int().nonnegative(),
      action: z.enum([
        "replace",
        "insert_after",
        "insert_before",
        "delete",
        "append",
      ]),
      reason: z.string(),
      target: PatchTargetSchema.optional(),
    })
  ),
  blockCount: z.number().int().nonnegative(),
  headings: z.array(z.string()),
})

const DocRenameOutputSchema = z.looseObject({
  ok: z.literal(true),
  oldPath: z.string(),
  newPath: z.string(),
  urlToSendInChat: UrlToSendInChatSchema,
})

const HtmlDocReadSchema = PortableHtmlDocSchema.extend(LifetimeOutputFields)

const HtmlDocListEntrySchema = HtmlDocReadSchema.meta({
  id: "HtmlDocListEntry",
})

const HtmlReadOutputSchema = z.looseObject({
  htmlDoc: HtmlDocReadSchema,
  html: z.string().optional(),
  warnings: z.array(HtmlValidationIssueSchema).optional(),
  urlToSendInChat: UrlToSendInChatSchema,
})

const HtmlWriteOutputSchema = z.looseObject({
  preview: DocumentPreviewResultSchema.optional(),
  htmlId: PortableHtmlIdSchema,
  htmlDoc: PortableHtmlDocSchema,
  warnings: z.array(HtmlValidationIssueSchema),
  ...LifetimeOutputFields,
  urlToSendInChat: UrlToSendInChatSchema,
})

const HtmlRenameOutputSchema = z.looseObject({
  htmlId: PortableHtmlIdSchema,
  htmlDoc: PortableHtmlDocSchema,
  urlToSendInChat: UrlToSendInChatSchema,
})

const HtmlMoveOutputSchema = z.looseObject({
  htmlId: PortableHtmlIdSchema,
  oldPath: PortableHtmlIdSchema,
  newPath: PortableHtmlIdSchema,
  urlToSendInChat: UrlToSendInChatSchema,
})

const HtmlArchiveOutputSchema = HtmlRenameOutputSchema.extend({
  ok: z.literal(true),
})

const RecordCollectionSummarySchema = z.looseObject({
  id: PortableCanonicalIdSchema,
  name: z.string(),
  description: z.string().optional(),
  count: z.number().int().nonnegative(),
  schema: PortableRecordCollectionSchema.optional(),
})

const RecordQueryOutputSchema = z.looseObject({
  records: z.array(PortableRecordSchema),
  expanded: z
    .record(z.string(), z.record(z.string(), PortableRecordSchema))
    .optional(),
  backlinks: z.record(z.string(), z.array(z.string())).optional(),
  groups: z.array(z.record(z.string(), z.unknown())).optional(),
  nextCursor: z.string().optional(),
  warnings: z.array(z.string()).optional(),
})

const PublicAnnotationTargetSchema = z.discriminatedUnion("type", [
  AnnotationTargetSchema.options[0].loose(),
  AnnotationTargetSchema.options[1].loose(),
  AnnotationTargetSchema.options[2].loose(),
  z.looseObject({ type: z.literal("html"), htmlId: PortableHtmlIdSchema }),
  AnnotationTargetSchema.options[4].loose(),
  AnnotationTargetSchema.options[5].loose(),
  AnnotationTargetSchema.options[6].loose(),
])

const PublicAnnotationSchema = AnnotationSchema.extend({
  target: PublicAnnotationTargetSchema,
  author: AnnotationAuthorSchema.loose(),
  thread: z.array(
    AnnotationMessageSchema.extend({
      author: AnnotationAuthorSchema.loose(),
    }).loose()
  ),
})
  .loose()
  .meta({ id: "Annotation" })

const AnnotationContextSchema = z.looseObject({
  targetExists: z.boolean(),
  selectorMatch: z.enum(["exact", "fuzzy", "stale", "missing"]),
  docPath: z.string().optional(),
  block: z.unknown().optional(),
  beforeBlocks: z.array(z.unknown()).optional(),
  afterBlocks: z.array(z.unknown()).optional(),
  excerpt: z.string().optional(),
})

const ThreadSummarySchema = z.looseObject({
  id: z.string(),
  version: z.literal(3),
  location: PortableThreadLocationSchema,
  spaceId: PortableCanonicalIdSchema.optional(),
  title: z.string(),
  members: z.array(ThreadMemberSchema.loose()),
  identities: z.array(ConversationIdentitySchema.loose()),
  revision: z.number().int().positive(),
  messageCount: z.number().int().positive(),
  lastMessage: PortableThreadMessageSchema,
  activity: PortableThreadActivitySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const ThreadWindowSchema = z.looseObject({
  id: z.string(),
  version: z.literal(3),
  location: PortableThreadLocationSchema,
  spaceId: PortableCanonicalIdSchema.optional(),
  title: z.string(),
  members: z.array(ThreadMemberSchema.loose()),
  identities: z.array(ConversationIdentitySchema.loose()),
  revision: z.number().int().positive(),
  messages: z.array(PortableThreadMessageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const ThreadReadOutputSchema = z.looseObject({
  location: PortableThreadLocationSchema,
  spaceId: PortableCanonicalIdSchema.optional(),
  thread: ThreadWindowSchema,
  messages: z.array(PortableThreadMessageSchema),
  cursor: z.number().int().nonnegative(),
  oldestCursor: z.number().int().nonnegative(),
  hasOlder: z.boolean(),
  hasNewer: z.boolean(),
  activities: z.array(PortableThreadActivitySchema),
  activity: PortableThreadActivitySchema.optional(),
  viewerMemberId: z.string(),
  viewerIdentityId: z.string().optional(),
  viewerParticipantId: z.string(),
})

const ThreadWaitOutputSchema = ThreadReadOutputSchema.extend({
  timedOut: z.boolean(),
})

const ThreadPostOutputSchema = z.looseObject({
  threadId: z.string(),
  location: PortableThreadLocationSchema,
  spaceId: PortableCanonicalIdSchema.optional(),
  messageId: z.string(),
  cursor: z.number().int().nonnegative(),
  createdThread: z.boolean(),
  activity: PortableThreadActivitySchema.optional(),
  replies: z.array(PortableThreadMessageSchema),
  timedOut: z.boolean(),
})

const ThreadMutationReceiptSchema = z.looseObject({
  threadId: z.string(),
  revision: z.number().int().positive(),
})

const ParticipantRegistrationOutputSchema = z.looseObject({
  participant: PortableParticipantSchema,
  defaultSpaceId: PortableCanonicalIdSchema.optional(),
  threadLocationVersion: z.literal(2).optional(),
})

const ClaimedDeliverySchema = z.looseObject({
  messageId: z.string(),
  threadId: z.string(),
  location: PortableThreadLocationSchema,
  spaceId: PortableCanonicalIdSchema.optional(),
  leaseId: z.string(),
  leaseExpiresAt: z.string(),
  attempt: z.number().int().positive(),
  identityId: z.string(),
  thread: z.union([
    PortableThreadSchema,
    z.looseObject({
      type: z.literal("worktable.thread"),
      version: z.literal(2),
      id: z.string(),
      location: PortableThreadLocationSchema,
      title: z.string(),
      participants: z.array(PortableParticipantSchema),
      revision: z.number().int().positive(),
      messages: z.array(PortableLegacyThreadMessageSchema),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ]),
  message: z.union([
    PortableThreadMessageSchema,
    PortableLegacyThreadMessageSchema,
  ]),
})

const MermaidValidationOutputSchema = z.looseObject({
  ok: z.boolean(),
  diagramType: z.string().nullable(),
  error: z.string().optional(),
})

const MermaidPreviewOutputSchema = MermaidValidationOutputSchema.extend({
  svg: z.string().optional(),
  viewBox: z.string().nullable().optional(),
  width: z.string().nullable().optional(),
  height: z.string().nullable().optional(),
})

export const PUBLIC_OPERATION_OUTPUT_VARIANTS = {
  "workspace.state": [WorkspaceOverviewSchema, SpaceDetailSchema],
  "workspace.search": [
    z.looseObject({
      results: z.array(SearchResultSchema),
      truncated: z.boolean(),
      scope: ListScopeSchema,
    }),
  ],
  "workspace.space_index": [z.looseObject({ index: SpaceIndexSchema })],
  "spaces.create": [z.looseObject({ spaceId: PortableCanonicalIdSchema })],
  "spaces.update": [
    z.looseObject({
      space: PortableSpaceFileSchema,
      startHere: z.array(ResolvedStartHerePinSchema),
    }),
  ],
  "spaces.archive": [
    z.looseObject({ ok: z.literal(true), space: PortableSpaceFileSchema }),
  ],
  "spaces.restore": [
    z.looseObject({ ok: z.literal(true), space: PortableSpaceFileSchema }),
  ],
  "documents.list": [
    z.looseObject({
      documents: z.array(PortableDocumentListItemSchema),
      total: z.number().int().nonnegative(),
      nextCursor: z.string().optional(),
      scope: ListScopeSchema,
    }),
  ],
  "documents.render": [DocumentRenderOutputSchema],
  "documents.read": [
    z.looseObject({ result: PortableDocumentReadResultSchema }),
  ],
  "documents.read_source": [
    z.looseObject({
      documentId: z.string(),
      path: z.string(),
      format: DocumentFormatClaimSchema,
      source: z.string(),
      encoding: z.literal("base64"),
      byteLength: z.number().int().nonnegative(),
      sourceRevision: z.string(),
    }),
  ],
  "documents.versions": [
    z.looseObject({
      versions: z.array(PortableDocumentVersionSummarySchema),
    }),
  ],
  "documents.diff": [
    z.looseObject({
      path: z.string(),
      from: z.string(),
      to: z.string(),
      unified: z.string(),
      stats: z.object({
        added: z.number().int().nonnegative(),
        removed: z.number().int().nonnegative(),
      }),
      truncated: z.boolean(),
    }),
  ],
  "documents.create": [
    GenericDocumentMutationOutputSchema.extend(LifetimeOutputFields),
  ],
  "documents.replace": [GenericDocumentMutationOutputSchema],
  "documents.checkpoint": [GenericDocumentMutationOutputSchema],
  "documents.restore_version": [GenericDocumentMutationOutputSchema],
  "documents.move": [
    GenericDocumentMutationOutputSchema.extend({
      from: z.string(),
      to: z.string(),
    }),
  ],
  "documents.archive": [
    GenericDocumentMutationOutputSchema.extend({ archived: z.literal(true) }),
  ],
  "documents.restore": [
    GenericDocumentMutationOutputSchema.extend({ archived: z.literal(false) }),
  ],
  "documents.delete": [GenericDocumentMutationOutputSchema],
  "documents.set_lifetime": [
    z.looseObject({
      ok: z.literal(true),
      path: z.string(),
      ...LifetimeOutputFields,
    }),
  ],
  "documents.set_folder_lifetime": [
    z.looseObject({
      ok: z.literal(true),
      lifetime: z.enum(["durable", "temporary"]),
      count: z.number().int().nonnegative(),
      paths: z.array(z.string()),
      unsupported: z.array(z.string()).optional(),
    }),
  ],
  "documents.move_folder": [
    z.looseObject({
      ok: z.literal(true),
      oldPath: z.string(),
      newPath: z.string(),
      count: z.number().int().positive(),
      renamed: z.array(z.looseObject({ from: z.string(), to: z.string() })),
    }),
  ],
  "documents.archive_folder": [
    z.looseObject({
      ok: z.literal(true),
      path: z.string(),
      archived: z.literal(true),
      count: z.number().int().positive(),
      paths: z.array(z.string()),
    }),
  ],
  "documents.restore_folder": [
    z.looseObject({
      ok: z.literal(true),
      path: z.string(),
      archived: z.literal(false),
      count: z.number().int().positive(),
      paths: z.array(z.string()),
    }),
  ],
  "documents.delete_folder": [
    z.looseObject({
      ok: z.literal(true),
      path: z.string(),
      count: z.number().int().positive(),
      paths: z.array(z.string()),
    }),
  ],
  "docs.list": [z.looseObject({ docs: z.array(DocListEntrySchema) })],
  "docs.read": [DocReadOutputSchema],
  "docs.grep": [
    z.looseObject({
      matches: z.array(DocGrepMatchSchema),
      total: z.number().int().nonnegative(),
      truncated: z.boolean(),
      skipped: z.array(DocGrepSkipSchema),
      scope: ListScopeSchema,
    }),
  ],
  "docs.write": [DocWriteOutputSchema],
  "docs.patch": [DocPatchOutputSchema],
  "docs.rename": [DocRenameOutputSchema],
  "docs.delete": [z.looseObject({ ok: z.literal(true), docPath: z.string() })],
  "drawings.inspect": [DrawingInspectOutputSchema],
  "drawings.query": [DrawingResultOutputSchema],
  "drawings.render": [DrawingResultOutputSchema],
  "drawings.changes": [DrawingResultOutputSchema],
  "drawings.create": [DrawingResultOutputSchema],
  "drawings.edit": [DrawingResultOutputSchema],
  "drawings.undo": [DrawingResultOutputSchema],
  "drawings.redo": [DrawingResultOutputSchema],
  "html.guide": [
    z.looseObject({
      profile: z.literal("runtime"),
      guide: z.string(),
      tokens: z.array(z.string()),
    }),
  ],
  "html.list": [z.looseObject({ htmlDocs: z.array(HtmlDocListEntrySchema) })],
  "html.render": [DocumentRenderOutputSchema],
  "html.read": [HtmlReadOutputSchema],
  "html.create": [HtmlWriteOutputSchema],
  "html.update": [HtmlWriteOutputSchema],
  "html.rename": [HtmlRenameOutputSchema],
  "html.move": [HtmlMoveOutputSchema],
  "html.archive": [HtmlArchiveOutputSchema],
  "html.restore": [HtmlArchiveOutputSchema],
  "html.delete": [
    z.looseObject({ ok: z.literal(true), htmlId: PortableHtmlIdSchema }),
  ],
  "records.list_collections": [
    z.looseObject({ collections: z.array(RecordCollectionSummarySchema) }),
  ],
  "records.query": [RecordQueryOutputSchema],
  "records.read": [z.looseObject({ record: PortableRecordSchema })],
  "records.upsert_collection": [
    z.looseObject({
      collection: PortableRecordCollectionSchema,
      warnings: z.array(RecordPracticeWarningSchema).optional(),
    }),
  ],
  "records.create": [
    z.looseObject({
      record: PortableRecordSchema,
      warnings: z.array(RecordPracticeWarningSchema).optional(),
    }),
  ],
  "records.update": [z.looseObject({ record: PortableRecordSchema })],
  "records.delete": [z.looseObject({ ok: z.literal(true) })],
  "annotations.list": [
    z.looseObject({
      annotations: z.array(PublicAnnotationSchema),
      total: z.number().int().nonnegative(),
      nextOffset: z.number().int().nonnegative().optional(),
    }),
  ],
  "annotations.read": [
    z.looseObject({
      annotation: PublicAnnotationSchema,
      context: AnnotationContextSchema.optional(),
    }),
  ],
  "annotations.context": [z.looseObject({ context: AnnotationContextSchema })],
  "annotations.create": [
    z.looseObject({
      ok: z.literal(true),
      annotationId: z.string(),
      annotation: PublicAnnotationSchema,
      created: z.boolean(),
    }),
  ],
  "annotations.reply": [
    z.looseObject({
      ok: z.literal(true),
      replyId: z.string(),
      annotation: PublicAnnotationSchema,
    }),
  ],
  "annotations.update": [
    z.looseObject({
      ok: z.literal(true),
      annotation: PublicAnnotationSchema,
    }),
  ],
  "annotations.resolve": [
    z.looseObject({
      ok: z.literal(true),
      annotation: PublicAnnotationSchema,
    }),
  ],
  "threads.participants": [
    z.looseObject({ participants: z.array(PortableParticipantSchema) }),
  ],
  "threads.list": [z.looseObject({ threads: z.array(ThreadSummarySchema) })],
  "threads.read": [ThreadReadOutputSchema],
  "threads.message": [z.looseObject({ message: PortableThreadMessageSchema })],
  "threads.wait": [ThreadWaitOutputSchema],
  "threads.post": [ThreadPostOutputSchema],
  "threads.assign_response": [
    ThreadMutationReceiptSchema.extend({
      messageId: z.string(),
      responseRequest: PortableThreadResponseRequestSchema.nullable(),
    }),
  ],
  "thread_delivery.register_participant": [ParticipantRegistrationOutputSchema],
  "thread_delivery.claim": [
    z.looseObject({ delivery: ClaimedDeliverySchema.nullable() }),
  ],
  "thread_delivery.accept": [
    z.looseObject({ activity: PortableThreadActivitySchema }),
  ],
  "thread_delivery.progress": [
    z.looseObject({ activity: PortableThreadActivitySchema }),
  ],
  "thread_delivery.fail": [
    z.looseObject({ activity: PortableThreadActivitySchema }),
  ],
  "guidance.format_spec": [z.looseObject({ spec: z.string() })],
  "guidance.drawings": [z.looseObject({ guide: z.string() })],
  "mermaid.validate": [MermaidValidationOutputSchema],
  "mermaid.preview": [MermaidPreviewOutputSchema],
} satisfies Record<OperationId, readonly OutputVariant[]>

const CompactSpaceSchema = z
  .looseObject({
    id: PortableCanonicalIdSchema,
    name: z.string(),
    description: z.string().optional(),
  })
  .meta({ id: "SpaceSummary" })

const CompactHtmlDocSchema = z
  .looseObject({
    id: PortableHtmlIdSchema,
    name: z.string(),
    description: z.string().optional(),
    archive: PortableArchiveInfoSchema.nullable().optional(),
    permissions: z
      .looseObject({
        network: z.boolean(),
        records: z.record(z.string(), z.looseObject({})),
        state: z.looseObject({
          read: z.boolean().optional(),
          write: z.boolean().optional(),
        }),
      })
      .optional(),
  })
  .meta({ id: "HtmlDocSummary" })

const CompactHtmlDocReadSchema = CompactHtmlDocSchema.extend(
  LifetimeOutputFields
).meta({ id: "HtmlDocReadSummary" })

const CompactRecordSchema = z
  .looseObject({
    id: PortableCanonicalIdSchema,
    collectionId: PortableCanonicalIdSchema,
    data: z.record(z.string(), z.unknown()),
    metadata: z.record(z.string(), z.unknown()).optional(),
    archive: PortableArchiveInfoSchema.nullable().optional(),
  })
  .meta({ id: "RecordSummary" })

const CompactCollectionSchema = z
  .looseObject({
    id: PortableCanonicalIdSchema,
    name: z.string(),
    description: z.string().optional(),
    count: z.number().int().nonnegative().optional(),
    fields: z
      .record(
        z.string(),
        z.looseObject({
          type: z.string(),
          name: z.string().optional(),
          required: z.boolean().optional(),
          description: z.string().optional(),
        })
      )
      .optional(),
  })
  .meta({ id: "RecordCollectionSummary" })

const CompactAnnotationSchema = z
  .looseObject({
    id: z.string(),
    target: z.looseObject({
      type: z.enum(["doc", "block", "text", "html", "view", "list", "space"]),
      docPath: z.string().optional(),
      blockId: z.string().optional(),
      htmlId: PortableHtmlIdSchema.optional(),
    }),
    category: z.enum(["comment", "instruction"]),
    status: z.enum(["open", "resolved"]),
    title: z.string().optional(),
    body: z.string(),
    labels: z.array(z.string()),
  })
  .meta({ id: "AnnotationSummary" })

const CompactParticipantSchema = z
  .looseObject({
    id: z.string(),
    kind: z.enum(["human", "agent", "system"]),
    name: z.string(),
    defaultIdentityId: z.string().optional(),
  })
  .meta({ id: "ParticipantSummary" })

const CompactMessageSchema = z
  .looseObject({
    id: z.string(),
    sequence: z.number().int().positive(),
    authorIdentityId: z.string(),
    authorMemberId: z.string(),
    notifyIdentityIds: z.array(z.string()),
    responseRequest: z
      .looseObject({
        identityId: z.string(),
        status: z.enum(["open", "responded", "withdrawn"]),
        respondedBy: z.string().optional(),
        resolvedAt: z.string().optional(),
      })
      .optional(),
    body: z.string(),
    inReplyTo: z.string().optional(),
    createdAt: z.string(),
  })
  .meta({ id: "ThreadMessageSummary" })

const CompactActivitySchema = z
  .looseObject({
    messageId: z.string(),
    participantId: z.string(),
    identityId: z.string().optional(),
    state: z.enum(["queued", "working", "receiving", "replied", "failed"]),
    revision: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    receivedCharacters: z.number().int().nonnegative().optional(),
    updatedAt: z.string(),
    error: z
      .looseObject({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
      })
      .optional(),
  })
  .meta({ id: "ThreadActivitySummary" })

const CompactThreadSchema = z
  .looseObject({
    id: z.string(),
    title: z.string(),
    location: PortableThreadLocationSchema.optional(),
    spaceId: PortableCanonicalIdSchema.optional(),
    members: z.array(ThreadMemberSchema.loose()),
    identities: z.array(ConversationIdentitySchema.loose()),
    messages: z.array(CompactMessageSchema).optional(),
    messageCount: z.number().int().nonnegative().optional(),
    lastMessage: CompactMessageSchema.optional(),
    activity: CompactActivitySchema.optional(),
  })
  .meta({ id: "ThreadSummary" })

const CompactClaimedDeliverySchema = z
  .looseObject({
    messageId: z.string(),
    threadId: z.string(),
    location: PortableThreadLocationSchema,
    leaseId: z.string(),
    leaseExpiresAt: z.string(),
    attempt: z.number().int().positive(),
    identityId: z.string(),
    thread: z.union([
      CompactThreadSchema,
      z.looseObject({
        id: z.string(),
        version: z.literal(2),
        location: PortableThreadLocationSchema,
        title: z.string(),
        participants: z.array(CompactParticipantSchema),
      }),
    ]),
    message: z.union([
      CompactMessageSchema,
      z.looseObject({
        id: z.string(),
        sequence: z.number().int().positive(),
        authorId: z.string(),
        recipientIds: z.array(z.string()),
        body: z.string(),
        inReplyTo: z.string().optional(),
        createdAt: z.string(),
      }),
    ]),
  })
  .meta({ id: "ClaimedThreadDelivery" })

function resultSchema(
  toolName: WorktableToolName,
  shape: z.ZodRawShape
): z.ZodObject {
  return z
    .looseObject(shape)
    .describe(
      `Structured result from ${toolName}. Fields vary by request.action.`
    )
}

function forActions<T extends z.ZodType>(
  schema: T,
  actions: string
): z.ZodOptional<T> {
  return schema.optional().describe(`Returned by action ${actions}.`)
}

export const WORKTABLE_OUTPUT_SCHEMAS = {
  worktable_discover: resultSchema("worktable_discover", {
    workspace: forActions(
      z.looseObject({ name: z.string(), mode: z.string() }),
      '"state" without a Space'
    ),
    spaces: forActions(z.array(CompactSpaceSchema), '"state" without a Space'),
    hint: forActions(z.string(), '"state" without a Space'),
    space: forActions(CompactSpaceSchema, '"state" with a Space'),
    startHere: forActions(
      z.array(ResolvedStartHerePinSchema),
      '"state" with a Space; pinned starting points to read first'
    ),
    docs: forActions(z.array(DocListEntrySchema), '"state" with a Space'),
    documents: forActions(
      z.array(PortableDocumentListItemSchema),
      '"state" with a Space and documents:read scope'
    ),
    results: forActions(z.array(SearchResultSchema), '"search"'),
    truncated: forActions(
      z.boolean(),
      '"search"; true when more matches exist than were returned'
    ),
    scope: forActions(ListScopeSchema, '"search"'),
    index: forActions(SpaceIndexSchema, '"space_index"'),
  }),
  worktable_spaces: resultSchema("worktable_spaces", {
    spaceId: forActions(PortableCanonicalIdSchema, '"create"'),
    ok: forActions(z.literal(true), '"archive" or "restore"'),
    space: forActions(PortableSpaceFileSchema, '"update", "archive", or "restore"'),
    startHere: forActions(z.array(ResolvedStartHerePinSchema), '"update"'),
  }),
  worktable_documents_read: resultSchema("worktable_documents_read", {
    preview: forActions(DocumentPreviewResultSchema, '"render"'),
    documents: forActions(z.array(PortableDocumentListItemSchema), '"list"'),
    total: forActions(z.number().int().nonnegative(), '"list"'),
    nextCursor: forActions(z.string(), '"list" when more documents match'),
    scope: forActions(ListScopeSchema, '"list"'),
    result: forActions(PortableDocumentReadResultSchema, '"read"'),
    documentId: forActions(z.string(), '"read_source"'),
    path: forActions(z.string(), '"read_source" or "diff"'),
    format: forActions(DocumentFormatClaimSchema, '"read_source"'),
    source: forActions(z.string(), '"read_source"'),
    encoding: forActions(z.literal("base64"), '"read_source"'),
    byteLength: forActions(z.number().int().nonnegative(), '"read_source"'),
    sourceRevision: forActions(z.string(), '"read_source"'),
    versions: forActions(
      z.array(PortableDocumentVersionSummarySchema),
      '"versions"'
    ),
    from: forActions(z.string(), '"diff"; the earlier point as requested'),
    to: forActions(
      z.string(),
      '"diff"; the later point, or the current sourceRevision by default'
    ),
    unified: forActions(
      z.string(),
      '"diff"; unified line diff of the readable text, empty when unchanged'
    ),
    stats: forActions(
      z.object({
        added: z.number().int().nonnegative(),
        removed: z.number().int().nonnegative(),
      }),
      '"diff"; changed line counts for the whole diff'
    ),
    truncated: forActions(
      z.boolean(),
      '"diff"; true when unified stops before the end of the diff'
    ),
  }),
  worktable_documents_write: resultSchema("worktable_documents_write", {
    ok: z.literal(true),
    documentId: forActions(
      z.string(),
      '"create", "replace", "checkpoint", "restore_version", "move", "archive", or "restore"'
    ),
    format: forActions(
      DocumentFormatClaimSchema,
      '"create", "replace", "checkpoint", or "restore_version"'
    ),
    sourceRevision: forActions(
      z.string(),
      '"create", "replace", "checkpoint", "restore_version", or "move"'
    ),
    versionId: forActions(
      z.string(),
      '"create", "replace", "checkpoint", or "restore_version"'
    ),
    from: forActions(z.string(), '"move"'),
    to: forActions(z.string(), '"move"'),
    oldPath: forActions(z.string(), '"move_folder"'),
    newPath: forActions(z.string(), '"move_folder"'),
    path: forActions(
      z.string(),
      '"create", "replace", "checkpoint", "restore_version", "archive", "restore", "archive_folder", or "restore_folder"'
    ),
    archived: forActions(
      z.boolean(),
      '"archive", "restore", "archive_folder", or "restore_folder"'
    ),
    count: forActions(
      z.number().int().nonnegative(),
      '"move_folder", "archive_folder", "restore_folder", or "set_folder_lifetime"'
    ),
    renamed: forActions(
      z.array(
        z.looseObject({
          from: z.string(),
          to: z.string(),
        })
      ),
      '"move_folder"'
    ),
    paths: forActions(
      z.array(z.string()),
      '"archive_folder", "restore_folder", or "set_folder_lifetime"'
    ),
    lifetime: forActions(
      z.enum(["durable", "temporary"]),
      '"create", "set_lifetime", or "set_folder_lifetime"'
    ),
    archiveOn: forActions(
      z.string(),
      '"create" or "set_lifetime" for temporary documents'
    ),
    unsupported: forActions(
      z.array(z.string()),
      '"set_folder_lifetime" when some documents cannot record a lifetime'
    ),
  }),
  worktable_docs_read: resultSchema("worktable_docs_read", {
    docs: forActions(z.array(DocListEntrySchema), '"list"'),
    docPath: forActions(z.string(), '"read"'),
    content: forActions(z.union([z.string(), z.array(z.unknown())]), '"read"'),
    revision: forActions(
      z.string(),
      '"read"; changes whenever the stored Doc changes'
    ),
    totalLines: forActions(
      z.number().int().nonnegative(),
      '"read" when content is Markdown'
    ),
    startLine: forActions(
      z.number().int().positive(),
      '"read" with offset or limit; first line in content'
    ),
    endLine: forActions(
      z.number().int().nonnegative(),
      '"read" with offset or limit; last line in content'
    ),
    matches: forActions(z.array(DocGrepMatchSchema), '"grep"'),
    total: forActions(
      z.number().int().nonnegative(),
      '"grep"; every matching line in scope'
    ),
    truncated: forActions(
      z.boolean(),
      '"grep"; true when more lines matched than were returned, because of maxResults or the response size limit'
    ),
    skipped: forActions(
      z.array(DocGrepSkipSchema),
      '"grep"; Docs in scope that could not be searched, so a match there would be missing'
    ),
    scope: forActions(ListScopeSchema, '"grep"'),
    format: forActions(z.enum(["markdown", "blocknote"]), '"read"'),
    storedAs: forActions(z.enum(["md", "json"]), '"read"'),
    archived: forActions(PortableArchiveInfoSchema, '"read"'),
    links: forActions(z.array(DocLinkSchema), '"read"'),
    backlinks: forActions(z.array(z.string()), '"read"'),
    lifetime: forActions(
      z.enum(["durable", "temporary"]),
      '"read" for active documents'
    ),
    archiveOn: forActions(z.string(), '"read" for temporary documents'),
    createdAt: forActions(
      z.string(),
      '"read" when the document was created through Worktable'
    ),
    headings: forActions(z.array(z.string()), '"read"'),
    blockCount: forActions(z.number().int().nonnegative().nullable(), '"read"'),
    readFormatHint: forActions(z.enum(["markdown", "blocknote"]), '"read"'),
    reason: forActions(z.string(), '"read"'),
    urlToSendInChat: forActions(UrlToSendInChatSchema, '"read"'),
  }),
  worktable_docs_write: resultSchema("worktable_docs_write", {
    ok: z.literal(true),
    docPath: forActions(z.string(), '"write" or "patch"'),
    oldPath: forActions(z.string(), '"rename"'),
    newPath: forActions(z.string(), '"rename"'),
    storedAs: forActions(z.enum(["md", "json"]), '"write" or "patch"'),
    repairs: forActions(z.array(MermaidRepairSchema), '"write" or "patch"'),
    warnings: forActions(z.array(GuidanceIssueSchema), '"write" or "patch"'),
    operationsApplied: forActions(z.number().int().nonnegative(), '"patch"'),
    skipped: forActions(
      z.array(z.looseObject({ index: z.number(), reason: z.string() })),
      '"patch"'
    ),
    blockCount: forActions(z.number().int().nonnegative(), '"patch"'),
    headings: forActions(z.array(z.string()), '"patch"'),
    lifetime: forActions(
      z.enum(["durable", "temporary"]),
      '"write" when creating a Doc or changing its lifetime'
    ),
    archiveOn: forActions(z.string(), '"write" for temporary Docs'),
    urlToSendInChat: UrlToSendInChatSchema,
  }),
  worktable_drawings_read: DrawingResultOutputSchema.extend({
    lifetime: forActions(
      z.enum(["durable", "temporary"]),
      '"inspect" for active drawings'
    ),
    archiveOn: forActions(z.string(), '"inspect" for temporary drawings'),
    createdAt: forActions(
      z.string(),
      '"inspect" when the drawing was created through Worktable'
    ),
  }),
  worktable_drawings_write: DrawingResultOutputSchema.extend({
    lifetime: forActions(z.enum(["durable", "temporary"]), '"create"'),
    archiveOn: forActions(z.string(), '"create" for temporary drawings'),
  }),
  worktable_html_read: resultSchema("worktable_html_read", {
    preview: forActions(DocumentPreviewResultSchema, '"render"'),
    path: forActions(z.string(), '"render"'),
    documentId: forActions(z.string(), '"render"'),
    sourceRevision: forActions(z.string(), '"render"'),
    profile: forActions(z.literal("runtime"), '"guide"'),
    guide: forActions(z.string(), '"guide"'),
    tokens: forActions(z.array(z.string()), '"guide"'),
    htmlDocs: forActions(z.array(CompactHtmlDocReadSchema), '"list"'),
    htmlDoc: forActions(CompactHtmlDocReadSchema, '"read"'),
    html: forActions(z.string(), '"read" when source is requested'),
    warnings: forActions(z.array(HtmlValidationIssueSchema), '"read"'),
    urlToSendInChat: forActions(UrlToSendInChatSchema, '"read"'),
  }),
  worktable_html_write: resultSchema("worktable_html_write", {
    preview: forActions(
      DocumentPreviewResultSchema,
      '"create" or "update" when requested'
    ),
    htmlId: PortableHtmlIdSchema,
    htmlDoc: forActions(
      CompactHtmlDocSchema,
      '"create", "update", "rename", "archive", or "restore"'
    ),
    oldPath: forActions(PortableHtmlIdSchema, '"move"'),
    newPath: forActions(PortableHtmlIdSchema, '"move"'),
    warnings: forActions(
      z.array(HtmlValidationIssueSchema),
      '"create" or "update"'
    ),
    lifetime: forActions(z.enum(["durable", "temporary"]), '"create"'),
    archiveOn: forActions(z.string(), '"create" for temporary HTML docs'),
    ok: forActions(z.literal(true), '"archive" or "restore"'),
    urlToSendInChat: UrlToSendInChatSchema,
  }),
  worktable_records_read: resultSchema("worktable_records_read", {
    collections: forActions(
      z.array(CompactCollectionSchema),
      '"list_collections"'
    ),
    records: forActions(z.array(CompactRecordSchema), '"query"'),
    expanded: forActions(
      z.record(z.string(), z.record(z.string(), CompactRecordSchema)),
      '"query"'
    ),
    backlinks: forActions(z.record(z.string(), z.array(z.string())), '"query"'),
    groups: forActions(z.array(z.record(z.string(), z.unknown())), '"query"'),
    nextCursor: forActions(z.string(), '"query"'),
    warnings: forActions(z.array(z.string()), '"query"'),
    record: forActions(CompactRecordSchema, '"read"'),
  }),
  worktable_records_write: resultSchema("worktable_records_write", {
    collection: forActions(CompactCollectionSchema, '"upsert_collection"'),
    record: forActions(CompactRecordSchema, '"create" or "update"'),
    warnings: forActions(
      z.array(RecordPracticeWarningSchema),
      '"upsert_collection" or "create"'
    ),
  }),
  worktable_annotations_read: resultSchema("worktable_annotations_read", {
    annotations: forActions(z.array(CompactAnnotationSchema), '"list"'),
    total: forActions(z.number().int().nonnegative(), '"list"'),
    nextOffset: forActions(z.number().int().nonnegative(), '"list"'),
    annotation: forActions(CompactAnnotationSchema, '"read"'),
    context: forActions(AnnotationContextSchema, '"read" or "context"'),
  }),
  worktable_annotations_write: resultSchema("worktable_annotations_write", {
    ok: z.literal(true),
    annotation: CompactAnnotationSchema,
    annotationId: forActions(z.string(), '"create"'),
    replyId: forActions(z.string(), '"reply"'),
    created: forActions(z.boolean(), '"create"'),
  }),
  worktable_threads_read: resultSchema("worktable_threads_read", {
    participants: forActions(
      z.array(CompactParticipantSchema),
      '"participants"'
    ),
    threads: forActions(z.array(CompactThreadSchema), '"list"'),
    location: forActions(PortableThreadLocationSchema, '"read" or "wait"'),
    spaceId: forActions(
      PortableCanonicalIdSchema,
      '"read" or "wait" for legacy Space threads'
    ),
    thread: forActions(CompactThreadSchema, '"read" or "wait"'),
    message: forActions(CompactMessageSchema, '"message"'),
    messages: forActions(z.array(CompactMessageSchema), '"read" or "wait"'),
    cursor: forActions(z.number().int().nonnegative(), '"read" or "wait"'),
    oldestCursor: forActions(
      z.number().int().nonnegative(),
      '"read" or "wait"'
    ),
    hasOlder: forActions(z.boolean(), '"read" or "wait"'),
    hasNewer: forActions(z.boolean(), '"read" or "wait"'),
    activities: forActions(z.array(CompactActivitySchema), '"read" or "wait"'),
    activity: forActions(CompactActivitySchema, '"read" or "wait"'),
    viewerMemberId: forActions(z.string(), '"read" or "wait"'),
    viewerParticipantId: forActions(z.string(), '"read" or "wait"'),
    timedOut: forActions(z.boolean(), '"wait"'),
  }),
  worktable_threads_write: resultSchema("worktable_threads_write", {
    threadId: forActions(z.string(), '"post" or "assign_response"'),
    location: forActions(PortableThreadLocationSchema, '"post"'),
    spaceId: forActions(
      PortableCanonicalIdSchema,
      '"post" for legacy Space threads'
    ),
    messageId: forActions(z.string(), '"post" or "assign_response"'),
    cursor: forActions(z.number().int().nonnegative(), '"post"'),
    createdThread: forActions(z.boolean(), '"post"'),
    activity: forActions(CompactActivitySchema, '"post"'),
    replies: forActions(z.array(CompactMessageSchema), '"post"'),
    timedOut: forActions(z.boolean(), '"post"'),
    revision: forActions(z.number().int().positive(), '"assign_response"'),
    responseRequest: forActions(
      PortableThreadResponseRequestSchema.nullable(),
      '"assign_response"'
    ),
  }),
  worktable_thread_delivery: resultSchema("worktable_thread_delivery", {
    participant: forActions(CompactParticipantSchema, '"register_participant"'),
    defaultSpaceId: forActions(
      PortableCanonicalIdSchema,
      '"register_participant"'
    ),
    threadLocationVersion: forActions(z.literal(2), '"register_participant"'),
    delivery: forActions(CompactClaimedDeliverySchema.nullable(), '"claim"'),
    activity: forActions(
      CompactActivitySchema,
      '"accept", "progress", or "fail"'
    ),
  }),
  worktable_delete: resultSchema("worktable_delete", {
    ok: z.literal(true),
    documentId: forActions(z.string(), '"document"'),
    docPath: forActions(z.string(), '"doc"'),
    htmlId: forActions(PortableHtmlIdSchema, '"html"'),
    path: forActions(z.string(), '"document" or "document_folder"'),
    count: forActions(z.number().int().positive(), '"document_folder"'),
    paths: forActions(z.array(z.string()), '"document_folder"'),
  }),
  worktable_guidance: resultSchema("worktable_guidance", {
    spec: forActions(z.string(), '"format_spec"'),
    guide: forActions(z.string(), '"drawings"'),
  }),
  worktable_mermaid: resultSchema("worktable_mermaid", {
    ok: z.boolean(),
    diagramType: z.string().nullable(),
    error: forActions(z.string(), '"validate" or "preview" when invalid'),
    svg: forActions(z.string(), '"preview" when valid'),
    viewBox: forActions(z.string().nullable(), '"preview" when valid'),
    width: forActions(z.string().nullable(), '"preview" when valid'),
    height: forActions(z.string().nullable(), '"preview" when valid'),
  }),
} satisfies Record<WorktableToolName, z.ZodObject>

export class PublicOperationOutputError extends Error {
  readonly operationId: OperationId
  readonly issuePaths: string[]

  constructor(operationId: OperationId, issuePaths: string[]) {
    super(
      `Invalid public MCP output for ${operationId}: ${issuePaths.join(", ")}`
    )
    this.name = "PublicOperationOutputError"
    this.operationId = operationId
    this.issuePaths = issuePaths
  }
}

export function assertPublicOperationOutput(
  operationId: OperationId,
  result: unknown
): asserts result is Record<string, unknown> {
  const attempts = PUBLIC_OPERATION_OUTPUT_VARIANTS[operationId].map((schema) =>
    schema.safeParse(result)
  )
  if (attempts.some((attempt) => attempt.success)) return

  const closest = attempts
    .filter((attempt) => !attempt.success)
    .sort(
      (left, right) => left.error.issues.length - right.error.issues.length
    )[0]
  const issuePaths = closest
    ? closest.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "<root>"
        return `${path}:${issue.code}`
      })
    : ["<root>:invalid_type"]
  throw new PublicOperationOutputError(operationId, issuePaths)
}
