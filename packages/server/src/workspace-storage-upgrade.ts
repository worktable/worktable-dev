import { join } from "node:path"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import {
  ensureWorkspaceManifest,
  getWorkspaceRoot,
  workspaceCacheKey,
} from "./workspace.ts"
import {
  migrateDocumentStorageV2,
  planDocumentStorageV2Migration,
} from "./document-storage-migration-v2.ts"

export type WorkspaceStorageUpgradeState = "ready" | "upgrading" | "blocked"
let state: WorkspaceStorageUpgradeState = "ready"
let retry: (() => void) | null = null

export function workspaceStorageUpgradeState(): WorkspaceStorageUpgradeState {
  return state
}

export function setWorkspaceStorageUpgradeState(
  next: WorkspaceStorageUpgradeState,
  retryUpgrade: (() => void) | null = null
): void {
  state = next
  retry = retryUpgrade
}

export function retryWorkspaceStorageUpgrade(): boolean {
  if (state !== "blocked" || !retry) return false
  retry()
  return true
}

/** Called with only the maintenance listener running: no workspace writers. */
export async function upgradeWorkspaceBeforeStartup(): Promise<void> {
  const appDir = ensureAppDir()
  const runtimeCacheKey = workspaceCacheKey()
  await withCrossProcessLock(
    join(appDir, `storage-upgrade-${runtimeCacheKey}.lock`),
    { label: "Workspace storage upgrade", timeoutMs: 30_000 },
    async () => {
      if (ensureWorkspaceManifest().version === 2) return
      const workspaceRoot = getWorkspaceRoot()
      const plan = await planDocumentStorageV2Migration(workspaceRoot, {
        appDir,
        runtimeCacheKey,
      })
      const result = await migrateDocumentStorageV2({
        workspaceRoot,
        expectedWorkspaceId: plan.workspaceId,
        expectedWorkspaceContentCheckpoint: plan.workspaceContentCheckpoint,
        appDir,
        runtimeCacheKey,
      })
      if (result.orphanedAnnotationFiles.length > 0) {
        console.warn(
          `[workspace] storage upgrade left out ${result.orphanedAnnotationFiles.length} annotation file(s) for deleted documents; the originals remain in ${result.backupPath}:`,
          result.orphanedAnnotationFiles.join(", ")
        )
      }
    }
  )
}
