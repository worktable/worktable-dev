import { z } from "zod"

export const DOCUMENT_DELETE_ADAPTER_IDS = {
  legacyDoc: "legacy-doc-v1",
  legacyHtml: "legacy-html-v1",
} as const

export const DocumentDeleteAdapterIdSchema = z.enum([
  DOCUMENT_DELETE_ADAPTER_IDS.legacyDoc,
  DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml,
])

export type DocumentDeleteAdapterId = z.infer<
  typeof DocumentDeleteAdapterIdSchema
>
