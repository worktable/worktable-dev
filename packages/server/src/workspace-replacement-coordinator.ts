import type { BeginWorkspaceReplacementOptions } from "./workspace-replacement.ts"

export interface ScheduledWorkspaceReplacement {
  stagingPath: string
  backupPath: string
  contentCheckpoint: string
  options?: BeginWorkspaceReplacementOptions
  expectedDestinationContentCheckpoint?: string
  /** Required committed-state work before requests reopen; failure requires recovery. */
  onCommitted?(): Promise<void>
  onSucceeded(): Promise<void>
  onFailed(
    error: unknown,
    options?: { recoveryIncomplete?: boolean }
  ): Promise<void>
}

type Executor = (replacement: ScheduledWorkspaceReplacement) => void

let executor: Executor | null = null
let replacementScheduled = false
let activeExports = 0
let exportDrainWaiters: Array<() => void> = []

export function setWorkspaceReplacementExecutor(next: Executor | null): void {
  executor = next
}

export function scheduleWorkspaceReplacement(
  replacement: ScheduledWorkspaceReplacement
): void {
  if (!executor) {
    throw new Error(
      "workspace replacement is unavailable before server startup"
    )
  }
  if (replacementScheduled) {
    throw new Error("another workspace replacement is already in progress")
  }
  replacementScheduled = true
  const selectedExecutor = executor
  const release = () => {
    replacementScheduled = false
  }
  const scheduled: ScheduledWorkspaceReplacement = {
    ...replacement,
    async onSucceeded() {
      try {
        await replacement.onSucceeded()
      } finally {
        release()
      }
    },
    async onFailed(error, options) {
      try {
        await replacement.onFailed(error, options)
      } finally {
        release()
      }
    },
  }
  void waitForActiveWorkspaceExports()
    .then(() => selectedExecutor(scheduled))
    .catch((error) => scheduled.onFailed(error))
}

export async function withWorkspaceExportLease<T>(
  work: () => Promise<T>
): Promise<T> {
  if (replacementScheduled) {
    throw new Error("workspace export is unavailable during replacement")
  }
  activeExports += 1
  try {
    return await work()
  } finally {
    activeExports -= 1
    if (activeExports === 0) {
      const waiters = exportDrainWaiters
      exportDrainWaiters = []
      for (const resolve of waiters) resolve()
    }
  }
}

export async function waitForActiveWorkspaceExports(): Promise<void> {
  while (activeExports > 0) {
    await new Promise<void>((resolve) => exportDrainWaiters.push(resolve))
  }
}
