import type { Context } from "hono"
import type {
  DocumentId,
  VisitorComment,
  SharingPolicy,
  DocumentSharingSummary,
} from "@worktable/types"
import { isHumanWorkspaceOwner } from "./auth.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import {
  DocumentSpaceNotFoundError,
  readDocumentIdentities,
} from "./document-query.ts"
import { authorizeShareAction, currentSharingPolicy } from "./share-policy.ts"
import { teamsEnabled } from "./team-database.ts"
import { canAccessSpace, requireTeamHuman } from "./team-policy.ts"
import type { TokenIdentity } from "./token-store.ts"
import { getWorkspaceRoot, prepareWorkspaceTarget } from "./workspace.ts"
import {
  visitorReplies,
  visitorCommentCounts,
  visitorCommentPauses,
  VisitorCommentsUnavailable,
  type StoredVisitorComment,
  type VisitorCommentRetentionChange,
} from "./visitor-comment-store.ts"
import { wsManager } from "./ws.ts"
import { documentHasCommentLink, type StoredShareLink } from "./share-links-store.ts"

/** Caller has admitted a person to these links. Reads no private text. */
export async function commentPausesForLinks(
  links: readonly StoredShareLink[]
): Promise<Map<string, string>> {
  const comments = links.filter((link) => link.level === "comment")
  if (!comments.length) return new Map()
  try {
    const context = await visitorCommentNamespace()
    if (!(await visitorNamespaceStillCurrent(context))) return new Map()
    return visitorCommentPauses(
      context.worktableId,
      comments.map((link) => link.id)
    )
  } catch {
    // Private metadata must not prevent ordinary share-link management.
    return new Map()
  }
}

/** Called while the page holds its document namespace lock. Reads no text. */
export async function visitorCommentPageSummary(c: Context, spaceId: string, documentId: string): Promise<DocumentSharingSummary["visitorComments"]> {
  if (!visitorCommentReader(c, spaceId)) return undefined
  try {
    const context = await visitorCommentNamespace()
    if (!(await visitorDocumentInSpace(spaceId, documentId, { lockHeld: true })) || !(await visitorNamespaceStillCurrent(context)) || !visitorCommentReader(c, spaceId)) return undefined
    const counts = visitorCommentCounts(context.worktableId, documentId)
    return {documentId, newCount: counts.newCount, available: counts.total > 0 || documentHasCommentLink(spaceId, documentId)}
  } catch {
    // An unavailable private store must not stop the ordinary document opening.
    return undefined
  }
}

/** Only opaque identifiers cross this person-only socket boundary. */
export function notifyVisitorComments(
  spaceId: string,
  documentId: string,
  linkId: string
): void {
  wsManager.sendToPeopleWithAccess(spaceId, {
    type: "visitor_comments_changed",
    spaceId,
    data: { documentId, linkId },
  })
}

/** Background retention publishes only committed identifiers for current docs. */
export async function notifyRetainedVisitorComments(
  changes: readonly VisitorCommentRetentionChange[]
): Promise<void> {
  if (!changes.length) return
  const context = await visitorCommentNamespace()
  const spaces = new Map<string, VisitorCommentRetentionChange[]>()
  for (const change of changes) {
    if (change.worktableId !== context.worktableId) continue
    const rows = spaces.get(change.spaceId) ?? []
    rows.push(change)
    spaces.set(change.spaceId, rows)
  }
  for (const [spaceId, rows] of spaces) {
    let snapshot: Awaited<ReturnType<typeof readDocumentIdentities>>
    try {
      snapshot = await readDocumentIdentities(spaceId)
    } catch (error) {
      if (error instanceof DocumentSpaceNotFoundError) continue
      throw error
    }
    const { identities } = snapshot
    if (!(await visitorNamespaceStillCurrent(context))) return
    if (identities.spaceArchived) continue
    for (const row of rows)
      if (identities.current.has(row.documentId as DocumentId))
        notifyVisitorComments(spaceId, row.documentId, row.linkId)
  }
}

