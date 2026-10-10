import { hostedClientAddress, isHosted } from "./hosted.ts"

// Who sent a request, for limits that must not let one sender crowd out
// everyone else. Bun knows the connecting address only at the listener, so it
// is remembered here for the routes behind it.

const peers = new WeakMap<Request, string>()

/** Record the address that connected to send this request. */
export function rememberPeer(req: Request, address: string | undefined): void {
  if (address) peers.set(req, address)
}

/**
 * Whether a connection comes from this computer or a private network: on
 * loopback, in a container network, on the LAN, or over Tailscale.
 */
function isLocalNetwork(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, "")
  // Loopback, unique-local, and link-local IPv6.
  if (ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip)) return true
  const octets = ip.split(".").map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n)))
    return false
  const [a, b] = octets as [number, number, number, number]
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

/**
 * The sender of a request: on Cloud, the address the gateway saw; otherwise
 * the connecting address when it is public. A connection from this computer
 * or a private network may be a proxy, a tunnel, or a neighbour, and anything
 * it says about the sender could be made up, so its senders cannot be told
 * apart. Null when they cannot, and they share a limit.
 */
export function requestSource(req: Request): string | null {
  const hosted = hostedClientAddress(req)
  if (hosted) return hosted
  // On Cloud every request arrives from the gateway, so without the address
  // it saw, senders cannot be told apart.
  if (isHosted()) return null
  const peer = peers.get(req)
  if (!peer) return "unknown"
  return isLocalNetwork(peer) ? null : peer
}
