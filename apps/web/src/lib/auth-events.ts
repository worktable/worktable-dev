const CHANNEL = "worktable-auth"

/** A changed account must unload tabs carrying the previous person's drafts. */
export function onBrowserLogout(listener: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {}
  const channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (event) => {
    const type = (event.data as { type?: unknown } | null)?.type
    if (type === "logout" || type === "account-changed") listener()
  }
  return () => channel.close()
}

export function notifyBrowserAccountChanged(): void {
  if (typeof BroadcastChannel === "undefined") return
  const channel = new BroadcastChannel(CHANNEL)
  channel.postMessage({ type: "account-changed" })
  channel.close()
}
