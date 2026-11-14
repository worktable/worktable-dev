// ============================================================
// Pending: what is waiting on the person reading Home
// ============================================================
//
// Only what is addressed to the reader: thread messages assigned to them,
// comments sent to them, their messages that could not be delivered,
// visitor comments on links they can answer, and agents' proposed skill
// library changes they may approve. Work sent to their agents is the
// agents' to do, and an agent's reply that asks nothing is not a request.
// Each source is read only when the reader has the scope that would let them
// open it.

import { configuredMcpSurface } from "./mcp/surface.ts"
import type { PendingItem, PendingResult, SpaceFile } from "@worktable/types"
import { readDocumentIdentities } from "./document-query.ts"
import { resolveParticipant } from "./participant-store.ts"
import { pendingFor } from "./pending-list.ts"
import { canAccessSpace } from "./team-policy.ts"
import { isPerson, pendingSkillProposals } from "./skill-libraries.ts"
import { getSpaceArchiveInfo, listSpaces } from "./store.ts"
import {
  listPendingThreadWork,
  type ViewerDeliveryFailure,
  type ViewerThreadRequest,
} from "./thread-service.ts"
import { hasScope, type TokenIdentity } from "./token-store.ts"
import { pendingVisitorComments } from "./visitor-comment-pending.ts"

const PENDING_LIMIT = 10

/** Everything waiting on the reader, or only what belongs to one Space. */
export async function listPending(
  identity: TokenIdentity,
  spaceId?: string,
  visitorAccess?: (spaceId: string) => boolean
): Promise<PendingResult> {
  const canReadThreads = hasScope(identity.scopes, "threads:read")
  // People write comments; a comment sent to an agent waits in its own list.
  const canReadAnnotations =
    identity.principal.type === "human" &&
    hasScope(identity.scopes, "annotations:read")
  const canReviewSkills = isPerson(identity) && configuredMcpSurface() === "preview"
  if (!canReadThreads && !canReadAnnotations && !visitorAccess && !canReviewSkills) {
    return { items: [], total: 0 }
  }
  const spaces = await listSpaces()
  const [threadWork, comments, skills] = await Promise.all([
    canReadThreads
      ? listPendingThreadWork(identity, spaces, spaceId)
      : { requests: [], failures: [] },
    canReadAnnotations ? commentRequests(spaces, spaceId, identity) : [],
    canReviewSkills ? pendingSkillProposals(identity, spaceId) : [],
  ])
  const all = [
    ...threadRequests(threadWork.requests),
    ...failedDeliveries(threadWork.failures),
    ...comments,
    // The private inbox is auxiliary to ordinary team work on Home.
    ...(visitorAccess
      ? await pendingVisitorComments(identity, spaces, spaceId, visitorAccess).catch(() => [])
      : []),
  ]
    .filter((item) => !spaceId || item.spaceId === spaceId)
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  // Skill proposals come after the rows Home shows, so they never push one
  // out, and Home counts them on their own.
  return {
    items: [
      ...all.slice(0, PENDING_LIMIT),
      ...skills.sort((a, b) => b.at.localeCompare(a.at)),
    ],
    total: all.length,
  }
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
      },
    ]
  })
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
