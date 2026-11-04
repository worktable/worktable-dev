// ============================================================
// File media types
// ============================================================
//
// How Worktable serves a file's bytes, as the file type table's serve
// policy says. Images are shown inline, and so is HTML, for the sandboxed
// frame its page shows it in; every other file is a download. Every file is
// served under a sandboxing policy with no sources allowed, so a script in
// an SVG or an HTML file never runs on Worktable's origin and the page it
// makes loads nothing.

import {
  FILE_TYPES,
  filePolicy,
  fileTypeFor,
  fileTypePolicy,
} from "@worktable/types"

/** The media type a file is served as; unknown files are plain bytes. */
export function fileMediaType(fileName: string): string {
  const type = fileTypeFor(fileName)
  if (type === null || fileTypePolicy(type, "serve") === "bytes") {
    return "application/octet-stream"
  }
  const { mediaType } = FILE_TYPES[type]
  return mediaType.startsWith("text/") ? `${mediaType}; charset=utf-8` : mediaType
}

/** Whether a file of this name may be shown inline rather than downloaded. */
export function fileShownInline(fileName: string): boolean {
  return filePolicy(fileName, "serve") === "inline"
}
