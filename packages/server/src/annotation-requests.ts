// ============================================================
// Who a comment is waiting on
// ============================================================
//
// A comment can be sent to people and agents. Each recipient has a request:
// open until they reply, then replied. When someone else replies after that,
// the recipient is asked again with a new request, so the conversation on the
// comment keeps reaching them. Agents never ask again by replying, which keeps
// two agents from answering each other without end.

import { nanoid } from "nanoid"
import type { AnnotationRecipient, AnnotationRequest } from "@worktable/types"

/** Whoever is replying, as a Threads participant. */
export interface CommentReplier {
  participantId: string
  kind: "human" | "agent" | "system"
}

function request(to: AnnotationRecipient, now: string): AnnotationRequest {
  return { id: `req_${nanoid(12)}`, to, status: "open", createdAt: now }
}

/** Requests for each recipient that has no open one yet. */
export function addRequests(
  requests: readonly AnnotationRequest[],
  to: readonly AnnotationRecipient[],
  now: string
): AnnotationRequest[] {
  const next = [...requests]
  for (const recipient of to) {
    const waiting = next.some(
      (existing) => existing.to.id === recipient.id && existing.status === "open"
    )
    if (!waiting) next.push(request(recipient, now))
  }
  return next
}

/**
 * Requests after a reply. The replier's own open requests are replied. A
 * person's reply asks again everyone who has replied before; an agent's reply
 * asks nobody again by itself. Recipients a reply names are asked either way.
 */
export function requestsAfterReply(
  requests: readonly AnnotationRequest[],
  replier: CommentReplier | undefined,
  replyId: string,
  now: string,
  to: readonly AnnotationRecipient[] = []
): AnnotationRequest[] {
  const closed = requests.map((existing) =>
    replier &&
    existing.status === "open" &&
    existing.to.id === replier.participantId
      ? { ...existing, status: "replied" as const, closedAt: now, replyId }
      : existing
  )
  const named = to.filter((recipient) => recipient.id !== replier?.participantId)
  if (replier?.kind !== "human") return addRequests(closed, named, now)
  const latest = new Map<string, AnnotationRequest>()
  for (const existing of closed) latest.set(existing.to.id, existing)
  const again = [...latest.values()]
    .filter(
      (existing) =>
        existing.status === "replied" &&
        existing.to.id !== replier.participantId
    )
    .map((existing) => existing.to)
  return addRequests(closed, [...again, ...named], now)
}
