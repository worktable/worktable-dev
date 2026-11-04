// Versions a running restore reads. Pruning at the storage limit
// (storage-pruning.ts) never removes one while it is held.

const held = new Map<string, number>()

/** Hold a version by its id until the returned release is called. */
export function holdVersion(versionId: string): () => void {
  held.set(versionId, (held.get(versionId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (held.get(versionId) ?? 1) - 1
    if (count > 0) held.set(versionId, count)
    else held.delete(versionId)
  }
}

export function versionHeld(versionId: string): boolean {
  return held.has(versionId)
}

/** Run `restore` with the version it reads held. */
export async function withVersionHeld<T>(
  versionId: string,
  restore: () => Promise<T>
): Promise<T> {
  const release = holdVersion(versionId)
  try {
    return await restore()
  } finally {
    release()
  }
}
