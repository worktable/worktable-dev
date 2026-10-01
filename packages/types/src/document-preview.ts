import { z } from "zod"

export const MAX_DOCUMENT_PREVIEW_BYTES = 4 * 1024 * 1024
export const MAX_DOCUMENT_PREVIEW_PIXELS = 4 * 1024 * 1024

/** CSS-pixel capture controls. Drawing world-coordinate crops remain drawing options. */
export const DocumentPreviewOptionsSchema = z.strictObject({
  theme: z.enum(["light", "dark"]).optional(),
  width: z.number().int().min(128).max(2048).optional(),
  height: z.number().int().min(128).max(2048).optional(),
  fullPage: z.boolean().optional(),
  clip: z
    .strictObject({
      x: z.number().finite().min(0).max(100_000),
      y: z.number().finite().min(0).max(100_000),
      width: z.number().int().min(1).max(2048),
      height: z.number().int().min(1).max(2048),
    })
    .optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(30_000)
    .optional()
    .describe(
      "Maximum capture time, subject to the preview worker's overall startup and queue deadline."
    ),
})
export type DocumentPreviewOptions = z.infer<
  typeof DocumentPreviewOptionsSchema
>

export const DocumentPreviewResultSchema = z.looseObject({
  status: z.enum(["ready", "partial", "failed", "unavailable"]),
  kind: z.enum(["saved", "proposal"]),
  sourceRevision: z.string().nullable(),
  contentHash: z.string().optional(),
  mimeType: z.enum(["image/png", "image/svg+xml"]).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  contentBlockIndex: z.number().int().nonnegative().optional(),
  rendererVersion: z.string().optional(),
  fontVersion: z.string().optional(),
  capturedAt: z.string().optional(),
  theme: z.enum(["light", "dark"]).optional(),
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
  fullPage: z.boolean().optional(),
  clip: DocumentPreviewOptionsSchema.shape.clip,
  warnings: z.array(z.string()).optional(),
  diagnostics: z
    .array(
      z.object({
        level: z.enum(["warning", "error", "info"]),
        code: z.string(),
        message: z.string(),
      })
    )
    .optional(),
  stateFingerprint: z.string().optional(),
  dataMode: z.enum(["live-read-only", "static-history"]).optional(),
  observedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  retry: z.string().optional(),
})
export type DocumentPreviewResult = z.infer<typeof DocumentPreviewResultSchema>
