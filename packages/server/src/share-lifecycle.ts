import { isHosted } from "./hosted.ts"
import {
  invalidateDocumentShares,
  invalidateDocumentSharesWithinLifecycle,
  invalidateDocumentSharesForSpace,
  withDocumentShareLifecycle,
  type ShareArtifact,
} from "./share-store.ts"

/**
 * Cloud shares are app-private tenant state. Keep local/self-hosted lifecycle
 * operations free of Cloud state while ensuring every hosted mutation
 * invalidates links even when the public gateway is temporarily disabled.
 */
export async function invalidateHostedDocumentShares(
  artifacts: ShareArtifact[]
): Promise<void> {
  if (!isHosted() || artifacts.length === 0) return
  await invalidateDocumentShares(artifacts)
}

/**
 * Prevent a new hosted capability from being minted between revocation and a
 * document locator commit. Local workspaces have no share state to fence.
 */
export function withHostedDocumentShareLifecycle<T>(
  operation: (
    invalidate: (artifacts: ShareArtifact[]) => Promise<number>
  ) => Promise<T>
): Promise<T> {
  if (!isHosted()) {
    return operation(async () => 0)
  }
  return withDocumentShareLifecycle(() =>
    operation(invalidateDocumentSharesWithinLifecycle)
  )
}

export async function invalidateHostedDocumentSharesForSpace(
  spaceId: string
): Promise<void> {
  if (!isHosted()) return
  await invalidateDocumentSharesForSpace(spaceId)
}