/** This is a person boundary, never a scope that an agent can acquire. */
export function visitorCommentReader(c: Context, spaceId: string): boolean {
  const identity = c.get("identity") as TokenIdentity | undefined
  if (
    !identity ||
    identity.agent !== null ||
    identity.operatorVerification ||
    identity.principal.type !== "human"
  )
    return false
  if (!teamsEnabled()) return isHumanWorkspaceOwner(c)
  try {
    requireTeamHuman(identity)
    return canAccessSpace(spaceId, "edit", identity)
  } catch {
    return false
  }
}

interface VisitorNamespace {
  root: string
  epoch: string
  worktableId: string
}
let namespace: VisitorNamespace | null = null
let loading: {
  root: string
  epoch: string
  value: Promise<VisitorNamespace>
} | null = null
/** One cold manifest read per workspace boot/replacement, never a GET write. */
export async function visitorCommentNamespace(): Promise<VisitorNamespace> {
  const root = getWorkspaceRoot()
  const epoch = await getWorkspaceCollaborationEpoch()
  if (namespace?.root === root && namespace.epoch === epoch) return namespace
  if (loading?.root === root && loading.epoch === epoch) return loading.value
  const entry = {
    root,
    epoch,
    value: Promise.resolve(null) as unknown as Promise<VisitorNamespace>,
  }
  entry.value = Promise.resolve()
    .then(async () => {
      const worktableId = prepareWorkspaceTarget(root, "open").manifest.id
      if (!(await visitorNamespaceStillCurrent(entry)))
        throw new VisitorCommentsUnavailable()
      namespace = { root, epoch, worktableId }
      return namespace
    })
    .finally(() => {
      if (loading === entry) loading = null
    })
  loading = entry
  return entry.value
}
export async function visitorNamespaceStillCurrent(value: {
  root: string
  epoch: string
}): Promise<boolean> {
  return (
    (await getWorkspaceCollaborationEpoch()) === value.epoch &&
    getWorkspaceRoot() === value.root
  )
}
/** The receipt's Space is history. Resolve access against the document now. */
export async function visitorDocumentInSpace(
  spaceId: string,
  documentId: string,
  options: { lockHeld?: boolean } = {}
): Promise<boolean> {
  const { identities } = await readDocumentIdentities(spaceId, options)
  return (
    !identities.spaceArchived &&
    identities.current.has(documentId as DocumentId)
  )
}
export function canDeleteVisitorComment(
  c: Context,
  spaceId: string,
  row: StoredVisitorComment,
  policy?: SharingPolicy
): boolean {
  return (
    visitorCommentReader(c, spaceId) &&
    authorizeShareAction(c.get("identity"), "manage", spaceId, {
      creatorId: row.link_creator,
      ...(policy ? { policy } : {}),
    }).allowed
  )
}
export function memberVisitorComments(
  c: Context,
  spaceId: string,
  rows: StoredVisitorComment[],
  policy = currentSharingPolicy()
): VisitorComment[] {
  if (!rows.length) return []
  const deletions = new Map<string, boolean>()
  for (const row of rows)
    if (!deletions.has(row.link_creator))
      deletions.set(
        row.link_creator,
        canDeleteVisitorComment(c, spaceId, row, policy)
      )
  const replies = visitorReplies(rows.map((row) => row.id))
  return rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    linkId: row.link_id,
    linkLabel: row.link_label,
    visitorName: row.visitor_name,
    body: row.body,
    receivedAt: new Date(row.received_at).toISOString(),
    status: row.status,
    replies: replies
      .filter((reply) => reply.comment_id === row.id)
      .map((reply) => ({
        id: reply.id,
        author: { id: reply.author_id, name: reply.author_name },
        body: reply.body,
        createdAt: new Date(reply.created_at).toISOString(),
      })),
    passed:
      row.annotation_id && row.passed_by && row.passed_at
        ? {
            by: { id: row.passed_by, name: row.passed_name ?? "Team member" },
            at: new Date(row.passed_at).toISOString(),
            annotationId: row.annotation_id,
          }
        : null,
    canDelete: deletions.get(row.link_creator)!,
  }))
}
