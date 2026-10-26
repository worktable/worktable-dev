// ============================================================
// Pending: what is waiting on the person reading Home
// ============================================================
//
// Thread messages assigned to them, comments sent to them or to their agents,
// agent replies on their open comments, and their messages that could not be
// delivered. Each source is read only when the reader has the scope that
// would let them open it.

import type {
  Annotation,
  PendingItem,
  PendingResult,
  SpaceFile,
} from "@worktable/types"
import { listAnnotations } from "./annotation-store.ts"
import { listDocuments, readDocumentIdentities } from "./document-query.ts"
import { participantsByKey, resolveParticipant } from "./participant-store.ts"
import { pendingFor, type PendingEntry } from "./pending-list.ts"
import { teamsEnabled } from "./team-database.ts"
import {
  canAccessSpace,
  teamAgentForParticipantKey,
  teamMemberForIdentity,
} from "./team-policy.ts"
import { getSpaceArchiveInfo, listSpaces } from "./store.ts"
import {
  listPendingThreadWork,
  type ViewerDeliveryFailure,
  type ViewerThreadRequest,
} from "./thread-service.ts"
import { hasScope, type TokenIdentity } from "./token-store.ts"
import { pendingVisitorComments } from "./visitor-comment-pending.ts"

const PENDING_LIMIT = 10

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= 160 ? flat : `${flat.slice(0, 159).trimEnd()}…`
}

/** Everything waiting on the reader, or only what belongs to one Space. */
export async function listPending(
  identity: TokenIdentity,
  spaceId?: string,
  visitorAccess?: (spaceId: string) => boolean
): Promise<PendingResult> {
  const canReadThreads = hasScope(identity.scopes, "threads:read")
  // People write comments as the "user" author; agents never do, so replies
  // to "your" comments are only meaningful for a person.
  const canReadAnnotations =
    identity.principal.type === "human" &&
    hasScope(identity.scopes, "annotations:read")
  if (!canReadThreads && !canReadAnnotations && !visitorAccess) return { items: [] }
  const spaces = await listSpaces()
  const [threadWork, replies, comments] = await Promise.all([
    canReadThreads
      ? listPendingThreadWork(identity, spaces, spaceId)
      : { requests: [], failures: [] },
    canReadAnnotations ? commentReplies(spaces, spaceId, identity) : [],
    canReadAnnotations ? commentRequests(spaces, spaceId, identity) : [],
  ])
  // A reply that asks the reader is already a request; one row says both.
  const asked = new Set(
    comments.flatMap((item) =>
      item.kind === "commentRequest" && !item.agent ? [item.annotationId] : []
    )
  )
  const items = [
    ...threadRequests(threadWork.requests),
    ...failedDeliveries(threadWork.failures),
    ...comments,
    ...replies.filter(
      (item) => item.kind !== "commentReply" || !asked.has(item.annotationId)
    ),
    // The private inbox is auxiliary to ordinary team work on Home.
    ...(visitorAccess
      ? await pendingVisitorComments(identity, spaces, spaceId, visitorAccess).catch(() => [])
      : []),
  ]
    .filter((item) => !spaceId || item.spaceId === spaceId)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, PENDING_LIMIT)
  return { items }
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

/** The reader's own agents, by participant: every agent without Teams. */
async function ownAgents(identity: TokenIdentity): Promise<Map<string, string>> {
  const agents = new Map<string, string>()
  if (identity.principal.type !== "human") return agents
  const member = teamsEnabled() ? teamMemberForIdentity(identity) : null
  if (teamsEnabled() && !member) return agents
  for (const [key, participant] of await participantsByKey()) {
    if (participant.kind !== "agent") continue
    if (member) {
      const agent = teamAgentForParticipantKey(key)
      if (agent?.ownership !== "personal" || agent.memberId !== member.id) continue
    }
    agents.set(participant.id, participant.name)
  }
  return agents
}

/** Comments sent to the reader, or to their agents by someone else. */
async function commentRequests(
  allSpaces: SpaceFile[],
  spaceId: string | undefined,
  identity: TokenIdentity
): Promise<PendingItem[]> {
  const reader = (await resolveParticipant(identity)).participant
  const agents = await ownAgents(identity)
  const ownComment = (entry: PendingEntry) =>
    entry.source.from.kind === "person" &&
    (entry.source.from.id === identity.principal.id ||
      (!identity.team && entry.source.from.id === "user"))
  const entries = [
    ...(await pendingFor(reader.id)),
    ...(
      await Promise.all([...agents.keys()].map((agent) => pendingFor(agent)))
    )
      .flat()
      .filter((entry) => !ownComment(entry)),
  ]
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
    const agent = agents.get(entry.recipient.participantId)
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
        ...(agent ? { agent: { name: agent } } : {}),
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

/** Every open annotation in a Space, a page at a time. */
async function openAnnotations(spaceId: string): Promise<Annotation[]> {
  const all: Annotation[] = []
  let offset: number | undefined = 0
  while (offset !== undefined) {
    const page = await listAnnotations(spaceId, {
      status: ["open"],
      limit: 500,
      offset,
    })
    all.push(...page.annotations)
    offset = page.nextOffset
  }
  return all
}

/** An agent answered a comment you left, and the comment is still open. */
async function commentReplies(
  allSpaces: SpaceFile[],
  spaceId: string | undefined,
  identity: TokenIdentity
): Promise<PendingItem[]> {
  const spaces = allSpaces.filter((space) =>
    spaceId ? space.id === spaceId : !getSpaceArchiveInfo(space)
  )
  const perSpace = await Promise.all(
    spaces.map(async (space) => {
      const annotations = await openAnnotations(space.id).catch(() => [])
      const answered = annotations.flatMap((annotation) => {
        const last = annotation.thread.at(-1)
        const target = annotation.target
        const docPath =
          target.type === "widget"
            ? target.widgetId
            : "docPath" in target
              ? target.docPath
              : null
        if (
          annotation.author.type !== "user" ||
          (identity.team && annotation.author.id !== identity.principal.id &&
            !(identity.principal.id === "local:owner" && annotation.author.id === "user")) ||
          last?.author.type !== "agent" ||
          !docPath
        ) {
          return []
        }
        return [{ annotation, last, docPath }]
      })
      if (answered.length === 0) return []
      const titles = new Map(
        (await listDocuments({ spaceId: space.id }).catch(() => [])).flatMap(
          (item) => (item.kind === "document" ? [[item.path, item.title]] : [])
        )
      )
      return answered.map(
        ({ annotation, last, docPath }): PendingItem => ({
          kind: "commentReply",
          id: `comment:${space.id}:${annotation.id}:${last.id}`,
          at: last.createdAt,
          spaceId: space.id,
          annotationId: annotation.id,
          docPath,
          ...(titles.get(docPath) ? { docTitle: titles.get(docPath)! } : {}),
          from: {
            kind: "agent",
            id: last.author.id,
            ...(last.author.name ? { name: last.author.name } : {}),
          },
          excerpt: excerpt(last.body),
        })
      )
    })
  )
  return perSpace.flat()
}
