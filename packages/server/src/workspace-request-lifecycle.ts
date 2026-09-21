const activeWorkspaceRequests = new Set<symbol>()
let acceptingWorkspaceRequests = true
let drainWaiters: Array<() => void> = []
let admissionHookForTests:
  | ((request: { method: string; pathname: string }) => Promise<void>)
  | null = null

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export function isWorkspaceRequest(method: string, pathname: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false
  return (
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname === "/api/mcp" ||
    pathname.startsWith("/api/mcp/") ||
    pathname === "/api/workspace" ||
    pathname.startsWith("/api/workspace/") ||
    pathname === "/api/shares" ||
    pathname.startsWith("/api/shares/") ||
    pathname === "/api/spaces" ||
    pathname.startsWith("/api/spaces/") ||
    pathname === "/api/threads" ||
    pathname.startsWith("/api/threads/")
  )
}

export function admitWorkspaceRequest(): (() => void) | null {
  if (!acceptingWorkspaceRequests) return null
  const request = Symbol("workspace-request")
  activeWorkspaceRequests.add(request)
  let released = false
  return () => {
    if (released) return
    released = true
    activeWorkspaceRequests.delete(request)
    if (activeWorkspaceRequests.size === 0) {
      const waiters = drainWaiters
      drainWaiters = []
      for (const resolve of waiters) resolve()
    }
  }
}

export async function stopWorkspaceRequestAdmissionAndDrain(): Promise<void> {
  acceptingWorkspaceRequests = false
  while (activeWorkspaceRequests.size > 0) {
    await new Promise<void>((resolve) => drainWaiters.push(resolve))
  }
}

export function resumeWorkspaceRequestAdmission(): void {
  acceptingWorkspaceRequests = true
}

export function isWorkspaceRequestAdmissionOpen(): boolean {
  return acceptingWorkspaceRequests
}

export async function runWorkspaceRequestAdmissionHookForTests(request: {
  method: string
  pathname: string
}): Promise<void> {
  await admissionHookForTests?.(request)
}

export function setWorkspaceRequestAdmissionHookForTests(
  hook:
    | ((request: { method: string; pathname: string }) => Promise<void>)
    | null
): void {
  admissionHookForTests = hook
}

export function resetWorkspaceRequestLifecycleForTests(): void {
  if (activeWorkspaceRequests.size > 0) {
    throw new Error("cannot reset workspace request lifecycle while active")
  }
  acceptingWorkspaceRequests = true
  drainWaiters = []
  admissionHookForTests = null
}
