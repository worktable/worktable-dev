import type { PendingItem, SpaceFile } from "@worktable/types"
import {
  DocumentSpaceNotFoundError,
  readDocumentIdentities,
} from "./document-query.ts"
import { getSpaceArchiveInfo } from "./store.ts"
import { accessSnapshot, levelAtLeast, memberLevel } from "./team-access.ts"
import { canAccessSpace } from "./team-policy.ts"
import { sharerOf } from "./share-policy.ts"
import { commentLinkTargets } from "./share-links-store.ts"
import type { TokenIdentity } from "./token-store.ts"
import {
  visitorCommentNamespace,
  visitorNamespaceStillCurrent,
} from "./visitor-comment-access.ts"
import { pendingVisitorCommentGroups } from "./visitor-comment-store.ts"

/** Called only after the HTTP person boundary; scopes alone never admit it. */
export async function pendingVisitorComments(
  identity: TokenIdentity,
  spaces: SpaceFile[],
  spaceId: string | undefined,
  mayRead: (spaceId: string) => boolean
): Promise<PendingItem[]> {
  if (
    identity.agent !== null ||
    identity.principal.type !== "human" ||
    identity.operatorVerification
  )
    return []
  const namespace = await visitorCommentNamespace()
  const groups = pendingVisitorCommentGroups(namespace.worktableId)
  if (!groups.length) return []
  const commentLinks = commentLinkTargets(
    groups
      .filter((group) => group.paused === "spike")
      .map((group) => group.link_id)
  )
  const resumable = (group: (typeof groups)[number]) => {
    const link = commentLinks.get(group.link_id)
    return (
      group.paused === "spike" &&
      link?.spaceId === group.space_at_receipt &&
      link.documentId === group.document_id
    )
  }
  const eligible = spaces.filter(
    (space) =>
      (!spaceId || space.id === spaceId) &&
      !getSpaceArchiveInfo(space) &&
      mayRead(space.id)
  )
  // Supported document moves stay within a Space. The receipt is only a
  // location hint: the current catalog must still contain this durable id.
  // Never open unrelated Spaces merely because this person has one comment.
  const eligibleIds = new Set(eligible.map((space) => space.id))
  const snapshots = new Map<
    string,
    Awaited<ReturnType<typeof readDocumentIdentities>> | null
  >()
  const candidates: Array<{
    group: (typeof groups)[number]
    document: { spaceId: string; path: string; title: string }
  }> = []
  const belongs = (group: (typeof groups)[number], currentSpace: string) => {
    if (group.link_creator === sharerOf(identity).id) return true
    const snapshot = accessSnapshot()
    const creator = snapshot?.members.get(group.link_creator)
    const creatorStillReads = snapshot
      ? Boolean(
          creator &&
          levelAtLeast(memberLevel(snapshot, creator, currentSpace), "edit")
        )
      : true
    return (
      !creatorStillReads && canAccessSpace(currentSpace, "manage", identity)
    )
  }
  let items = 0
  for (const group of groups) {
    if (!group.count && !resumable(group)) continue
    const hint = group.space_at_receipt
    if (!eligibleIds.has(hint) || !belongs(group, hint)) continue
    let snapshot = snapshots.get(hint)
    if (snapshot === null) continue
    if (!snapshot) {
      // Home is a ten-item preview. Deleted documents must also consume the
      // lookup budget, so stale receipts cannot open thousands of catalogs.
      // Space-specific Pending can still resolve that Space independently.
      if (snapshots.size >= 10) continue
      try {
        snapshot = await readDocumentIdentities(hint)
      } catch (error) {
        if (error instanceof DocumentSpaceNotFoundError) {
          snapshots.set(hint, null)
          continue
        }
        throw error
      }
      snapshots.set(hint, snapshot)
    }
    if (snapshot.identities.spaceArchived) continue
    const document = snapshot.identities.current.get(group.document_id)
    if (!document) continue
    candidates.push({ group, document: { spaceId: hint, ...document } })
    items += Number(group.count > 0) + Number(resumable(group))
    if (items >= 10) break
  }
  if (!(await visitorNamespaceStillCurrent(namespace))) return []
  return candidates
    .flatMap(({ group, document }): PendingItem[] => {
      if (!mayRead(document.spaceId) || !belongs(group, document.spaceId))
        return []
      const base = {
        at: new Date(group.at).toISOString(),
        spaceId: document.spaceId,
        documentId: group.document_id,
        docPath: document.path,
        docTitle: document.title,
        linkId: group.link_id,
        linkLabel: group.link_label,
        count: group.count,
      }
      return [
        ...(group.count
          ? [
              {
                ...base,
                kind: "visitorComments" as const,
                id: `visitors:${group.link_id}`,
              },
            ]
          : []),
        ...(resumable(group)
          ? [
              {
                ...base,
                kind: "visitorCommentsPaused" as const,
                linkLabel: commentLinks.get(group.link_id)!.label,
                id: `visitors-paused:${group.link_id}`,
                reason: "spike" as const,
              },
            ]
          : []),
      ]
    })
    .slice(0, 10)
}
