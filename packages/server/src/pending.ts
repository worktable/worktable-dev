// ============================================================
// Pending: what is waiting on the person reading Home
// ============================================================
//
// Thread messages assigned to them, agent replies on their open comments, and
// their messages that could not be delivered. Each source is read only when
// the reader has the scope that would let them open it.

import type { Annotation, PendingItem, PendingResult } from "@worktable/types"
import { listAnnotations } from "./annotation-store.ts"
import { listDocuments } from "./document-query.ts"
import { getSpaceArchiveInfo, listSpaces } from "./store.ts"
import {
  listFailedDeliveriesForViewer,
  listOpenRequestsForViewer,
} from "./thread-service.ts"
import { hasScope, type TokenIdentity } from "./token-store.ts"

const PENDING_LIMIT = 10

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= 160 ? flat : `${flat.slice(0, 159).trimEnd()}…`
}

/** Everything waiting on the reader, or only what belongs to one Space. */
export async function listPending(
  identity: TokenIdentity,
  spaceId?: string
): Promise<PendingResult> {
  const canReadThreads = hasScope(identity.scopes, "threads:read")
  // People write comments as the "user" author; agents never do, so replies
  // to "your" comments are only meaningful for a person.
  const canReadAnnotations =
    identity.principal.type === "human" &&
    hasScope(identity.scopes, "annotations:read")
  const [requests, failures, replies] = await Promise.all([
    canReadThreads ? threadRequests(identity, spaceId) : [],
    canReadThreads ? failedDeliveries(identity, spaceId) : [],
    canReadAnnotations ? commentReplies(spaceId) : [],
  ])
  const items = [...requests, ...failures, ...replies]
    .filter((item) => !spaceId || item.spaceId === spaceId)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, PENDING_LIMIT)
  return { items }
}

async function threadRequests(
  identity: TokenIdentity,
  spaceId?: string
): Promise<PendingItem[]> {
  return (await listOpenRequestsForViewer(identity, spaceId)).map(
    (request) => ({
      kind: "threadRequest",
      id: `thread:${request.threadId}:${request.message.id}`,
      at: request.message.createdAt,
      spaceId:
        request.location.kind === "space" ? request.location.spaceId : null,
      threadId: request.threadId,
      threadTitle: request.threadTitle,
      messageId: request.message.id,
      from: {
        kind: request.author.kind === "human" ? "person" : request.author.kind,
        id: request.author.id,
        name: request.author.name,
      },
      excerpt: excerpt(request.message.body),
    })
  )
}

async function failedDeliveries(
  identity: TokenIdentity,
  spaceId?: string
): Promise<PendingItem[]> {
  return (await listFailedDeliveriesForViewer(identity, spaceId)).map(
    (failure) => ({
      kind: "deliveryFailed",
      id: `delivery:${failure.threadId}:${failure.activity.messageId}`,
      at: failure.activity.updatedAt,
      spaceId:
        failure.location.kind === "space" ? failure.location.spaceId : null,
      threadId: failure.threadId,
      threadTitle: failure.threadTitle,
      agentName: failure.recipientName ?? "the agent",
    })
  )
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
async function commentReplies(spaceId?: string): Promise<PendingItem[]> {
  const spaces = (await listSpaces()).filter((space) =>
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
