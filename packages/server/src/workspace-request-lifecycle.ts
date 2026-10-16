export type WorkspaceRequestKind = "read" | "write"

// Writes are drained for every consistent capture. Reads are drained only when
// the workspace tree itself is replaced, so a backup never refuses a read.
const active: Record<WorkspaceRequestKind, Set<symbol>> = {
  read: new Set(),
  write: new Set(),
}
const accepting: Record<WorkspaceRequestKind, boolean> = {
  read: true,
  write: true,
}
let drainWaiters: Array<() => void> = []
let reopenWaiters: Array<() => void> = []
const drainListeners = new Set<() => void>()
let admissionHookForTests:
  | ((request: { method: string; pathname: string }) => Promise<void>)
  | null = null

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/** App shell, static assets and auth pages never wait on the workspace. */
function isStaticOrShell(pathname: string): boolean {
  return (
    pathname === "/health" ||
    !(
      pathname === "/mcp" ||
      pathname.startsWith("/mcp/") ||
      pathname.startsWith("/api/")
    )
  )
}

/**
 * Which drain a request belongs to, or null when it never touches the
 * workspace. Reads that also record durable app data (participant bindings,
 * delivery state) are reads: a capture does not include that data.
 */
export function classifyWorkspaceRequest(
  method: string,
  pathname: string,
  teamMode: boolean | (() => boolean) = false
): WorkspaceRequestKind | null {
  const verb = method.toUpperCase()
  if (SAFE_METHODS.has(verb)) {
    // Downloads expose workspace content; a link callback records state.
    if (
      verb === "GET" &&
      /^\/api\/workspace\/transfers\/exports\/[^/]+\/download$/.test(pathname)
    )
      return "read"
    if (verb === "GET" && pathname === "/api/linked/account/callback")
      return "write"
    if (
      verb === "GET" &&
      (pathname === "/api/profile" ||
        pathname === "/api/pending" ||
        pathname === "/api/threads" ||
        pathname.startsWith("/api/threads/") ||
        /^\/api\/spaces\/[^/]+\/threads(?:\/|$)/.test(pathname))
    )
      return "read"
    // Named-member reads must finish against the tree their grants authorized.
    if (
      !isStaticOrShell(pathname) &&
      (typeof teamMode === "function" ? teamMode() : teamMode)
    )
      return "read"
    return null
  }
  return pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname === "/api/mcp" ||
    pathname.startsWith("/api/mcp/") ||
    pathname === "/api/workspace" ||
    pathname.startsWith("/api/workspace/") ||
    pathname === "/api/shares" ||
    pathname.startsWith("/api/shares/") ||
    pathname === "/api/linked" ||
    pathname.startsWith("/api/linked/") ||
    pathname === "/api/profile" ||
    pathname === "/api/agent-connections" ||
    pathname.startsWith("/api/agent-connections/") ||
    pathname === "/api/pairing" ||
    pathname.startsWith("/api/pairing/") ||
    pathname === "/api/team" ||
    pathname.startsWith("/api/team/") ||
    pathname === "/api/tokens" ||
    pathname.startsWith("/api/tokens/") ||
    pathname === "/api/spaces" ||
    pathname.startsWith("/api/spaces/") ||
    pathname === "/api/threads" ||
    pathname.startsWith("/api/threads/")
    ? "write"
    : null
}

export function isWorkspaceRequest(
  method: string,
  pathname: string,
  teamMode: boolean | (() => boolean) = false
): boolean {
  return classifyWorkspaceRequest(method, pathname, teamMode) !== null
}

export function admitWorkspaceRequest(
  kind: WorkspaceRequestKind = "write"
): (() => void) | null {
  if (!accepting[kind]) return null
  const request = Symbol("workspace-request")
  active[kind].add(request)
  let released = false
  return () => {
    if (released) return
    released = true
    active[kind].delete(request)
    // Each drain re-checks the sets it is waiting for.
    const waiters = drainWaiters
    drainWaiters = []
    for (const resolve of waiters) resolve()
  }
}

/**
 * Run background work that changes the workspace as an admitted write: a
 * capture holding writes waits for it to finish, and it waits for the capture.
 */
export async function withWorkspaceWriteAdmission<T>(
  work: () => Promise<T>
): Promise<T> {
  let release = admitWorkspaceRequest("write")
  while (!release) {
    await new Promise<void>((resolve) => reopenWaiters.push(resolve))
    release = admitWorkspaceRequest("write")
  }
  try {
    return await work()
  } finally {
    release()
  }
}

async function drain(kinds: WorkspaceRequestKind[]): Promise<void> {
  for (const kind of kinds) accepting[kind] = false
  // Long polls answer now instead of holding the drain.
  for (const listener of [...drainListeners]) listener()
  while (kinds.some((kind) => active[kind].size > 0)) {
    await new Promise<void>((resolve) => drainWaiters.push(resolve))
  }
}

/** For a consistent capture: new writes wait, reads continue. */
export function stopWorkspaceMutationsAndDrain(): Promise<void> {
  return drain(["write"])
}

/** For replacing the workspace tree: nothing new is admitted. */
export function stopWorkspaceRequestAdmissionAndDrain(): Promise<void> {
  return drain(["write", "read"])
}

export function resumeWorkspaceRequestAdmission(): void {
  accepting.read = true
  accepting.write = true
  const waiters = reopenWaiters
  reopenWaiters = []
  for (const resolve of waiters) resolve()
}

/** Whether new writes are admitted right now. */
export function isWorkspaceRequestAdmissionOpen(): boolean {
  return accepting.write
}

/** True while a capture or replacement is draining or holding requests. */
export function isWorkspaceDraining(): boolean {
  return !accepting.write || !accepting.read
}

/** Called whenever a drain starts; returns an unsubscribe function. */
export function onWorkspaceDrain(listener: () => void): () => void {
  drainListeners.add(listener)
  return () => drainListeners.delete(listener)
}

/** How long a write waits for a capture before being refused with Retry-After. */
export const WRITE_ADMISSION_WAIT_MS = 3_000

/**
 * Wait briefly for a capture to finish before refusing a request. A
 * replacement does not reopen quickly, so it is refused at once.
 */
export async function waitForWorkspaceAdmission(
  kind: WorkspaceRequestKind,
  timeoutMs: number
): Promise<boolean> {
  if (accepting[kind]) return true
  if (!accepting.read) return false
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, timeoutMs)
    function done() {
      clearTimeout(timer)
      reopenWaiters = reopenWaiters.filter((waiter) => waiter !== done)
      resolve()
    }
    reopenWaiters.push(done)
  })
  return accepting[kind]
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
  if (active.read.size > 0 || active.write.size > 0) {
    throw new Error("cannot reset workspace request lifecycle while active")
  }
  accepting.read = true
  accepting.write = true
  drainWaiters = []
  reopenWaiters = []
  admissionHookForTests = null
}
