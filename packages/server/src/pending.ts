// ============================================================
// Pending: what is waiting on the person reading Home
// ============================================================
//
// Thread messages assigned to them, agent replies on their open comments, and
// their messages that could not be delivered. Each source is read only when
// the reader has the scope that would let them open it.

import type { PendingItem, PendingResult } from "@worktable/types"
import { listAnnotations } from "./annotation-store.ts"
import { listDocuments } from "./document-query.ts"
import { getSpaceArchiveInfo, listSpaces } from "./store.ts"
import {
  listOpenRequestsForViewer,
  listThreadSummaries,
} from "./thread-service.ts"
import { hasScope, type TokenIdentity } from "./token-store.ts"

const PENDING_LIMIT = 10

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= 160 ? flat : `${flat.slice(0, 159).trimEnd()}…`
}

export async function listPending(
  identity: TokenIdentity
): Promise<PendingResult> {
  const canReadThreads = hasScope(identity.scopes, "threads:read")
  const canReadAnnotations = hasScope(identity.scopes, "annotations:read")
  const [requests, failures, replies] = await Promise.all([
    canReadThreads ? threadRequests(identity) : [],
    canReadThreads ? failedDeliveries(identity) : [],
    canReadAnnotations ? commentReplies() : [],
  ])
  const items = [...requests, ...failures, ...replies]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, PENDING_LIMIT)
  return { items }
}

async function threadRequests(identity: TokenIdentity): Promise<PendingItem[]> {
  return (await listOpenRequestsForViewer(identity)).map((request) => ({
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
  }))
}

async function failedDeliveries(
  identity: TokenIdentity
): Promise<PendingItem[]> {
  const summaries = await listThreadSummaries(
    identity,
    undefined,
    undefined,
    "failed"
  )
  return summaries.flatMap((summary) => {
    const activity = summary.activity
    if (!activity) return []
    const location = summary.location
    const agentName =
      summary.identities.find((candidate) => candidate.id === activity.identityId)
        ?.name ??
      summary.members.find((member) => member.id === activity.participantId)
        ?.name ??
      "the agent"
    return [
      {
        kind: "deliveryFailed",
        id: `delivery:${summary.id}:${activity.messageId}`,
        at: activity.updatedAt,
        spaceId: location.kind === "space" ? location.spaceId : null,
        threadId: summary.id,
        threadTitle: summary.title,
        agentName,
      },
    ]
  })
}

/** An agent answered a comment you left, and the comment is still open. */
async function commentReplies(): Promise<PendingItem[]> {
  const spaces = (await listSpaces()).filter(
    (space) => !getSpaceArchiveInfo(space)
  )
  const perSpace = await Promise.all(
    spaces.map(async (space) => {
      const { annotations } = await listAnnotations(space.id, {
        status: ["open"],
        limit: 500,
      }).catch(() => ({ annotations: [] }))
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
