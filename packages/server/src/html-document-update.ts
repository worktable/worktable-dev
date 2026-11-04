// ============================================================
// Changing an HTML Doc's source and properties
// ============================================================
//
// Every write that changes an existing HTML Doc, from an agent or the REST
// API, goes through updateHtmlDocumentLocked: a whole new page, exact text
// edits to the current one, or only its name, description or permissions.
// It applies the permission rules, checks the revision the writer read,
// validates the page, saves it and records a version, all while the caller
// holds the Doc's write lock, so a concurrent write can't land in between.

import type { WidgetFile } from "@worktable/types"
import { htmlSourceRevision } from "./document-content-revision.ts"
import {
  authorizeHtmlPermissions,
  NETWORK_REQUEST_WARNING,
} from "./html-permission-authority.ts"
import { applyTextEdits, DocEditError, type TextEdit } from "./markdown-edit.ts"
import type { TokenIdentity } from "./token-store.ts"
import {
  buildWidgetFile,
  getBlockingWidgetIssue,
  validateWidgetHtml,
  type WidgetValidationIssue,
} from "./widget-authoring.ts"
import { readWidgetDocument, writeWidget } from "./widget-store.ts"
import {
  captureWidgetVersionContent,
  recordWidgetVersion,
} from "./widget-version-store.ts"

/**
 * A write the Doc's rules refuse; nothing was written. `issue` is the
 * validation error that blocked it, if one did.
 */
export class HtmlDocumentWriteError extends Error {
  readonly kind: "not_found" | "invalid"
  readonly issue?: WidgetValidationIssue
  readonly warnings?: WidgetValidationIssue[]
  constructor(
    kind: HtmlDocumentWriteError["kind"],
    message: string,
    blocked: { issue?: WidgetValidationIssue; warnings?: WidgetValidationIssue[] } = {}
  ) {
    super(message)
    this.name = "HtmlDocumentWriteError"
    this.kind = kind
    this.issue = blocked.issue
    this.warnings = blocked.warnings
  }
}

export interface HtmlDocumentUpdate {
  spaceId: string
  htmlId: string
  /** A whole new page. */
  html?: string
  /** Exact replacements in the current page, applied in order. */
  edits?: readonly TextEdit[]
  /** The revision the writer read; a write is refused once the source moved on. */
  expectedRevision?: string
  /** Whether a whole new page must name the revision it replaces. */
  requireRevisionToReplace: boolean
  name?: string
  description?: string
  metadata?: Record<string, unknown>
  /** The permissions the write sets; undefined keeps the current ones. */
  permissions?: WidgetFile["permissions"]
  writer: {
    /** Whether a person is writing; see isPersonWriter. */
    person: boolean
    identity: Pick<TokenIdentity, "principal"> | undefined
    scopes: string[]
    updatedBy: string
  }
  /** How the change arrived, for version history. */
  versionSource: string
}

export interface HtmlDocumentUpdateResult {
  widget: WidgetFile
  warnings: WidgetValidationIssue[]
  /** The saved source's revision. */
  revision: string
  /** Whether anything was saved. */
  changed: boolean
}

/**
 * Change an existing HTML Doc. The caller holds withWidgetWriteLock for it
 * (and, over MCP, its canonical path). Throws HtmlPermissionError for
 * permissions beyond the writer's access, DocEditError for edits and
 * revisions, and HtmlDocumentWriteError otherwise; nothing is written then.
 */
