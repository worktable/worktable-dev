// ============================================================
// Pending: what is waiting on the person reading Home
// ============================================================
//
// Only what is addressed to the reader: thread messages assigned to them,
// comments sent to them, their messages that could not be delivered, visitor
// comments on links they can answer, and their own comments that someone has
// answered since they last wrote. Work sent to their agents is the agents' to
// do, and an agent's reply that asks nothing is not a request. Each source is
// read only when the reader has the scope that would let them open it.

import type { PendingItem, PendingResult, SpaceFile } from "@worktable/types"
import { readDocumentIdentities } from "./document-query.ts"
import { resolveParticipant } from "./participant-store.ts"
import { answeredFor, pendingFor } from "./pending-list.ts"
import { canAccessSpace } from "./team-policy.ts"
import { getSpaceArchiveInfo, listSpaces } from "./store.ts"
import {
  listPendingThreadWork,
  type ViewerDeliveryFailure,
  type ViewerThreadRequest,
} from "./thread-service.ts"
import { hasScope, type TokenIdentity } from "./token-store.ts"
import { pendingVisitorComments } from "./visitor-comment-pending.ts"

export const PENDING_LIMIT = 10

/** Everything waiting on the reader, or only what belongs to one Space. */
export async function listPending(
  identity: TokenIdentity,
  spaceId?: string,
  visitorAccess?: (spaceId: string) => boolean,
  limit = PENDING_LIMIT
): Promise<PendingResult> {
  const canReadThreads = hasScope(identity.scopes, "threads:read")
  // People write comments; a comment sent to an agent waits in its own list.
  const canReadAnnotations =
    identity.principal.type === "human" &&
    hasScope(identity.scopes, "annotations:read")
  if (!canReadThreads && !canReadAnnotations && !visitorAccess) {
    return { items: [], total: 0 }
  }
  const spaces = await listSpaces()
  const [threadWork, comments, answered] = await Promise.all([
    canReadThreads
      ? listPendingThreadWork(identity, spaces, spaceId)
      : { requests: [], failures: [] },
    canReadAnnotations ? commentRequests(spaces, spaceId, identity) : [],
    canReadAnnotations ? answeredComments(spaces, spaceId, identity) : [],
  ])
  const all = [
    ...threadRequests(threadWork.requests),
    ...failedDeliveries(threadWork.failures),
    ...comments,
    ...answered,
    // The private inbox is auxiliary to ordinary team work on Home.
    ...(visitorAccess
      ? await pendingVisitorComments(identity, spaces, spaceId, visitorAccess).catch(() => [])
      : []),
  ]
    .filter((item) => !spaceId || item.spaceId === spaceId)
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  return { items: all.slice(0, limit), total: all.length }
}

function threadRequests(requests: ViewerThreadRequest[]): PendingItem[] {
  return requests.map((request) => ({
    kind: "threadRequest",
    id: `thread:${request.threadId}:${request.messageId}`,
    at: request.createdAt,
    spaceId:
      request.location.kind === "space" ? request.location.spaceId : null,
    threadId: request.threadId,
    threadTitle: request.threadTitle,
    messageId: request.messageId,
    from: {
      kind: request.author.kind === "human" ? "person" : request.author.kind,
      id: request.author.id,
      name: request.author.name,
    },
    ...(request.authorIdentityId ? { fromIdentityId: request.authorIdentityId } : {}),
    excerpt: request.excerpt,
  }))
}

