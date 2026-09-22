import {
  getHostedDocumentSharingConfig,
  type HostedDocumentSharingConfig,
} from "./hosted.ts"
import { getWorkspaceRoot } from "./workspace.ts"

let linked: { root: string; config: HostedDocumentSharingConfig } | null = null
export function setLinkedSharing(
  config: HostedDocumentSharingConfig | null
): void {
  linked = config ? { root: getWorkspaceRoot(), config } : null
}
export function getDocumentSharingConfig(): HostedDocumentSharingConfig | null {
  return (
    getHostedDocumentSharingConfig() ??
    (linked?.root === getWorkspaceRoot() ? linked.config : null)
  )
}
