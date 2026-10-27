// ============================================================
// Notices on an agent's other tool calls
// ============================================================
//
// When an agent works in Worktable, its tool results can tell it what waits
// on it, so it learns of a comment without being asked to look. The rules
// keep this from taking over the session:
//
// - Only items in the Space the call works in. Items elsewhere wait for the
//   pending read (and, later, settings that turn them on).
// - About the Doc or thread the call works on: shown in full the first time
//   such a call sees it, then one line while it stays unopened.
// - Elsewhere in the Space: shown in full once, as news. After that only
//   counted, beside other news, and not at all once opened or after a week.
// - Nothing new means nothing is printed.
//
// This never holds a call: before the pending list is built, and for agents
// nothing waits on, it returns at once. A failure here never fails the call.

import { logError } from "./debug-log.ts"
import { cachedParticipantForKey, participantKey } from "./participant-store.ts"
import {
  markPendingDelivered,
  markPendingOnTopic,
  pendingIfReady,
  pendingMarks,
  type PendingEntry,
} from "./pending-list.ts"
import {
  noticesFor,
  renderNotices,
  type NoticeTarget,
  type PendingNotice,
} from "./pending-notices.ts"
import { announceSeen } from "./pending-read.ts"
import type { TokenIdentity } from "./token-store.ts"

/** At most this many items in full on one call, about this work and else. */
const FULL_LIMIT = 3
/** At most this many items looked up on one call. */
const LOOKUP_LIMIT = 20
const OLDER_FOR_MS = 7 * 24 * 60 * 60 * 1000

/** Calls that already carry, or never should carry, what waits. */
const QUIET_OPERATIONS = new Set([
  "workspace.pending",
  "threads.wait",
  "thread_delivery.register_participant",
  "thread_delivery.claim",
  "thread_delivery.accept",
  "thread_delivery.progress",
  "thread_delivery.fail",
])

type Reader = Pick<TokenIdentity, "agent" | "principal" | "scopes"> &
  Partial<TokenIdentity>

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** What a call works on, from the arguments every tool names it with. */
export function noticeTargetFor(args: Record<string, unknown>): NoticeTarget {
  const target = args.target as Record<string, unknown> | undefined
  const docPath =
    text(args.docPath) ??
    text(args.path) ??
    text(args.htmlId) ??
    text(args.widgetId) ??
    text(target?.docPath) ??
    text(target?.htmlId) ??
    text(target?.widgetId)
  const location = args.location as Record<string, unknown> | undefined
  const spaceId = text(args.spaceId) ?? text(location?.spaceId)
  const threadId = text(args.threadId)
  return {
    ...(spaceId ? { spaceId } : {}),
    ...(docPath ? { docPath } : {}),
    ...(threadId ? { threadId } : {}),
  }
}

function inSpace(entry: PendingEntry, target: NoticeTarget): boolean {
  const source = entry.source
  if (target.threadId && entry.scope.threadId === target.threadId) return true
  if (!target.spaceId) return false
  return source.kind === "comment"
    ? source.spaceId === target.spaceId
    : source.location.kind === "space" &&
        source.location.spaceId === target.spaceId
}

/**
 * The path a result says it read, which follows an old path's alias to the
 * Doc's current one.
 */
function resolvedPath(result: unknown): { docPath?: string } {
  if (!result || typeof result !== "object") return {}
  const value = result as Record<string, unknown>
  const path = text(value.docPath) ?? text(value.path)
  return path ? { docPath: path } : {}
}

/** Whether an item could be about this call, before looking anything up. */
function maybeOnTopic(entry: PendingEntry, target: NoticeTarget): boolean {
  const source = entry.source
  return source.kind === "comment"
    ? Boolean(target.docPath) && source.path === target.docPath
    : Boolean(target.threadId) && source.threadId === target.threadId
}

/** The notices to add to one tool result, or null for none. */
export async function ambientNotices(
  reader: Reader,
  operationId: string,
  args: Record<string, unknown>,
  result?: unknown
): Promise<string | null> {
  try {
    if (QUIET_OPERATIONS.has(operationId)) return null
    const participant = cachedParticipantForKey(participantKey(reader))
    if (!participant) return null
    const entries = pendingIfReady(participant.id)
    if (!entries?.length) return null
    const target = noticeTargetFor({ ...args, ...resolvedPath(result) })
    // The comment the call opens or answers is the thing itself, not news.
    const opened = text(args.annotationId)
    // Only items that could print need looking up: unopened, and new or
    // about this call. Items shown before elsewhere are only counted.
    const now = Date.now()
    let older = 0
    const candidates = entries.filter((entry) => {
      if (!inSpace(entry, target)) return false
      if (entry.source.kind === "comment" && entry.source.annotationId === opened) {
        return false
      }
      const marks = pendingMarks(entry.itemId) ?? {}
      // Opened means the agent knows it; the comment itself is the record.
      if (marks.readAt) return false
      if (!marks.deliveredAt || maybeOnTopic(entry, target)) return true
      if (now - Date.parse(marks.deliveredAt) < OLDER_FOR_MS) older += 1
      return false
    })
    if (candidates.length === 0) return null
    // Newest first, and only as many as a call can show: what waits beyond
    // that is counted, not looked up.
    const looked = candidates.slice(0, LOOKUP_LIMIT)
    older += candidates.length - looked.length
    const notices = await noticesFor(looked, reader, target)
    const fresh: PendingNotice[] = []
    const reminders: PendingNotice[] = []
    for (const notice of notices) {
      const marks = pendingMarks(notice.itemId) ?? {}
      if (notice.onTopic) {
        if (!marks.onTopicAt) fresh.push(notice)
        else reminders.push(notice)
      } else if (!marks.deliveredAt) {
        fresh.push(notice)
      } else if (now - Date.parse(marks.deliveredAt) < OLDER_FOR_MS) {
        older += 1
      }
    }
    if (fresh.length === 0 && reminders.length === 0) return null
    const onTopic = fresh.filter((notice) => notice.onTopic)
    const elsewhere = fresh.filter((notice) => !notice.onTopic)
    const shown = [
      ...onTopic.slice(0, FULL_LIMIT),
      ...elsewhere.slice(0, FULL_LIMIT),
    ]
    const more = fresh.length - shown.length
    const { text: rendered, renderedItemIds } = renderNotices(shown, {
      mode: "ambient",
      reminders: reminders.slice(0, FULL_LIMIT),
      more: more + Math.max(0, reminders.length - FULL_LIMIT),
      older,
    })
    markPendingOnTopic(
      shown.filter((notice) => notice.onTopic).map((notice) => notice.itemId)
    )
    announceSeen(markPendingDelivered(renderedItemIds))
    return rendered || null
  } catch (error) {
    console.error("[pending] could not add notices:", logError(error))
    return null
  }
}
