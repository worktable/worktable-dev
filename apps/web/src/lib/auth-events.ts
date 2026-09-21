const CHANNEL = "worktable-auth"

/** Listen for a gateway logout completed in another same-origin tab. */
export function onBrowserLogout(listener: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {}
  const channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (event) => {
    if ((event.data as { type?: unknown } | null)?.type === "logout") listener()
  }
  return () => channel.close()
}
