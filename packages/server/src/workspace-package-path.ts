import { posix } from "node:path"

export type PackagePathIssueCode =
  | "trailing-space-or-dot"
  | "reserved-name"
  | "invalid-character"
  | "non-normalized-unicode"
  | "path-too-long"
  | "segment-too-long"
  | "non-canonical-path"
  | "case-collision"

export interface PackagePathIssue {
  code: PackagePathIssueCode
  path: string
  relatedPaths?: string[]
}

/** Archive paths have a different grammar from logical document paths. */
export function analyzePackagePath(value: string): PackagePathIssue | null {
  if (
    !value ||
    value.startsWith("/") ||
    posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../")
  ) {
    return { code: "non-canonical-path", path: value }
  }
  if (Buffer.byteLength(value, "utf8") > 1024)
    return { code: "path-too-long", path: value }
  const parts = value.split("/")
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!
    const path = parts.slice(0, index + 1).join("/")
    if (part.normalize("NFC") !== part)
      return { code: "non-normalized-unicode", path }
    if (Buffer.byteLength(part, "utf8") > 255)
      return { code: "segment-too-long", path }
    // eslint-disable-next-line no-control-regex -- exclude Windows control characters
    if (/[<>:"|?*\\\u0000-\u001f]/u.test(part))
      return { code: "invalid-character", path }
    if (/[. ]$/u.test(part)) return { code: "trailing-space-or-dot", path }
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))
      return { code: "reserved-name", path }
  }
  return null
}

export interface WorkspaceExportDiagnostics {
  code: "NON_PORTABLE_HISTORY" | "NON_PORTABLE_CONTENT"
  issues: PackagePathIssue[]
  issueCount: number
  truncated: boolean
  affectedFiles: number
  affectedBytes: number
  /** Consent is bound to the exact affected source entries, never arbitrary paths. */
  recoveryFingerprint?: string
}

export class WorkspaceExportPathError extends Error {
  readonly diagnostics: WorkspaceExportDiagnostics
  constructor(diagnostics: WorkspaceExportDiagnostics) {
    super(
      diagnostics.code === "NON_PORTABLE_HISTORY"
        ? `${diagnostics.affectedFiles} history ${diagnostics.affectedFiles === 1 ? "file has a filename" : "files have filenames"} that cannot be exported to every supported filesystem.`
        : `Workspace content contains filenames that cannot be exported to every supported filesystem.${diagnostics.issues.some((issue) => issue.code === "case-collision") ? " Found case-colliding paths." : ""}`
    )
    this.diagnostics = diagnostics
    this.name = "WorkspaceExportPathError"
  }
}
