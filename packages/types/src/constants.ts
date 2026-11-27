import type { ThreadLocation } from "./threads"

// Dependency-free values for code on the web app's startup path. Importing
// them must not pull in Zod or any schema module; the lint config enforces it.

/** The longest chosen thread topic. */
export const THREAD_TITLE_MAX_LENGTH = 160

/**
 * A thread leaves lists after this many days without a new message. The same
 * period a temporary Doc gets (TEMPORARY_DOCUMENT_GRACE_DAYS).
 */
export const THREAD_QUIET_DAYS = 7

/**
 * What someone last chose for a thread's place in lists. Without a choice a
 * thread is temporary from its last message.
 * - kept: stays in lists however quiet it gets.
 * - archived: out of lists until its next message.
 * - temporary: back to the usual rule, counting quiet days from `at`.
 */
export const THREAD_LIFETIME_STATES = ["kept", "archived", "temporary"] as const
export type ThreadLifetimeState = (typeof THREAD_LIFETIME_STATES)[number]
export interface ThreadLifetimeChoice {
  state: ThreadLifetimeState
  at: string
}

/**
 * Where a thread file keeps its lifetime choice: a namespaced key beside the
 * portable fields, so other tools' metadata is never mistaken for it.
 */
export const THREAD_LIFETIME_KEY = "worktable.threadLifetime"

/**
 * A thread's lifetime choice; undefined when unset or not understood. A choice
 * whose time cannot be read is not understood: compared with a message's time
 * it would hold the thread in the archive for good.
 */
export function threadLifetimeChoice(
  thread: object
): ThreadLifetimeChoice | undefined {
  const value = (thread as Record<string, unknown>)[THREAD_LIFETIME_KEY]
  if (typeof value !== "object" || value === null) return undefined
  const { state, at } = value as Record<string, unknown>
  return typeof at === "string" &&
    Number.isFinite(Date.parse(at)) &&
    THREAD_LIFETIME_STATES.includes(state as ThreadLifetimeState)
    ? { state: state as ThreadLifetimeState, at }
    : undefined
}

const THREAD_QUIET_MS = THREAD_QUIET_DAYS * 86_400_000

/**
 * Whether a thread has left lists: someone archived it and nothing was posted
 * since, or it has been quiet for THREAD_QUIET_DAYS. A kept thread never
 * leaves, and a new message always brings a thread back.
 */
export function isThreadArchived(
  thread: { lastMessageAt: string; lifetime?: ThreadLifetimeChoice },
  nowMs: number
): boolean {
  const from = threadArchivedFrom(thread)
  return from !== null && nowMs >= from
}

/**
 * From when a thread counts as archived, by isThreadArchived's rule, until
 * its next message or lifetime choice: 0 when it already is, null when it
 * never will be (kept).
 */
export function threadArchivedFrom(thread: {
  lastMessageAt: string
  lifetime?: ThreadLifetimeChoice
}): number | null {
  const choice = thread.lifetime
  if (choice?.state === "kept") return null
  const lastMessageMs = Date.parse(thread.lastMessageAt)
  const chosenMs = choice ? Date.parse(choice.at) : Number.NaN
  if (choice?.state === "archived" && !(lastMessageMs > chosenMs)) return 0
  const quietSinceMs =
    choice?.state === "temporary" && chosenMs > lastMessageMs
      ? chosenMs
      : lastMessageMs
  return quietSinceMs + THREAD_QUIET_MS
}

/** The same for a thread as stored or read, from its newest message. */
export function isStoredThreadArchived(
  thread: { messages: ReadonlyArray<{ createdAt: string }> },
  nowMs: number
): boolean {
  const lastMessage = thread.messages.at(-1)
  return lastMessage
    ? isThreadArchived(
        {
          lastMessageAt: lastMessage.createdAt,
          lifetime: threadLifetimeChoice(thread),
        },
        nowMs
      )
    : false
}

/** A Space shows at most this many pinned starting points. */
export const START_HERE_LIMIT = 7

/** A person pins at most this many docs to their own Home. */
export const HOME_PIN_LIMIT = 8

/** The longest label a share link takes. */
export const SHARE_LINK_LABEL_MAX_LENGTH = 80

/** Limits for the link access editor and its persisted grant schema. */
export const LINK_GRANT_MAX_COLLECTIONS = 32
export const LINK_GRANT_MAX_FIELDS = 200

export function threadLocationKey(location: ThreadLocation): string {
  return location.kind === "worktable"
    ? "worktable"
    : `space:${location.spaceId}`
}

/** Collection, record and widget ids: lowercase letters, digits and inner dashes. */
export const CANONICAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/

export function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_ID_PATTERN.test(value)
}

/** Record query predicate operators. */
export const RECORD_PREDICATE_OPS = [
  "eq",
  "neq",
  "in",
  "contains",
  "has",
  "gt",
  "gte",
  "lt",
  "lte",
  "isEmpty",
] as const

/**
 * The hash that opens a Doc on one comment: `#comment-<id>`. Home builds it
 * and the comments panel reads it.
 */
export const COMMENT_HASH_PREFIX = "comment-"
