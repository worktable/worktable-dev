// ============================================================
// Space starting points ("Start here")
// ============================================================
//
// A Space keeps a short, ordered list of pinned documents in space.json
// settings.startHere. Pins are stored by path and resolved through document
// aliases at read time, so renames and moves keep them pointing at the same
// document. A pin whose target was archived or deleted is reported as such;
// nothing substitutes another document.

import {
  START_HERE_LIMIT,
  StartHerePinSchema,
  type ResolvedStartHerePin,
  type SpaceFile,
  type StartHerePin,
} from "@worktable/types"
import { resolveDocAlias } from "./doc-aliases.ts"
import { listDocuments } from "./document-query.ts"
import { mutateSpace, readSpace, sanitizeDocPath } from "./store.ts"
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts"

export class StartHereError extends Error {
  readonly reason: "invalid" | "not-found"

  constructor(message: string, reason: "invalid" | "not-found" = "invalid") {
    super(message)
    this.name = "StartHereError"
    this.reason = reason
  }
}

/** Stored pins, ignoring malformed entries rather than failing the Space. */
export function readStartHere(space: Pick<SpaceFile, "settings">): StartHerePin[] {
  const raw = space.settings?.["startHere"]
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const parsed = StartHerePinSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

async function currentPath(spaceId: string, path: string): Promise<string> {
  const resolved = await resolveDocAlias(spaceId, path)
  return resolved.path ?? path
}

export async function resolveStartHere(
  spaceId: string,
  space?: SpaceFile
): Promise<ResolvedStartHerePin[]> {
  const spaceFile = space ?? (await readSpace(spaceId)).data
  if (!spaceFile) return []
  const pins = readStartHere(spaceFile)
  if (pins.length === 0) return []
  const documents = new Map(
    (await listDocuments({ spaceId, includeArchived: true })).flatMap((item) =>
      item.kind === "document" ? [[item.path, item] as const] : []
    )
  )
  const resolved: ResolvedStartHerePin[] = []
  for (const pin of pins) {
    const path = await currentPath(spaceId, pin.path)
    const document = documents.get(path)
    resolved.push({
      path,
      ...(pin.note ? { note: pin.note } : {}),
      status: !document ? "missing" : document.archived ? "archived" : "active",
      ...(document ? { title: document.title, format: document.format } : {}),
    })
  }
  return resolved
}

/** Replace a Space's pins. Every pin must name an active document. */
export async function setStartHere(
  spaceId: string,
  pins: readonly StartHerePin[]
): Promise<ResolvedStartHerePin[]> {
  if (!(await readSpace(spaceId)).data) {
    throw new StartHereError(`Space not found: ${spaceId}`, "not-found")
  }
  if (pins.length > START_HERE_LIMIT) {
    throw new StartHereError(
      `A Space can pin at most ${START_HERE_LIMIT} documents to Start here`
    )
  }
  const active = new Set(
    (await listDocuments({ spaceId })).flatMap((item) =>
      item.kind === "document" ? [item.path] : []
    )
  )
  const normalized: StartHerePin[] = []
  const seen = new Set<string>()
  for (const pin of pins) {
    const path = await currentPath(spaceId, sanitizeDocPath(pin.path))
    if (!active.has(path)) {
      throw new StartHereError(`Not an active document in this Space: ${pin.path}`)
    }
    if (seen.has(path)) continue
    seen.add(path)
    const note = pin.note?.trim()
    normalized.push({ path, ...(note ? { note } : {}) })
  }
  const result = await mutateSpace(spaceId, (space) => ({
    ...space,
    settings: { ...space.settings, startHere: normalized },
    updatedAt: new Date().toISOString(),
  }))
  if (!result.data) throw new StartHereError(result.error ?? `Space not found: ${spaceId}`)
  await notifyWorkspaceChangeAndWait({ type: "space", spaceId })
  return resolveStartHere(spaceId, result.data)
}
