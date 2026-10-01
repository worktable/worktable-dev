import { createHash } from "node:crypto"
import {
  DocumentPreviewOptionsSchema,
  MAX_DOCUMENT_PREVIEW_BYTES,
  QuickdrawDocumentSchema,
  type DocumentPreviewOptions,
} from "@worktable/types"
import { readRegisteredDocumentSource } from "./document-write-service.ts"
import { renderDrawing } from "./drawing-render.ts"
import { withResultMedia } from "./mcp/media.ts"
import { hasScope } from "./token-store.ts"
import {
  captureHtmlPreview,
  freezeHtmlPreviewSnapshot,
  type HtmlPreviewSnapshot,
} from "./html-preview.ts"

export function previewFailure(sourceRevision: string | null, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined
  return {
    status:
      code === "PREVIEW_UNAVAILABLE"
        ? ("unavailable" as const)
        : ("failed" as const),
    kind: "saved" as const,
    sourceRevision,
    error: message,
    retry:
      "Retry the read render action. A successful write remains saved; do not repeat the mutation to retry its preview.",
  }
}

export async function renderFrozenHtmlPreview(
  snapshot: HtmlPreviewSnapshot,
  scopes: string[],
  options: DocumentPreviewOptions = {},
  signal?: AbortSignal
) {
  const base = {
    documentId: snapshot.documentId,
    path: snapshot.path,
    sourceRevision: snapshot.sourceRevision,
  }
  try {
    if (
      !hasScope(scopes, "documents:read") &&
      !hasScope(scopes, "widgets:read")
    )
      throw new Error("HTML preview requires document read authority.")
    const capture = await captureHtmlPreview({
      snapshot,
      scopes,
      signal,
      options: {
        ...options,
        theme: options.theme ?? "light",
        width: options.width ?? 1200,
        height: options.height ?? 800,
      },
    })
    const { bytes, ...metadata } = capture
    if (bytes.byteLength > MAX_DOCUMENT_PREVIEW_BYTES)
      throw new Error(
        "Preview exceeds the image response budget; request a smaller viewport or crop."
      )
    const contentHash = createHash("sha256").update(bytes).digest("hex")
    return withResultMedia(
      {
        ...base,
        preview: {
          ...metadata,
          status:
            capture.status === "complete"
              ? ("ready" as const)
              : ("partial" as const),
          kind: "saved" as const,
          sourceRevision: snapshot.sourceRevision,
          contentHash,
          contentBlockIndex: 1,
          theme: options.theme ?? "light",
          viewport: {
            width: options.width ?? 1200,
            height: options.height ?? 800,
          },
          fullPage: options.fullPage ?? false,
          ...(options.clip ? { clip: options.clip } : {}),
          capturedAt: capture.completedAt,
        },
      },
      [
        {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from(bytes).toString("base64"),
        },
      ]
    )
  } catch (error) {
    return { ...base, preview: previewFailure(snapshot.sourceRevision, error) }
  }
}

export async function renderDocumentPreview(input: {
  spaceId: string
  path: string
  expectedRevision?: string
  preview?: DocumentPreviewOptions
  scopes: string[]
  signal?: AbortSignal
  /** HTML convenience entry preserves its own widgets:read scope. */
  html?: boolean
}) {
  const scope = input.html ? "widgets:read" : "documents:read"
  if (!hasScope(input.scopes, scope))
    throw new Error(`Document preview requires ${scope}.`)
  const options = DocumentPreviewOptionsSchema.parse(input.preview ?? {})
  if (input.html) {
    const snapshot = await freezeHtmlPreviewSnapshot(input)
    return renderFrozenHtmlPreview(
      snapshot,
      input.scopes,
      options,
      input.signal
    )
  }
  const source = await readRegisteredDocumentSource(input)
  if (
    input.expectedRevision &&
    input.expectedRevision !== source.sourceRevision
  )
    throw Object.assign(
      new Error(
        "Document changed; read the current revision before rendering."
      ),
      { code: "REVISION_CONFLICT" }
    )
  if (source.format.id === "worktable.html") {
    // The second read is revision-fenced. It cannot silently show another edit.
    const snapshot = await freezeHtmlPreviewSnapshot({
      ...input,
      expectedRevision: source.sourceRevision,
    })
    return renderFrozenHtmlPreview(
      snapshot,
      input.scopes,
      options,
      input.signal
    )
  }
  const base = {
    documentId: source.documentId,
    path: source.path,
    sourceRevision: source.sourceRevision,
  }
  if (source.format.id !== "worktable.quickdraw")
    return {
      ...base,
      preview: {
        status: "unavailable" as const,
        kind: "saved" as const,
        sourceRevision: source.sourceRevision,
        error: `Visual previews are not available for ${source.format.id}.`,
      },
    }
  if (options.clip || options.fullPage || options.height)
    throw new Error(
      "Drawing previews accept theme and width. Use worktable_drawings_read render for world-coordinate regions or selected objects."
    )
  try {
    const drawing = QuickdrawDocumentSchema.parse(
      JSON.parse(new TextDecoder().decode(source.bytes))
    )
    const { data, ...metadata } = await renderDrawing(drawing, {
      format: "png",
      theme: options.theme,
      width: options.width,
      timeoutMs: options.timeoutMs,
      signal: input.signal,
    })
    if (Buffer.byteLength(data, "base64") > MAX_DOCUMENT_PREVIEW_BYTES)
      throw new Error(
        "Preview exceeds the image response budget; request a smaller width or crop."
      )
    const contentHash = createHash("sha256")
      .update(Buffer.from(data, "base64"))
      .digest("hex")
    return withResultMedia(
      {
        ...base,
        preview: {
          ...metadata,
          status: "ready" as const,
          kind: "saved" as const,
          sourceRevision: source.sourceRevision,
          contentHash,
          contentBlockIndex: 1,
          capturedAt: new Date().toISOString(),
          theme: options.theme ?? "light",
        },
      },
      [{ type: "image", mimeType: "image/png", data }]
    )
  } catch (error) {
    return { ...base, preview: previewFailure(source.sourceRevision, error) }
  }
}
