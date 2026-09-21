import { threadLocationKey, type ThreadLocation } from "@worktable/types"

export interface ThreadSubmissionIdentity {
  fingerprint: string
  idempotencyKey: string
}

export interface ThreadDraftState {
  key: string
  value: string
  recipientId?: string
  notifyIdentityIds?: string[]
  responseIdentityId?: string | null
  replyTo?: string
  responseTo?: string | null
  submission?: ThreadSubmissionIdentity
  updatedAt: number
}

interface CompletedThreadSubmission {
  key: string
  body: string
  submission: ThreadSubmissionIdentity
}

/**
 * An async send may finish after the user edits the composer or navigates to
 * another thread. Only clear the exact draft that started the completed send.
 */
export function clearCompletedThreadDraft(
  current: ThreadDraftState,
  completed: CompletedThreadSubmission
): ThreadDraftState {
  if (
    current.key !== completed.key ||
    current.value.trim() !== completed.body ||
    current.submission?.idempotencyKey !==
      completed.submission.idempotencyKey ||
    current.submission.fingerprint !== completed.submission.fingerprint
  ) {
    return current
  }

  return { key: current.key, value: "", updatedAt: current.updatedAt }
}

export function threadDraftKey(
  location: ThreadLocation,
  threadId: string
): string {
  return `${threadLocationKey(location)}:${threadId || "@new"}`
}

/**
 * Keep one request identity for an unchanged draft. A lost HTTP response can
 * then be retried without creating another durable message.
 */
export function retainThreadSubmission(
  current: ThreadSubmissionIdentity | undefined,
  fingerprint: string,
  createIdempotencyKey: () => string
): ThreadSubmissionIdentity {
  if (current?.fingerprint === fingerprint) return current
  return {
    fingerprint,
    idempotencyKey: createIdempotencyKey(),
  }
}
