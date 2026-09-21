import { getDocProvenance, recordExternalDocChange } from "./store.ts"
import { workspaceCacheKey } from "./workspace.ts"
import { yjsManager } from "./yjs-manager.ts"

interface PendingDiskSync {
  contentHash: string
  contentGeneration: number
}

const pendingDiskSyncs = new Map<string, PendingDiskSync>()
const syncTails = new Map<string, Promise<void>>()

function pendingKey(spaceId: string, docPath: string): string {
  return `${workspaceCacheKey()}\0${spaceId}\0${docPath}`
}

/**
 * Record a genuine external content change before applying it to a live room.
 * Same-content watcher echoes must not replace newer accepted Yjs edits that
 * have not reached their debounced portable persist yet.
 */
export async function syncExternalDocChange(
  spaceId: string,
  docPath: string
): Promise<boolean> {
  const key = pendingKey(spaceId, docPath)
  const previous = syncTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  syncTails.set(key, tail)
  await previous
  try {
    return await syncExternalDocChangeLocked(key, spaceId, docPath)
  } finally {
    release()
    if (syncTails.get(key) === tail) syncTails.delete(key)
  }
}

async function syncExternalDocChangeLocked(
  key: string,
  spaceId: string,
  docPath: string
): Promise<boolean> {
  const provenance = await recordExternalDocChange(spaceId, docPath, {
    updatedBy: "external",
    source: "filesystem",
  })
  let pending = pendingDiskSyncs.get(key)
  if (provenance) {
    const contentGeneration = yjsManager.contentGeneration(spaceId, docPath)
    if (contentGeneration === null) {
      pendingDiskSyncs.delete(key)
      return true
    }
    pending = { contentHash: provenance.contentHash, contentGeneration }
    pendingDiskSyncs.set(key, pending)
  } else {
    if (!pending) return false
    const current = await getDocProvenance(spaceId, docPath)
    if (current?.contentHash !== pending.contentHash) {
      pendingDiskSyncs.delete(key)
      return false
    }
  }

  await yjsManager.syncFromDisk(spaceId, docPath, {
    ifContentGeneration: pending.contentGeneration,
  })
  pendingDiskSyncs.delete(key)
  return Boolean(provenance)
}
