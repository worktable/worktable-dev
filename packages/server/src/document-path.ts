import { z } from "zod"
import { RESERVED_DOCUMENT_SOURCE_SUFFIXES } from "./document-storage-profile.ts"

const WINDOWS_RESERVED_SEGMENT =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const WINDOWS_INVALID_SEGMENT_CHARACTER = /[<>:"|?*]/
const ENCODED_SEPARATOR = /%2f|%5c/i

export const DOCUMENT_PATH_MAX_BYTES = 1024
export const DOCUMENT_PATH_SEGMENT_MAX_BYTES = 255
export const DOCUMENT_PATH_INSPECTION_MAX_BYTES = 4096
const DOCUMENT_PATH_MAX_DECODE_PASSES = 16

export type DocumentPathDiagnosticCode =
  | "empty"
  | "absolute"
  | "backslash"
  | "empty-segment"
  | "dot-segment"
  | "traversal"
  | "encoded-separator"
  | "invalid-encoding"
  | "nul"
  | "segment-too-long"
  | "path-too-long"
  | "windows-reserved"
  | "windows-invalid-character"
  | "trailing-dot-or-space"
  | "registered-extension"
  | "non-normalized-unicode"
  | "ill-formed-unicode"
  | "inspection-limit"
  | "encoding-depth"

export interface DocumentPathDiagnostic {
  code: DocumentPathDiagnosticCode
  segment?: string
}

export interface DocumentPathAnalysis {
  input: string
  canonicalPath: string | null
  comparisonKey: string | null
  safe: boolean
  portable: boolean
  diagnostics: DocumentPathDiagnostic[]
}

/** Compare already-analyzed paths using the portable, case-insensitive key. */
export function documentPathKeyIsAtOrBelow(
  candidateKey: string,
  ancestorKey: string
): boolean {
  return (
    candidateKey === ancestorKey ||
    candidateKey.startsWith(`${ancestorKey}/`)
  )
}

/** True only for a proper descendant in the portable path namespace. */
export function documentPathKeyIsBelow(
  candidateKey: string,
  ancestorKey: string
): boolean {
  return (
    candidateKey !== ancestorKey &&
    documentPathKeyIsAtOrBelow(candidateKey, ancestorKey)
  )
}

/** Remap a path at or below one portable prefix without relying on casing. */
export function remapDocumentPathPrefix(
  candidatePath: string,
  ancestorPath: string,
  replacementPath: string
): string | null {
  const candidate = analyzeDocumentPath(candidatePath)
  const ancestor = analyzeDocumentPath(ancestorPath)
  if (
    !candidate.comparisonKey ||
    !ancestor.comparisonKey ||
    !documentPathKeyIsAtOrBelow(
      candidate.comparisonKey,
      ancestor.comparisonKey
    )
  ) {
    return null
  }
  const suffix = candidatePath
    .split("/")
    .slice(ancestorPath.split("/").length)
  return [replacementPath, ...suffix].join("/")
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isWellFormedUnicode(value: string): boolean {
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

function decodeForSafety(value: string): {
  decoded: string
  invalid: boolean
  excessive: boolean
} {
  let decoded = value
  for (let pass = 0; pass < DOCUMENT_PATH_MAX_DECODE_PASSES; pass += 1) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      return { decoded, invalid: true, excessive: false }
    }
    if (next === decoded) {
      return { decoded, invalid: false, excessive: false }
    }
    decoded = next
  }
  return { decoded, invalid: false, excessive: true }
}

function pushOnce(
  diagnostics: DocumentPathDiagnostic[],
  diagnostic: DocumentPathDiagnostic
): void {
  if (
    diagnostics.some(
      (candidate) =>
        candidate.code === diagnostic.code &&
        candidate.segment === diagnostic.segment
    )
  )
    return
  diagnostics.push(diagnostic)
}

export function analyzeDocumentPath(
  input: string,
  options?: { enforceNewPathGrammar?: boolean }
): DocumentPathAnalysis {
  const diagnostics: DocumentPathDiagnostic[] = []
  if (
    input.length > DOCUMENT_PATH_INSPECTION_MAX_BYTES ||
    byteLength(input) > DOCUMENT_PATH_INSPECTION_MAX_BYTES
  ) {
    return {
      input,
      canonicalPath: null,
      comparisonKey: null,
      safe: false,
      portable: false,
      diagnostics: [{ code: "inspection-limit" }],
    }
  }
  if (!isWellFormedUnicode(input)) {
    pushOnce(diagnostics, { code: "ill-formed-unicode" })
  }
  if (input.length === 0) pushOnce(diagnostics, { code: "empty" })
  if (input.startsWith("/")) pushOnce(diagnostics, { code: "absolute" })
  if (input.includes("\\")) pushOnce(diagnostics, { code: "backslash" })
  if (input.includes("\0")) pushOnce(diagnostics, { code: "nul" })
  if (ENCODED_SEPARATOR.test(input)) {
    pushOnce(diagnostics, { code: "encoded-separator" })
  }

  const rawSegments = input.split("/")
  const canonicalSegments: string[] = []
  for (const rawSegment of rawSegments) {
    if (rawSegment.length === 0) {
      pushOnce(diagnostics, { code: "empty-segment", segment: rawSegment })
      continue
    }

    const decoded = decodeForSafety(rawSegment)
    if (decoded.invalid) {
      pushOnce(diagnostics, { code: "invalid-encoding", segment: rawSegment })
    }
    if (decoded.excessive) {
      pushOnce(diagnostics, { code: "encoding-depth", segment: rawSegment })
    }
    if (decoded.decoded.includes("/") || decoded.decoded.includes("\\")) {
      pushOnce(diagnostics, { code: "encoded-separator", segment: rawSegment })
    }
    if (decoded.decoded === ".") {
      pushOnce(diagnostics, { code: "dot-segment", segment: rawSegment })
    }
    if (decoded.decoded === "..") {
      pushOnce(diagnostics, { code: "traversal", segment: rawSegment })
    }
    if (decoded.decoded.includes("\0")) {
      pushOnce(diagnostics, { code: "nul", segment: rawSegment })
    }

    const normalized = rawSegment.normalize("NFC")
    if (normalized !== rawSegment) {
      pushOnce(diagnostics, {
        code: "non-normalized-unicode",
        segment: rawSegment,
      })
    }
    if (byteLength(normalized) > DOCUMENT_PATH_SEGMENT_MAX_BYTES) {
      pushOnce(diagnostics, { code: "segment-too-long", segment: rawSegment })
    }
    if (WINDOWS_RESERVED_SEGMENT.test(normalized)) {
      pushOnce(diagnostics, { code: "windows-reserved", segment: rawSegment })
    }
    if (
      WINDOWS_INVALID_SEGMENT_CHARACTER.test(normalized) ||
      [...normalized].some((character) => character.charCodeAt(0) < 32)
    ) {
      pushOnce(diagnostics, {
        code: "windows-invalid-character",
        segment: rawSegment,
      })
    }
    if (/[. ]$/.test(normalized)) {
      pushOnce(diagnostics, {
        code: "trailing-dot-or-space",
        segment: rawSegment,
      })
    }
    canonicalSegments.push(normalized)
  }

  const canonicalPath = canonicalSegments.join("/")
  if (byteLength(canonicalPath) > DOCUMENT_PATH_MAX_BYTES) {
    pushOnce(diagnostics, { code: "path-too-long" })
  }

  const lowerPath = canonicalPath.toLowerCase()
  if (options?.enforceNewPathGrammar) {
    for (const suffix of RESERVED_DOCUMENT_SOURCE_SUFFIXES) {
      if (lowerPath.endsWith(suffix)) {
        pushOnce(diagnostics, { code: "registered-extension" })
        break
      }
    }
  }

  const unsafeCodes = new Set<DocumentPathDiagnosticCode>([
    "empty",
    "absolute",
    "backslash",
    "empty-segment",
    "dot-segment",
    "traversal",
    "encoded-separator",
    "nul",
    "segment-too-long",
    "ill-formed-unicode",
    "inspection-limit",
    "encoding-depth",
  ])
  const portabilityCodes = new Set<DocumentPathDiagnosticCode>([
    ...unsafeCodes,
    "path-too-long",
    "windows-reserved",
    "windows-invalid-character",
    "trailing-dot-or-space",
    "registered-extension",
  ])
  const safe = !diagnostics.some((diagnostic) =>
    unsafeCodes.has(diagnostic.code)
  )
  const portable = !diagnostics.some((diagnostic) =>
    portabilityCodes.has(diagnostic.code)
  )

  return {
    input,
    canonicalPath: safe && canonicalPath ? canonicalPath : null,
    comparisonKey:
      safe && canonicalPath
        ? canonicalPath.normalize("NFC").toLowerCase()
        : null,
    safe,
    portable,
    diagnostics,
  }
}

export const DocumentPathSchema = z.string().superRefine((value, context) => {
  const analysis = analyzeDocumentPath(value)
  for (const diagnostic of analysis.diagnostics) {
    if (diagnostic.code === "non-normalized-unicode") continue
    context.addIssue({
      code: "custom",
      message: diagnostic.segment
        ? `${diagnostic.code}: ${diagnostic.segment}`
        : diagnostic.code,
    })
  }
})

export function parseNewDocumentPath(
  input: string
): { path: string; comparisonKey: string } | { error: DocumentPathAnalysis } {
  const analysis = analyzeDocumentPath(input, { enforceNewPathGrammar: true })
  if (
    !analysis.safe ||
    !analysis.portable ||
    !analysis.canonicalPath ||
    !analysis.comparisonKey
  ) {
    return { error: analysis }
  }
  return {
    path: analysis.canonicalPath,
    comparisonKey: analysis.comparisonKey,
  }
}
