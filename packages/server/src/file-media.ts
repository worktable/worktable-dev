// ============================================================
// File media types
// ============================================================
//
// How Worktable serves a file's bytes. Only images are shown inline; every
// other file is a download. SVG is shown inline too, under a sandboxing
// policy, so a script inside it never runs on Worktable's origin.

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".jsonl": "application/x-ndjson",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
}

const INLINE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
])

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".")
  return dot > 0 ? fileName.slice(dot).toLowerCase() : ""
}

/** The media type a file is served as; unknown files are plain bytes. */
export function fileMediaType(fileName: string): string {
  return MEDIA_TYPES[extensionOf(fileName)] ?? "application/octet-stream"
}

/** Whether a file of this name may be shown inline rather than downloaded. */
export function fileShownInline(fileName: string): boolean {
  return INLINE_TYPES.has(fileMediaType(fileName))
}
