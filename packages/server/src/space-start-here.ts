// ============================================================
// Space pins
// ============================================================
//
// A Space keeps a short, ordered list of pinned documents in space.json
// settings.startHere (the stored key predates the name "pins"). Pins are stored by path and resolved through document
// aliases at read time, so renames and moves keep them pointing at the same
// document. A pin whose target was archived or deleted is reported as such;
// nothing substitutes another document.
//
// Pins are a Space's front page, so people keep them. An agent suggests a pin
// to a person in a thread instead, and on a team only people who manage the
// Space change them.

import { recordActivity } from "./activity-log.ts"
import {
  START_HERE_LIMIT,
  StartHerePinSchema,
  type ResolvedStartHerePin,
  type SpaceFile,
  type StartHerePin,
} from "@worktable/types"
import { createDocAliasResolver, resolveDocAlias } from "./doc-aliases.ts"
import {
  listDocuments,
  listDocumentsWithAliases,
} from "./document-query.ts"
import { mutateSpace, readSpace, sanitizeDocPath } from "./store.ts"
import {
  canAccessSpace,
  currentRequestIdentity,
  TeamAccessError,
} from "./team-policy.ts"
import type { TokenIdentity } from "./token-store.ts"
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
  const listed = await listDocumentsWithAliases({
    spaceId,
    includeArchived: true,
  })
  const documents = new Map(
    listed.documents.flatMap((item) =>
      item.kind === "document" ? [[item.path, item] as const] : []
    )
  )
  const resolveAlias = createDocAliasResolver(listed.aliases)
  const resolved: ResolvedStartHerePin[] = []
  for (const pin of pins) {
    const path = resolveAlias(pin.path) ?? pin.path
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

/** What an agent hears when it tries to change a Space's pins. */
export function agentPinsRefusal(): TeamAccessError {
  return new TeamAccessError(
    "Pins are kept by people. Suggest the pin to a person in a thread instead.",
    "PINS_PEOPLE_ONLY"
  )
}

/** Refuses agents, and on a team anyone who doesn't manage the Space. */
export function assertCanChangePins(
  spaceId: string,
  identity: TokenIdentity | undefined = currentRequestIdentity()
): void {
  if (!identity) return
  if (identity.principal.type === "agent") throw agentPinsRefusal()
  if (identity.principal.type === "human" && !canAccessSpace(spaceId, "manage", identity)) {
    throw new TeamAccessError()
  }
}

/**
 * Replace a Space's pins. A new pin must name an active document; pins that
 * were already there may stay even if their document was since archived or
 * removed, so editing the rest of the list never requires repairing them.
 */
export async function setStartHere(
  spaceId: string,
  pins: readonly StartHerePin[]
): Promise<ResolvedStartHerePin[]> {
  assertCanChangePins(spaceId)
  const space = (await readSpace(spaceId)).data
  if (!space) {
    throw new StartHereError(`Space not found: ${spaceId}`, "not-found")
  }
  const existing = new Set(
    await Promise.all(readStartHere(space).map((pin) => currentPath(spaceId, pin.path)))
  )
  if (pins.length > START_HERE_LIMIT) {
    throw new StartHereError(
      `A Space can pin at most ${START_HERE_LIMIT} documents`
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
    if (!active.has(path) && !existing.has(path)) {
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
  for (const path of seen) {
    if (!existing.has(path)) {
      recordActivity({ spaceId, action: "doc.pinned", target: { kind: "doc", path } })
    }
  }
  for (const path of existing) {
    if (!seen.has(path)) {
      recordActivity({ spaceId, action: "doc.unpinned", target: { kind: "doc", path } })
    }
  }
  return resolveStartHere(spaceId, result.data)
}
