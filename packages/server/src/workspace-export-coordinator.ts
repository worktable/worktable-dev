let flushBeforeExport: (() => Promise<void>) | null = null
let captureWorkspaceSnapshot:
  | (<T>(capture: () => Promise<T>) => Promise<T>)
  | null = null
let snapshotQueue: Promise<void> = Promise.resolve()

export function setWorkspaceExportFlush(
  flush: (() => Promise<void>) | null
): void {
  flushBeforeExport = flush
}

export function setWorkspaceExportSnapshot(
  snapshot: (<T>(capture: () => Promise<T>) => Promise<T>) | null
): void {
  captureWorkspaceSnapshot = snapshot
}

/**
 * Serialize captures and, when a live server is present, let it hold its
 * mutation barrier across both the final writer flush and the filesystem
 * snapshot. CLI/maintenance exports have no in-process writers, so they run
 * the same capture directly.
 */
export async function withWorkspaceExportSnapshot<T>(
  capture: () => Promise<T>,
  options: { onBarrierComplete?: (durationMs: number) => void } = {}
): Promise<T> {
  const previous = snapshotQueue
  let release!: () => void
  snapshotQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  const startedAt = performance.now()
  try {
    const work = async () => {
      await flushBeforeExport?.()
      return capture()
    }
    return captureWorkspaceSnapshot
      ? await captureWorkspaceSnapshot(work)
      : await work()
  } finally {
    release()
    options.onBarrierComplete?.(performance.now() - startedAt)
  }
}
