import {
  workspaceWritesFrozen,
  currentWorkspaceContentEpoch,
} from "./workspace-content-state"
import type { ThreadDraftState } from "./thread-submission"

export const THREAD_DRAFTS_STORAGE_KEY = "worktable:thread-drafts:v1"
export const MAX_THREAD_DRAFTS = 20
const THREAD_DRAFTS_CLEARED_EVENT = "worktable:thread-drafts-cleared"

export interface PersistedThreadDraftsV1 {
  version: 1
  drafts: Record<
    string,
    {
      value: string
      recipientId?: string
      notifyIdentityIds?: string[]
      responseIdentityId?: string | null
      replyTo?: string
      responseTo?: string | null
      submission?: {
        fingerprint: string
        idempotencyKey: string
      }
      updatedAt: number
    }
  >
}

export type ThreadDraftCollection = Record<string, ThreadDraftState>

export function normalizeThreadDraftIdentities(
  draft: ThreadDraftState,
  activeIdentityIds: Set<string>
): ThreadDraftState {
  const responseIdentityId =
    draft.responseIdentityId === null
      ? null
      : draft.responseIdentityId &&
          activeIdentityIds.has(draft.responseIdentityId)
        ? draft.responseIdentityId
        : undefined
  const notifyIdentityIds = draft.notifyIdentityIds?.filter(
    (identityId) =>
      activeIdentityIds.has(identityId) && identityId !== responseIdentityId
  )
  const normalizedNotifyIdentityIds = notifyIdentityIds?.length
    ? notifyIdentityIds
    : undefined
  if (
    responseIdentityId === draft.responseIdentityId &&
    normalizedNotifyIdentityIds?.join("\0") ===
      draft.notifyIdentityIds?.join("\0")
  ) {
    return draft
  }
  return {
    ...draft,
    responseIdentityId,
    notifyIdentityIds: normalizedNotifyIdentityIds,
    submission: undefined,
  }
}

