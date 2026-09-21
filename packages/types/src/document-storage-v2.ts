import { z } from "zod"
import {
  DocumentFormatClaimSchema,
  DocumentIdSchema,
  DocumentProvenanceSchema,
} from "./documents"
import { AnnotationSchema } from "./annotations"

export const DocumentStorageSha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const DocumentCompanionKeySchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)

export const DOCUMENT_GENERATION_MAX_ENTRIES = 10_000
export const DOCUMENT_GENERATION_MAX_ENTRY_BYTES = 64 * 1024 * 1024
export const DOCUMENT_GENERATION_MAX_TOTAL_BYTES = 512 * 1024 * 1024
export const DOCUMENT_GENERATION_MAX_PATH_BYTES = 1024

const WINDOWS_RESERVED_SEGMENT =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const WINDOWS_INVALID_SEGMENT_CHARACTER = /[<>:"|?*]/

/** Deterministic Unicode code-point order for portable storage identities. */
export function compareDocumentStorageText(
  left: string,
  right: string
): number {
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex)!
    const rightCodePoint = right.codePointAt(rightIndex)!
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1
    }
    leftIndex += leftCodePoint > 0xffff ? 2 : 1
    rightIndex += rightCodePoint > 0xffff ? 2 : 1
  }
  if (leftIndex === left.length && rightIndex === right.length) return 0
  return leftIndex === left.length ? -1 : 1
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function portableEntryPath(path: string): boolean {
  if (
    path.length === 0 ||
    new TextEncoder().encode(path).byteLength >
      DOCUMENT_GENERATION_MAX_PATH_BYTES ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.normalize("NFC") !== path ||
    !wellFormedUnicode(path)
  ) {
    return false
  }
  const segments = path.split("/")
  return (
    segments.length <= 32 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("\0") &&
        new TextEncoder().encode(segment).byteLength <= 255 &&
        !WINDOWS_RESERVED_SEGMENT.test(segment) &&
        !WINDOWS_INVALID_SEGMENT_CHARACTER.test(segment) &&
        !/[. ]$/.test(segment) &&
        ![...segment].some((character) => character.charCodeAt(0) < 32)
    )
  )
}

export const DocumentGenerationIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine(
    (value) => portableEntryPath(value) && !value.includes("/"),
    "invalid portable document generation ID"
  )

/** A normalized file captured inside an exact authored generation. */
export const DocumentGenerationEntrySchema = z.object({
  path: z.string().refine(portableEntryPath, "invalid generation entry path"),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(DOCUMENT_GENERATION_MAX_ENTRY_BYTES)
    .safe(),
  sha256: DocumentStorageSha256Schema,
})

const DocumentGenerationEntriesSchema = z
  .array(DocumentGenerationEntrySchema)
  .min(1)
  .max(DOCUMENT_GENERATION_MAX_ENTRIES)
  .superRefine((entries, context) => {
    const paths = entries
      .map((entry, index) => ({
        index,
        path: entry.path.toLocaleLowerCase("en-US"),
      }))
      .sort((left, right) =>
        compareDocumentStorageText(left.path, right.path)
      )
    const seen = new Set<string>()
    for (const entry of paths) {
      if (seen.has(entry.path)) {
        context.addIssue({
          code: "custom",
          path: [entry.index, "path"],
          message: "duplicate or case-colliding generation entry path",
        })
        continue
      }
      const segments = entry.path.split("/")
      let prefix = ""
      for (let index = 0; index < segments.length - 1; index += 1) {
        prefix = prefix ? `${prefix}/${segments[index]}` : segments[index]!
        if (seen.has(prefix)) {
          context.addIssue({
            code: "custom",
            path: [entry.index, "path"],
            message: "generation entry paths overlap as file and directory",
          })
          break
        }
      }
      seen.add(entry.path)
    }
  })

export const DocumentGenerationSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    entries: DocumentGenerationEntriesSchema.length(1),
  }),
  z.object({
    kind: z.literal("bundle"),
    entries: DocumentGenerationEntriesSchema,
  }),
])

export const DocumentGenerationCompanionSchema = z.object({
  key: DocumentCompanionKeySchema,
  entries: DocumentGenerationEntriesSchema,
})

export const DocumentSourceCategorySchema = z.enum([
  "human",
  "agent",
  "external",
  "system",
  "restore",
])

export const DocumentVersionCheckpointV2Schema = z.object({
  meaningful: z.boolean(),
  kind: z.enum(["manual", "source-transition", "restore", "system", "review"]),
  label: z.string().max(200).optional(),
  sourceCategory: DocumentSourceCategorySchema.optional(),
  transition: z
    .object({
      from: DocumentSourceCategorySchema,
      to: DocumentSourceCategorySchema,
    })
    .optional(),
})

/**
 * Portable manifest for one exact authored generation. Content bytes live
 * beside this manifest under source/ and companions/.
 */
