// The status of this tab's shared sockets, summarized for app-wide
// indicators. Kept apart from the socket code so the shell can read it
// without loading that code.

export type SocketStatus = "connecting" | "connected" | "disconnected"

/** No sockets, at least one coming up, one or more live, or all down. */
export type ConnectionSummary = "idle" | "connecting" | "live" | "offline"

interface ConnectionStatusGlobal {
  __worktableSocketStatuses?: Map<string, SocketStatus>
  __worktableSocketStatusListeners?: Set<() => void>
}

// Route chunks can each carry a copy of this module; share one registry.
const browserGlobal = globalThis as typeof globalThis & ConnectionStatusGlobal
const statuses =
  browserGlobal.__worktableSocketStatuses ??
  (browserGlobal.__worktableSocketStatuses = new Map())
const listeners =
  browserGlobal.__worktableSocketStatusListeners ??
  (browserGlobal.__worktableSocketStatusListeners = new Set())

/** Record a socket's status, or `null` once the socket is gone. */
export function noteSocketStatus(
  socket: string,
  status: SocketStatus | null
): void {
  if (status === null) statuses.delete(socket)
  else statuses.set(socket, status)
  for (const listener of listeners) listener()
}

export function connectionSummary(): ConnectionSummary {
  let connecting = false
  for (const status of statuses.values()) {
    if (status === "connected") return "live"
    if (status === "connecting") connecting = true
  }
  if (connecting) return "connecting"
  return statuses.size === 0 ? "idle" : "offline"
}

export function subscribeConnectionSummary(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
