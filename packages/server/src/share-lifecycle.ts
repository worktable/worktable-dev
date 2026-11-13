import { forgetDeletedDocQuotes, forgetSpaceQuotes } from "./activity-log.ts"
import { isHosted } from "./hosted.ts"
import {
  revokeLinksForDocuments,
  revokeLinksForSpace,
  type DocumentShareChange,
  type DocumentShareTarget,
} from "./share-links-lifecycle.ts"
import {
  invalidateDocumentShares,
  invalidateDocumentSharesWithinLifecycle,
  invalidateDocumentSharesForSpace,
  withDocumentShareLifecycle,
  type ShareArtifact,
} from "./share-store.ts"

export type { DocumentShareChange, DocumentShareTarget }

/**
 * What a removed document's comments said leaves Activity with it. Every
 * document removal names its targets here, so this is where it goes.
 */
function forgetRemovedComments(
  targets: readonly DocumentShareTarget[],
  change: DocumentShareChange
): void {
  if (change !== "removed" || targets.length === 0) return
  forgetDeletedDocQuotes(
    targets.map((target) => ({
      spaceId: target.spaceId,
      path: target.artifactKey,
      ...(target.documentId ? { documentId: target.documentId } : {}),
    }))
  )
}

function artifactOf(target: DocumentShareTarget): ShareArtifact {
  return {
    kind: target.kind,
    spaceId: target.spaceId,
    artifactKey: target.artifactKey,
  }
}

/**
 * Cloud shares are app-private tenant state. Keep local/self-hosted lifecycle
 * operations free of Cloud state while ensuring every hosted mutation
 * invalidates links even when the public gateway is temporarily disabled.
 * Links (v2) are keyed by document, so a rename leaves them; archiving or
 * removing a document revokes them on every install.
 */
export async function invalidateHostedDocumentShares(
  targets: DocumentShareTarget[],
  change: DocumentShareChange
): Promise<void> {
  if (isHosted() && targets.length > 0) {
    await invalidateDocumentShares(targets.map(artifactOf))
  }
  await revokeLinksForDocuments(targets, change)
  forgetRemovedComments(targets, change)
}

/**
 * Prevent a new hosted capability from being minted between revocation and a
 * document locator commit. Local workspaces have no share state to fence.
 */
export function withHostedDocumentShareLifecycle<T>(
  operation: (
    invalidate: (
      targets: DocumentShareTarget[],
      change: DocumentShareChange
    ) => Promise<number>
  ) => Promise<T>
): Promise<T> {
  if (!isHosted()) {
    return operation(async (targets, change) => {
      await revokeLinksForDocuments(targets, change)
      forgetRemovedComments(targets, change)
      return 0
    })
  }
  return withDocumentShareLifecycle(() =>
    operation(async (targets, change) => {
      const invalidated = await invalidateDocumentSharesWithinLifecycle(
        targets.map(artifactOf)
      )
      await revokeLinksForDocuments(targets, change)
      forgetRemovedComments(targets, change)
      return invalidated
    })
  )
}

export async function invalidateHostedDocumentSharesForSpace(
  spaceId: string,
  change: "archived" | "removed"
): Promise<void> {
  if (isHosted()) await invalidateDocumentSharesForSpace(spaceId)
  await revokeLinksForSpace(spaceId, change)
  if (change === "removed") forgetSpaceQuotes(spaceId)
}