interface SessionStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function threadDraftsStorageKey(workspaceId: string): string {
  const epoch = currentWorkspaceContentEpoch()
  return `${THREAD_DRAFTS_STORAGE_KEY}:${encodeURIComponent(workspaceId)}${epoch ? `:${epoch}` : ""}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function meaningfulDraft(draft: ThreadDraftState): boolean {
  return Boolean(
    draft.value.trim() ||
    draft.recipientId ||
    draft.notifyIdentityIds?.length ||
    draft.responseIdentityId ||
    draft.replyTo ||
    draft.responseTo ||
    draft.submission?.idempotencyKey
  )
}

function optionalStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null
  }
  return value
}

export function pruneThreadDrafts(
  drafts: ThreadDraftCollection
): ThreadDraftCollection {
  return Object.fromEntries(
    Object.entries(drafts)
      .filter(([, draft]) => meaningfulDraft(draft))
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_THREAD_DRAFTS)
  )
}

export function parseThreadDrafts(
  serialized: string | null
): ThreadDraftCollection {
  if (!serialized) return {}
  try {
    const parsed: unknown = JSON.parse(serialized)
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.drafts)) {
      return {}
    }

    const drafts: ThreadDraftCollection = {}
    for (const [key, candidate] of Object.entries(parsed.drafts)) {
      if (
        !isRecord(candidate) ||
        typeof candidate.value !== "string" ||
        typeof candidate.updatedAt !== "number" ||
        !Number.isFinite(candidate.updatedAt) ||
        candidate.updatedAt < 0 ||
        (candidate.recipientId !== undefined &&
          typeof candidate.recipientId !== "string")
      ) {
        continue
      }

      let submission: ThreadDraftState["submission"]
      if (candidate.submission !== undefined) {
        if (
          !isRecord(candidate.submission) ||
          typeof candidate.submission.fingerprint !== "string" ||
          typeof candidate.submission.idempotencyKey !== "string"
        ) {
          continue
        }
        submission = {
          fingerprint: candidate.submission.fingerprint,
          idempotencyKey: candidate.submission.idempotencyKey,
        }
      }

      const notifyIdentityIds = optionalStringArray(candidate.notifyIdentityIds)
      const legacyResponseIdentityIds = optionalStringArray(
        candidate.responseIdentityIds
      )
      const responseIdentityId =
        candidate.responseIdentityId === null ||
        typeof candidate.responseIdentityId === "string"
          ? candidate.responseIdentityId
          : candidate.responseIdentityId === undefined
            ? legacyResponseIdentityIds?.[0]
            : false
      if (
        notifyIdentityIds === null ||
        legacyResponseIdentityIds === null ||
        responseIdentityId === false ||
        (candidate.replyTo !== undefined &&
          typeof candidate.replyTo !== "string") ||
        (candidate.responseTo !== undefined &&
          candidate.responseTo !== null &&
          typeof candidate.responseTo !== "string")
      ) {
        continue
      }

      drafts[key] = {
        key,
        value: candidate.value,
        ...(candidate.recipientId
          ? { recipientId: candidate.recipientId }
          : {}),
        ...(notifyIdentityIds?.length ? { notifyIdentityIds } : {}),
        ...(responseIdentityId !== undefined ? { responseIdentityId } : {}),
        ...(candidate.replyTo ? { replyTo: candidate.replyTo } : {}),
        ...(candidate.responseTo !== undefined
          ? { responseTo: candidate.responseTo }
          : {}),
        ...(submission ? { submission } : {}),
        updatedAt: candidate.updatedAt,
      }
    }
    return pruneThreadDrafts(drafts)
  } catch {
    return {}
  }
}

export function serializeThreadDrafts(drafts: ThreadDraftCollection): string {
  const persisted: PersistedThreadDraftsV1 = { version: 1, drafts: {} }
  for (const [key, draft] of Object.entries(pruneThreadDrafts(drafts))) {
    persisted.drafts[key] = {
      value: draft.value,
      recipientId: draft.recipientId,
      notifyIdentityIds: draft.notifyIdentityIds,
      responseIdentityId: draft.responseIdentityId,
      replyTo: draft.replyTo,
      responseTo: draft.responseTo,
      submission: draft.submission,
      updatedAt: draft.updatedAt,
    }
  }
  return JSON.stringify(persisted)
}

export function loadThreadDrafts(
  workspaceId: string,
  storage?: SessionStorageLike
): ThreadDraftCollection {
  try {
    const target =
      storage ??
      (typeof window === "undefined" ? undefined : window.sessionStorage)
    if (!target) return {}
    return parseThreadDrafts(
      target.getItem(threadDraftsStorageKey(workspaceId))
    )
  } catch {
    return {}
  }
}

export function persistThreadDrafts(
  workspaceId: string,
  drafts: ThreadDraftCollection,
  storage?: SessionStorageLike
): void {
  if (workspaceWritesFrozen()) return
  try {
    const target =
      storage ??
      (typeof window === "undefined" ? undefined : window.sessionStorage)
    if (!target) return
    target.setItem(
      threadDraftsStorageKey(workspaceId),
      serializeThreadDrafts(drafts)
    )
  } catch {
    // Memory remains authoritative for this tab when storage is unavailable
    // or the browser quota has been exhausted.
  }
}

export function clearPersistedThreadDrafts(
  workspaceId: string,
  storage?: SessionStorageLike
): void {
  try {
    const target =
      storage ??
      (typeof window === "undefined" ? undefined : window.sessionStorage)
    target?.removeItem(threadDraftsStorageKey(workspaceId))
    const legacy = `${THREAD_DRAFTS_STORAGE_KEY}:${encodeURIComponent(workspaceId)}`
    target?.removeItem(legacy)
    if (!storage && typeof window !== "undefined") {
      for (const key of Object.keys(window.sessionStorage))
        if (key.startsWith(`${legacy}:`)) window.sessionStorage.removeItem(key)
    }
  } catch {
    // Replacement still proceeds when storage is blocked or unavailable.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(THREAD_DRAFTS_CLEARED_EVENT, {
        detail: { workspaceId },
      })
    )
  }
}

export function onThreadDraftsCleared(
  workspaceId: string,
  listener: () => void
): () => void {
  if (typeof window === "undefined") return () => undefined
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<{ workspaceId?: string }>).detail
    if (detail?.workspaceId === workspaceId) listener()
  }
  window.addEventListener(THREAD_DRAFTS_CLEARED_EVENT, handle)
  return () => window.removeEventListener(THREAD_DRAFTS_CLEARED_EVENT, handle)
}

export function setThreadDraft(
  drafts: ThreadDraftCollection,
  draft: ThreadDraftState
): ThreadDraftCollection {
  return pruneThreadDrafts({ ...drafts, [draft.key]: draft })
}

export function removeThreadDraft(
  drafts: ThreadDraftCollection,
  key: string
): ThreadDraftCollection {
  if (!(key in drafts)) return drafts
  const next = { ...drafts }
  delete next[key]
  return next
}