export const DocumentGenerationManifestV2Schema = z
  .object({
    type: z.literal("worktable.document-generation"),
    version: z.literal(2),
    id: DocumentGenerationIdSchema,
    spaceId: z.string().min(1).max(128),
    documentId: DocumentIdSchema,
    logicalPath: z.string().min(1).max(4096),
    format: DocumentFormatClaimSchema,
    operation: z.enum(["create", "update", "checkpoint"]),
    createdAt: z.string().datetime(),
    createdBy: z.string().min(1).max(512),
    source: z.string().min(1).max(512),
    reason: z.string().max(500).optional(),
    provenance: DocumentProvenanceSchema.optional(),
    checkpoint: DocumentVersionCheckpointV2Schema.optional(),
    authoredSource: DocumentGenerationSourceSchema,
    companions: z
      .array(DocumentGenerationCompanionSchema)
      .max(DOCUMENT_GENERATION_MAX_ENTRIES),
    totalBytes: z
      .number()
      .int()
      .nonnegative()
      .max(DOCUMENT_GENERATION_MAX_TOTAL_BYTES)
      .safe(),
    contentHash: DocumentStorageSha256Schema,
  })
  .superRefine((manifest, context) => {
    const companionKeys = new Set<string>()
    for (const [index, companion] of manifest.companions.entries()) {
      if (companionKeys.has(companion.key)) {
        context.addIssue({
          code: "custom",
          path: ["companions", index, "key"],
          message: "duplicate document companion namespace",
        })
      }
      companionKeys.add(companion.key)
    }
    const entries = [
      ...manifest.authoredSource.entries,
      ...manifest.companions.flatMap((companion) => companion.entries),
    ]
    if (entries.length > DOCUMENT_GENERATION_MAX_ENTRIES) {
      context.addIssue({
        code: "custom",
        path: ["authoredSource", "entries"],
        message: "document generation exceeds its total entry limit",
      })
    }
    const declaredBytes = entries.reduce(
      (total, entry) => total + entry.bytes,
      0
    )
    if (declaredBytes !== manifest.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["totalBytes"],
        message: "document generation byte total does not match its entries",
      })
    }
  })

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
)

/**
 * Open, versioned format-owned anchor. Unknown selector fields and data are
 * deliberately retained so a container-compatible build can carry them
 * without understanding them.
 */
export const DocumentAnnotationSelectorSchema = z
  .object({
    type: DocumentCompanionKeySchema,
    version: z.number().int().positive(),
    data: JsonValueSchema,
  })
  .passthrough()

/** Durable-id owner plus a portable path index for document annotations. */
export const DocumentAnnotationTargetV2Schema = z
  .object({
    type: z.literal("document"),
    documentId: DocumentIdSchema,
    path: z.string().min(1).max(4096),
    selector: DocumentAnnotationSelectorSchema.optional(),
  })
  .passthrough()

export const DocumentAnnotationV2Schema = AnnotationSchema.omit({
  target: true,
})
  .extend({
    target: DocumentAnnotationTargetV2Schema,
  })
  .passthrough()

export const DocumentAnnotationFileV2Schema = z
  .object({
    type: z.literal("worktable.document-annotations"),
    version: z.literal(2),
    spaceId: z.string().min(1).max(128),
    documentId: DocumentIdSchema,
    logicalPath: z.string().min(1).max(4096),
    revision: DocumentStorageSha256Schema,
    updatedAt: z.string().datetime(),
    annotations: z.array(DocumentAnnotationV2Schema),
  })
  .passthrough()

export const DocumentPortableStateManifestV2Schema = z
  .object({
    type: z.literal("worktable.document-state"),
    version: z.literal(2),
    spaceId: z.string().min(1).max(128),
    documentId: DocumentIdSchema,
    logicalPath: z.string().min(1).max(4096),
    format: DocumentFormatClaimSchema,
    stateVersion: z.number().int().positive(),
    updatedAt: z.string().datetime(),
    revision: DocumentStorageSha256Schema,
    entries: DocumentGenerationEntriesSchema,
    totalBytes: z
      .number()
      .int()
      .nonnegative()
      .max(DOCUMENT_GENERATION_MAX_TOTAL_BYTES)
      .safe(),
  })
  .superRefine((manifest, context) => {
    const declaredBytes = manifest.entries.reduce(
      (total, entry) => total + entry.bytes,
      0
    )
    if (declaredBytes !== manifest.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["totalBytes"],
        message: "document state byte total does not match its entries",
      })
    }
  })

export const DocumentPortableStatePointerV2Schema = z.object({
  type: z.literal("worktable.document-state-pointer"),
  version: z.literal(2),
  revision: DocumentStorageSha256Schema,
})

export type DocumentGenerationEntry = z.infer<
  typeof DocumentGenerationEntrySchema
>
export type DocumentGenerationSource = z.infer<
  typeof DocumentGenerationSourceSchema
>
export type DocumentGenerationCompanion = z.infer<
  typeof DocumentGenerationCompanionSchema
>
export type DocumentGenerationManifestV2 = z.infer<
  typeof DocumentGenerationManifestV2Schema
>
export type DocumentAnnotationSelector = z.infer<
  typeof DocumentAnnotationSelectorSchema
>
export type DocumentAnnotationTargetV2 = z.infer<
  typeof DocumentAnnotationTargetV2Schema
>
export type DocumentAnnotationV2 = z.infer<typeof DocumentAnnotationV2Schema>
export type DocumentAnnotationFileV2 = z.infer<
  typeof DocumentAnnotationFileV2Schema
>
export type DocumentPortableStateManifestV2 = z.infer<
  typeof DocumentPortableStateManifestV2Schema
>
export type DocumentPortableStatePointerV2 = z.infer<
  typeof DocumentPortableStatePointerV2Schema
>