/** Comments sent to the reader. */
async function commentRequests(
  allSpaces: SpaceFile[],
  spaceId: string | undefined,
  identity: TokenIdentity
): Promise<PendingItem[]> {
  const reader = (await resolveParticipant(identity)).participant
  const entries = await pendingFor(reader.id)
  const active = new Set(
    allSpaces
      .filter((space) => (spaceId ? space.id === spaceId : !getSpaceArchiveInfo(space)))
      .map((space) => space.id)
  )
  const waiting = entries.flatMap((entry) =>
    entry.source.kind === "comment" &&
    active.has(entry.source.spaceId) &&
    canAccessSpace(entry.source.spaceId, "read", identity)
      ? [{ entry, source: entry.source }]
      : []
  )
  const documents = new Map(
    await Promise.all(
      [...new Set(waiting.map(({ source }) => source.spaceId))].map(
        async (id) =>
          [id, (await readDocumentIdentities(id).catch(() => null))?.identities] as const
      )
    )
  )
  return waiting.flatMap(({ entry, source }): PendingItem[] => {
    const current = source.documentId
      ? documents.get(source.spaceId)?.current.get(source.documentId)
      : undefined
    // A Doc that no longer opens has nothing to show.
    if (source.documentId && !current) return []
    return [
      {
        kind: "commentRequest",
        id: `comment-request:${entry.itemId}`,
        at: entry.createdAt,
        spaceId: source.spaceId,
        annotationId: source.annotationId,
        docPath: current?.path ?? source.path,
        ...(current?.title ? { docTitle: current.title } : {}),
        from: source.from,
        excerpt: source.excerpt,
        ...(source.quote ? { quote: source.quote } : {}),
      },
    ]
  })
}

/**
 * Docs where someone answered the reader's comments, one item per Doc. The
 * answer asks nothing of them, but the comment is theirs and it is back with
 * them until they answer it or resolve it.
 */
async function answeredComments(
  allSpaces: SpaceFile[],
  spaceId: string | undefined,
  identity: TokenIdentity
): Promise<PendingItem[]> {
  const reader = (await resolveParticipant(identity)).participant
  const active = new Set(
    allSpaces
      .filter((space) => (spaceId ? space.id === spaceId : !getSpaceArchiveInfo(space)))
      .map((space) => space.id)
  )
  // Without Teams there is one person, so every person's comment is theirs.
  // On a team, a comment names its author by their member or participant id.
  const mine = identity.team ? new Set([reader.id, identity.principal.id]) : null
  const answered = (await answeredFor((id) => !mine || mine.has(id))).filter(
    (comment) =>
      active.has(comment.spaceId) && canAccessSpace(comment.spaceId, "read", identity)
  )
  const documents = new Map(
    await Promise.all(
      [...new Set(answered.map((comment) => comment.spaceId))].map(
        async (id) =>
          [id, (await readDocumentIdentities(id).catch(() => null))?.identities] as const
      )
    )
  )
  const byDoc = new Map<string, Extract<PendingItem, { kind: "answered" }>>()
  // Newest first, so each Doc's item takes its newest answer's time.
  for (const comment of answered) {
    const current = comment.documentId
      ? documents.get(comment.spaceId)?.current.get(comment.documentId)
      : undefined
    // A Doc that no longer opens has nothing to show.
    if (comment.documentId && !current) continue
    const docPath = current?.path ?? comment.path
    const key = `${comment.spaceId}\0${comment.documentId ?? docPath}`
    const item = byDoc.get(key)
    if (item) {
      item.annotationIds.push(comment.annotationId)
      if (!item.by.some((actor) => actor.id === comment.by.id)) item.by.push(comment.by)
      continue
    }
    byDoc.set(key, {
      kind: "answered",
      id: `answered:${comment.spaceId}:${comment.documentId ?? docPath}`,
      at: comment.at,
      spaceId: comment.spaceId,
      docPath,
      ...(current?.title ? { docTitle: current.title } : {}),
      annotationIds: [comment.annotationId],
      by: [comment.by],
    })
  }
  return [...byDoc.values()]
}

function failedDeliveries(failures: ViewerDeliveryFailure[]): PendingItem[] {
  return failures.map((failure) => ({
    kind: "deliveryFailed",
    id: `delivery:${failure.threadId}:${failure.activity.messageId}`,
    at: failure.activity.updatedAt,
    spaceId:
      failure.location.kind === "space" ? failure.location.spaceId : null,
    threadId: failure.threadId,
    threadTitle: failure.threadTitle,
    agentName: failure.recipientName ?? "the agent",
  }))
}
