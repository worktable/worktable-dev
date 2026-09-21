let recoveryRequiredReason: string | null = null
const recoveryRequiredListeners = new Set<() => void>()

export class WorkspaceUnavailableError extends Error {
  readonly code = "WORKSPACE_RECOVERY_REQUIRED"
}

/** Fail closed after a live operation leaves durable recovery state active. */
export function requireWorkspaceRecovery(reason: string): void {
  if (recoveryRequiredReason) return
  recoveryRequiredReason = reason
  for (const listener of recoveryRequiredListeners) listener()
}

export function workspaceRecoveryRequired(): boolean {
  return recoveryRequiredReason !== null
}

export function assertWorkspaceAvailable(): void {
  if (!recoveryRequiredReason) return
  throw new WorkspaceUnavailableError(
    "Workspace unavailable: restart Worktable to finish recovering a document move."
  )
}

/** Clear only after startup recovery has completed successfully. */
export function clearWorkspaceRecoveryRequirement(): void {
  recoveryRequiredReason = null
}

export function onWorkspaceRecoveryRequired(listener: () => void): () => void {
  recoveryRequiredListeners.add(listener)
  return () => recoveryRequiredListeners.delete(listener)
}

export function resetWorkspaceSafetyForTests(): void {
  recoveryRequiredReason = null
  recoveryRequiredListeners.clear()
}
