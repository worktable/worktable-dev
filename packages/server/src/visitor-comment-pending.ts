import type { PendingItem, SpaceFile } from "@worktable/types"
import { readDocumentIdentities } from "./document-query.ts"
import { getSpaceArchiveInfo } from "./store.ts"
import { accessSnapshot, levelAtLeast, memberLevel } from "./team-access.ts"
import { canAccessSpace } from "./team-policy.ts"
import { sharerOf } from "./share-policy.ts"
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
  const eligible = spaces.filter(
    (space) =>
      (!spaceId || space.id === spaceId) &&
      !getSpaceArchiveInfo(space) &&
      mayRead(space.id)
  )
  const wanted = new Set(groups.map((group) => group.document_id))
  const documents = new Map<
    string,
    { spaceId: string; path: string; title: string }
  >()
  for (const space of eligible) {
    const { identities } = await readDocumentIdentities(space.id)
    if (identities.spaceArchived) continue
    for (const id of wanted) {
      const document = identities.current.get(id)
      if (document) documents.set(id, { spaceId: space.id, ...document })
    }
  }
  if (!(await visitorNamespaceStillCurrent(namespace))) return []
  const snapshot = accessSnapshot()
  const reader = sharerOf(identity).id
  return groups.flatMap((group): PendingItem[] => {
    const document = documents.get(group.document_id)
    if (!document || !mayRead(document.spaceId)) return []
    const creator = snapshot?.members.get(group.link_creator)
    const creatorStillReads = snapshot
      ? Boolean(
          creator &&
          levelAtLeast(memberLevel(snapshot, creator, document.spaceId), "edit")
        )
      : true
    if (
      group.link_creator !== reader &&
      (creatorStillReads ||
        !canAccessSpace(document.spaceId, "manage", identity))
    )
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
      ...(group.paused
        ? [
            {
              ...base,
              kind: "visitorCommentsPaused" as const,
              id: `visitors-paused:${group.link_id}`,
              reason: group.paused,
            },
          ]
        : []),
    ]
  })
}
