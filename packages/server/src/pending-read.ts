// ============================================================
// The pending read: an agent asks what waits on it
// ============================================================
//
// Counts never mark anything, so a hook can ask without the model seeing the
// answer. Notices mark what they return as delivered, since the agent asked
// to see them. Opening an item marks it read (see markOpened).

import { resolveParticipant } from "./participant-store.ts"
import {
  markPendingDelivered,
  markPendingOnTopic,
  markPendingRead,
  pendingFor,
  pendingMarks,
  pendingRevision,
  type PendingEntry,
} from "./pending-list.ts"
import {
  noticesFor,
  type NoticeTarget,
  type PendingNotice,
} from "./pending-notices.ts"
import type { TokenIdentity } from "./token-store.ts"
import { wsManager } from "./ws.ts"

/** At most this many items in one read. */
export const PENDING_READ_LIMIT = 20

export interface PendingReadInput {
  /** Only items in this Space, Doc or thread. */
  scope?: NoticeTarget
  /** Only items the list saw after this revision. */
  since?: number
  /** Only items not yet shown to this agent. */
  undelivered?: boolean
  /** "count" marks nothing; "notices" returns the items and marks them delivered. */
  mode?: "count" | "notices"
}

export interface PendingReadResult {
  revision: number
  count: number
  items?: PendingNotice[]
  more?: number
}

type Reader = Pick<TokenIdentity, "agent" | "principal" | "scopes"> &
  Partial<TokenIdentity>

function inScope(notice: PendingNotice, scope: NoticeTarget): boolean {
  if (scope.spaceId && notice.spaceId !== scope.spaceId) return false
  if (scope.docPath && notice.docPath !== scope.docPath) return false
  if (scope.threadId && notice.threadId !== scope.threadId) return false
  return true
}

/** Tell a Doc's open pages that one of its comments was seen. */
export function announceSeen(entries: readonly PendingEntry[]): void {
  for (const entry of entries) {
    if (entry.source.kind !== "comment") continue
    wsManager.broadcast(entry.source.spaceId, {
      type: "annotation_update",
      spaceId: entry.source.spaceId,
      data: { annotationId: entry.source.annotationId, event: "seen" },
    })
  }
}

export async function readPending(
  reader: Reader,
  input: PendingReadInput = {}
): Promise<PendingReadResult> {
  const { participant } = await resolveParticipant(reader)
  const revision = await pendingRevision(participant.id)
  // A revision the list never gave (state lost, or from elsewhere) reads as
  // "everything not yet shown": a notice too many beats one missed.
  const unknownSince = input.since !== undefined && input.since > revision
  const since = unknownSince ? 0 : (input.since ?? 0)
  const undelivered = input.undelivered === true || unknownSince
  const entries = (await pendingFor(participant.id)).filter(
    (entry) =>
      entry.revision > since &&
      (!undelivered || !pendingMarks(entry.itemId)?.deliveredAt)
  )
  const scope = input.scope ?? {}
  const notices = (await noticesFor(entries, reader, scope)).filter((notice) =>
    inScope(notice, scope)
  )
  if (input.mode !== "notices") return { revision, count: notices.length }
  // Oldest first, so passing the returned revision as since reads the rest.
  const ordered = notices.slice().sort((a, b) => a.revision - b.revision)
  const items = ordered.slice(0, PENDING_READ_LIMIT)
  // Told in full here, so a call on their Doc reminds in a line.
  const itemIds = items.map((item) => item.itemId)
  markPendingOnTopic(itemIds)
  announceSeen(markPendingDelivered(itemIds))
  const more = ordered.length - items.length
  return {
    revision: more > 0 ? items.at(-1)!.revision : revision,
    count: notices.length,
    items,
    ...(more > 0 ? { more } : {}),
  }
}

/**
 * The agent opened a comment or a thread message: its items there are read.
 * Never throws; reading must not fail because of a mark.
 */
export async function markOpened(
  reader: Reader,
  opened:
    | { kind: "comment"; annotationId: string }
    | { kind: "thread"; threadId: string; messageIds: readonly string[] }
): Promise<void> {
  try {
    const { participant } = await resolveParticipant(reader)
    const mine = await pendingFor(participant.id)
    const itemIds = mine.flatMap((entry) => {
      const source = entry.source
      if (opened.kind === "comment") {
        return source.kind === "comment" &&
          source.annotationId === opened.annotationId
          ? [entry.itemId]
          : []
      }
      return source.kind === "threadRequest" &&
        source.threadId === opened.threadId &&
        opened.messageIds.includes(source.messageId)
        ? [entry.itemId]
        : []
    })
    announceSeen(markPendingRead(itemIds))
  } catch {
    // Marks are telemetry for people; the read itself already succeeded.
  }
}