export async function updateHtmlDocumentLocked(
  input: HtmlDocumentUpdate
): Promise<HtmlDocumentUpdateResult> {
  const { spaceId, htmlId } = input
  if (input.html !== undefined && input.edits !== undefined) {
    throw new HtmlDocumentWriteError(
      "invalid",
      "Pass html to replace the page or edits to change part of it, not both."
    )
  }
  const { data: current, error } = await readWidgetDocument(spaceId, htmlId)
  if (error || !current) {
    throw new HtmlDocumentWriteError("not_found", error ?? "Widget not found")
  }
  const existing = current.widget
  // Permissions first, so a writer without the access never learns a revision.
  const granted = authorizeHtmlPermissions({
    requested: input.permissions,
    existing,
    person: input.writer.person,
    identity: input.writer.identity,
    scopes: input.writer.scopes,
  })
  // A replace names the revision it is based on; one the HTML Doc is no
  // longer at is refused, and what is there stays.
  const currentRevision = htmlSourceRevision(current.sourceBytes)
  if (
    input.html !== undefined &&
    input.requireRevisionToReplace &&
    input.expectedRevision === undefined
  ) {
    throw new DocEditError(
      "revision_required",
      `${htmlId} already exists. Read it with worktable_html_read and pass its revision as expectedRevision to replace its html.`
    )
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
    throw new DocEditError(
      "revision_conflict",
      `${htmlId} changed since revision ${input.expectedRevision}. Read it again and reapply your change.`,
      { currentRevision }
    )
  }

  const html =
    input.html ??
    (input.edits ? applyHtmlEdits(current.html, input.edits) : current.html)
  const permissions = granted.permissions ?? existing.permissions
  const warnings = validateWidgetHtml(html, permissions)
  const blocking = getBlockingWidgetIssue(warnings)
  if (blocking) {
    throw new HtmlDocumentWriteError("invalid", `${blocking.code}: ${blocking.message}`, {
      issue: blocking,
      warnings,
    })
  }
  if (granted.requests?.network) warnings.push(NETWORK_REQUEST_WARNING)

  const widget = buildWidgetFile({
    id: htmlId,
    name: input.name ?? existing.name,
    description: input.description ?? existing.description,
    updatedBy: input.writer.updatedBy,
    metadata: input.metadata,
    permissions,
    requests: granted.requests ?? null,
    existing,
  })
  if (html === current.html && sameProperties(widget, existing)) {
    return { widget: existing, warnings, revision: currentRevision, changed: false }
  }
  const before = await captureWidgetVersionContent(spaceId, htmlId)
  const written = await writeWidget(spaceId, widget, html)
  if (written.error || !written.data) {
    throw new HtmlDocumentWriteError("invalid", written.error ?? "Widget write failed")
  }
  try {
    await recordWidgetVersion(spaceId, htmlId, before, {
      source: input.versionSource,
      updatedBy: input.writer.updatedBy,
    })
  } finally {
    written.release?.()
  }
  return {
    widget: written.data,
    warnings,
    // The source is stored as the html's UTF-8 bytes.
    revision: htmlSourceRevision(new TextEncoder().encode(html)),
    changed: true,
  }
}

/** The page after `edits`, or a DocEditError that shows where an edit diverged. */
function applyHtmlEdits(html: string, edits: readonly TextEdit[]): string {
  let text: string
  try {
    text = applyTextEdits(html, edits).text
  } catch (error) {
    if (!(error instanceof DocEditError) || error.code !== "no_match") throw error
    const index = error.details.editIndex as number
    // Generated HTML is often one long line, where the closest line says
    // little: show where the longest start of oldText occurs instead.
    const before = index > 0 ? applyTextEdits(html, edits.slice(0, index)).text : html
    const hint = divergence(before, edits[index]!.oldText)
    if (!hint) throw error
    throw new DocEditError(
      "no_match",
      `Edit ${index + 1}: oldText was not found${index > 0 ? " after the earlier edits" : ""}. Its first ${hint.matchedChars} characters match at line ${hint.line}, column ${hint.column}; where it stops matching, the page reads ${JSON.stringify(hint.text)}. Read the HTML Doc again and copy the text exactly.`,
      { editIndex: index, closest: [hint] }
    )
  }
  if (text === html) {
    throw new DocEditError(
      "no_change",
      "The edits leave the HTML Doc unchanged. Nothing was written."
    )
  }
  return text
}

const HINT_MIN_CHARS = 8
const HINT_TAIL_CHARS = 80

/** Where the longest start of `oldText` occurs in `text`, if it is long enough to mean something. */
function divergence(
  text: string,
  oldText: string
): { line: number; column: number; matchedChars: number; text: string } | null {
  // Every shorter start of a start that occurs occurs too, so search the length.
  let low = 0
  let high = oldText.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (text.includes(oldText.slice(0, mid))) low = mid
    else high = mid - 1
  }
  if (low < Math.min(HINT_MIN_CHARS, oldText.length)) return null
  const at = text.indexOf(oldText.slice(0, low))
  const lineStart = text.lastIndexOf("\n", at - 1) + 1
  let line = 1
  for (let i = text.indexOf("\n"); i !== -1 && i < at; i = text.indexOf("\n", i + 1)) line++
  const from = Math.max(at, at + low - HINT_TAIL_CHARS)
  return {
    line,
    column: at - lineStart + 1,
    matchedChars: low,
    text: text.slice(from, at + low + HINT_TAIL_CHARS),
  }
}

function sameProperties(next: WidgetFile, existing: WidgetFile): boolean {
  const comparable = (widget: WidgetFile) =>
    JSON.stringify({
      name: widget.name,
      description: widget.description ?? null,
      metadata: widget.metadata,
      permissions: widget.permissions,
      requests: widget.requests ?? null,
    })
  return comparable(next) === comparable(existing)
}
