import { hostedClientAddress } from "./hosted.ts"

// Who sent a request, for limits that must not let one sender crowd out
// everyone else. Bun knows the connecting address only at the listener, so it
// is remembered here for the routes behind it.

const peers = new WeakMap<Request, string>()

/** Record the address that connected to send this request. */
export function rememberPeer(req: Request, address: string | undefined): void {
  if (address) peers.set(req, address)
}

function isLoopback(address: string): boolean {
  return (
    address === "::1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  )
}

/**
 * The sender of a request: on Cloud, the address the gateway saw; otherwise
 * the connecting address. A forwarded address counts only when the
 * connection comes from this computer, as from a local proxy or tunnel, and
 * then only the one that proxy added last, which a sender cannot forge.
 */
export function requestSource(req: Request): string {
  const hosted = hostedClientAddress(req)
  if (hosted) return hosted
  const peer = peers.get(req)
  if (!peer) return "unknown"
  if (isLoopback(peer)) {
    const forwarded = req.headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .at(-1)
    if (forwarded && forwarded.length <= 64) return forwarded
  }
  return peer
}
