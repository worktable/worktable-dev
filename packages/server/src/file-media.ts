// ============================================================
// File media types
// ============================================================
//
// How Worktable serves a file's bytes, as the file type table's serve
// policy says. Only images are shown inline; every other file is a download.
// SVG is shown inline too, under a sandboxing policy, so a script inside it
// never runs on Worktable's origin.

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
