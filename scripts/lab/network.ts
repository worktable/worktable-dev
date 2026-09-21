import { execFileSync } from "node:child_process"
import { createServer } from "node:net"
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os"
import type { LabCommand, LocalLabNetwork, NetworkInfo } from "./types.ts"

const EXCLUDED_INTERFACE = /^(?:lo|docker\d*|br-|veth|virbr|podman|cni)/

export function needsHostNetwork(command: LabCommand): boolean {
  return (
    command === "cloud" ||
    command === "local" ||
    command === "openclaw" ||
    command === "client"
  )
}

export interface AddressCandidate {
  name: string
  address: string
  internal: boolean
}

export function selectLanAddress(
  candidates: AddressCandidate[],
  routeSource?: string
): string {
  if (routeSource && isUsableLanAddress(routeSource)) return routeSource
  const candidate = candidates.find(
    (entry) =>
      !entry.internal &&
      !EXCLUDED_INTERFACE.test(entry.name) &&
      isUsableLanAddress(entry.address)
  )
  if (!candidate)
    throw new Error(
      "Could not determine a LAN address; pass a reachable target explicitly"
    )
  return candidate.address
}

export function isUsableLanAddress(address: string): boolean {
  return (
    !address.startsWith("127.") &&
    address !== "0.0.0.0" &&
    !address.startsWith("169.254.")
  )
}

function routeSourceAddress(): string | undefined {
  try {
    const output = execFileSync("ip", ["-4", "route", "get", "1.1.1.1"], {
      encoding: "utf8",
    })
    return output.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/)?.[1]
  } catch {
    return undefined
  }
}

export function discoverNetwork(): NetworkInfo {
  const candidates: AddressCandidate[] = []
  let tailscaleAddress: string | undefined
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? ([] as NetworkInterfaceInfo[])) {
      if (entry.family !== "IPv4") continue
      candidates.push({
        name,
        address: entry.address,
        internal: entry.internal,
      })
      if (name === "tailscale0" && !entry.internal)
        tailscaleAddress = entry.address
    }
  }
  return {
    lanAddress: selectLanAddress(candidates, routeSourceAddress()),
    ...(tailscaleAddress ? { tailscaleAddress } : {}),
  }
}

export function discoverNetworkOptional(
  discover: () => NetworkInfo = discoverNetwork
): NetworkInfo | undefined {
  try {
    return discover()
  } catch {
    return undefined
  }
}

export function allocatePort(host = "0.0.0.0"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen({ host, port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() =>
          reject(new Error("Could not allocate an available TCP port"))
        )
        return
      }
      const port = address.port
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

export function assertPortAvailable(
  port: number,
  host = "0.0.0.0"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", () =>
      reject(new Error(`Host port ${port} is already in use on ${host}`))
    )
    server.listen({ host, port }, () =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })
}

export function assertClientHost(host: string): void {
  if (host === "0.0.0.0" || host === "::" || host === "[::]")
    throw new Error("0.0.0.0 is a bind address, not a client-facing host")
}

export function formatUrlHost(host: string): string {
  assertClientHost(host)
  const unwrapped = host.replace(/^\[|\]$/g, "")
  return unwrapped.includes(":") ? `[${unwrapped}]` : unwrapped
}

export function localOrigin(host: string, port: number): string {
  return `http://${formatUrlHost(host)}:${port}`
}

export function buildLocalLabNetwork(options: {
  hostPort: number
  publicHost?: string
  network?: NetworkInfo
}): LocalLabNetwork {
  const publicHost = options.publicHost ?? options.network?.lanAddress
  if (!publicHost)
    throw new Error(
      "No usable LAN address found; pass --public-host with a reachable host or IP"
    )
  const publicOrigin = localOrigin(publicHost, options.hostPort)
  const tailscaleAddress = options.network?.tailscaleAddress
  return {
    hostPort: options.hostPort,
    publicHost,
    publicOrigin,
    lanOrigin: publicOrigin,
    loopbackOrigin: localOrigin("127.0.0.1", options.hostPort),
    ...(tailscaleAddress
      ? { tailscaleOrigin: localOrigin(tailscaleAddress, options.hostPort) }
      : {}),
  }
}
