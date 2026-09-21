import type { DesktopLabAgent, LabOptions } from "./types.ts"

export const DEFAULT_TTL = "2h"

const TTL_RE = /^(?:[1-9]\d*)(?:s|m|h)$/

function mappedIpv4Address(host: string): number | undefined {
  const unwrapped = host.replace(/^\[|\]$/g, "")
  const mapped = unwrapped.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/i)
  if (!mapped) return undefined
  const high = Number.parseInt(mapped[1]!, 16)
  const low = Number.parseInt(mapped[2]!, 16)
  if (high > 0xffff || low > 0xffff) return undefined
  return high * 0x10000 + low
}

function isGuestLocalHost(host: string): boolean {
  const mappedIpv4 = mappedIpv4Address(host)
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "::1" ||
    host === "[::]" ||
    host === "::" ||
    host === "0.0.0.0" ||
    /^127(?:\.|$)/.test(host) ||
    mappedIpv4 === 0 ||
    (mappedIpv4 !== undefined && Math.floor(mappedIpv4 / 0x1000000) === 127)
  )
}

function usage(): string {
  return `Manual Worktable acceptance labs

Usage:
  bun run lab -- cloud --origin <https-url> [common options]
  bun run lab -- local [--source release|checkout] [--fixture <slug|empty>]
                      [--host-port <port>] [--public-host <host-or-ip>]
                      [--rebuild] [--clean] [common options]
  bun run lab -- openclaw [--source release|checkout]
                         [--fixture <slug|empty>] [--host-port <port>]
                         [--public-host <host-or-ip>] [--rebuild] [--clean]
                         [--openclaw-source <directory>] [common options]
  bun run lab -- auth [--import-host] [--openclaw-source <directory>]
                      [common options]
  bun run lab -- desktop [--fixture <slug|empty>] [--rebuild] [--keep]
                        [common options]
  bun run lab -- agent <codex|claude-code|opencode>
                       [--name <desktop-run>] [--code <pairing-code>] [--replace]
  bun run lab -- client [--target <url>] [common options]
  bun run lab -- clean [--dry-run]

Common options:
  --ttl <duration>  Maximum sandbox lifetime (default: 2h)
  --name <name>     Human-readable sandbox name
  --dry-run         Validate and describe actions without changing environments
  --clean           Do not mount the reusable personal lab auth profile
  --help            Show this help

  Cloud, local, OpenClaw, desktop, and client labs prepare disposable manual environments;
they never add an MCP server on your behalf. Desktop runs the packaged checkout
app with isolated host data and workspace paths. The agent command pairs and
launches one CLI inside an active Desktop lab's isolated profile.`
}

const DESKTOP_LAB_AGENTS = ["codex", "claude-code", "opencode"] as const

function validateDesktopLabAgent(value: string | undefined): DesktopLabAgent {
  if (!value || value.startsWith("--"))
    throw new Error(
      "lab agent requires one client: codex, claude-code, or opencode"
    )
  if (!DESKTOP_LAB_AGENTS.includes(value as DesktopLabAgent)) {
    if (value === "cursor" || value === "vscode")
      throw new Error(
        `${value} uses a GUI profile, which the isolated lab launcher does not support yet. Use codex, claude-code, or opencode.`
      )
    throw new Error(
      `Unknown lab agent ${value}; choose codex, claude-code, or opencode`
    )
  }
  return value as DesktopLabAgent
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`)
  return value
}

export function validateTtl(value: string): string {
  if (!TTL_RE.test(value))
    throw new Error(
      `--ttl must be a positive duration such as 30m or 2h (got ${value})`
    )
  return value
}

export function validateSandboxName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) {
    throw new Error(
      "--name must be 1-64 characters using letters, digits, dot, underscore, or hyphen"
    )
  }
  return value
}

export function validateFixture(value: string): string {
  if (value === "empty") return value
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(
      "--fixture must be `empty` or a lowercase fixture slug such as basic-docs"
    )
  }
  return value
}

export function validatePort(value: string): number {
  if (!/^\d+$/.test(value))
    throw new Error(
      `--host-port must be an integer from 1 to 65535 (got ${value})`
    )
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      `--host-port must be an integer from 1 to 65535 (got ${value})`
    )
  return port
}

export function validatePublicHost(value: string): string {
  const unwrapped = value.replace(/^\[|\]$/g, "")
  const normalized = unwrapped.toLowerCase().replace(/\.$/, "")
  if (
    value.length === 0 ||
    value.includes("://") ||
    value.includes("/") ||
    value.includes("?") ||
    value.includes("#") ||
    /\s/.test(value) ||
    !(
      /^[a-zA-Z0-9.-]+$/.test(unwrapped) ||
      /^(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4}$/.test(unwrapped)
    )
  ) {
    throw new Error(
      "--public-host must be a host name or IP address, not a URL"
    )
  }
  if (isGuestLocalHost(normalized)) {
    throw new Error("--public-host must not be loopback or 0.0.0.0")
  }
  try {
    const url = new URL(`http://${value}`)
    if (!url.hostname || url.username || url.password || url.port)
      throw new Error()
    if (isGuestLocalHost(url.hostname.toLowerCase().replace(/\.$/, ""))) {
      throw new Error(
        "--public-host must not canonicalize to loopback or 0.0.0.0"
      )
    }
  } catch {
    throw new Error(
      `Invalid --public-host or loopback/wildcard alias: ${value}`
    )
  }
  return value
}

export function validateOrigin(
  value: string,
  purpose: "cloud" | "target"
): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid URL: ${value}`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${purpose} URL must not contain credentials, a query, or a fragment`
    )
  }
  if (url.pathname !== "/")
    throw new Error(`${purpose} URL must be an origin without a path`)
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  if (
    host === "app.worktable.cloud" ||
    host === "worktable.cloud" ||
    host === "www.worktable.cloud"
  ) {
    throw new Error(
      "Production Worktable Cloud targets are not supported by acceptance labs"
    )
  }
  if (purpose === "cloud") {
    if (url.protocol !== "https:")
      throw new Error("Cloud origin must use HTTPS")
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Client target must use HTTP or HTTPS")
  }
  if (purpose === "target" && isGuestLocalHost(host)) {
    throw new Error(
      "Client target must be reachable from inside the sandbox; use the Linux LAN, Tailscale, or guest-reachable host-gateway address instead of a loopback or wildcard host"
    )
  }
  return url.origin
}

export function parseArgs(argv: string[]): LabOptions {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    throw new Error(usage())
  }
  const command = argv[0]
  if (
    command !== "cloud" &&
    command !== "local" &&
    command !== "openclaw" &&
    command !== "auth" &&
    command !== "desktop" &&
    command !== "agent" &&
    command !== "client" &&
    command !== "clean"
  ) {
    throw new Error(`Unknown lab command: ${command}\n\n${usage()}`)
  }

  let dryRun = false
  let ttl = DEFAULT_TTL
  let name: string | undefined
  let origin: string | undefined
  let target: string | undefined
  let source: "release" | "checkout" = "release"
  let fixture: string | undefined
  let hostPort: number | undefined
  let publicHost: string | undefined
  let rebuild = false
  let keep = false
  let code: string | undefined
  let replace = false
  let authMode: "ready" | "clean" = "ready"
  let importHost = false
  let openclawSource: string | undefined
  const client =
    command === "agent" ? validateDesktopLabAgent(argv[1]) : undefined
  const firstOption = command === "agent" ? 2 : 1

  for (let i = firstOption; i < argv.length; i += 1) {
    const flag = argv[i]!
    switch (flag) {
      case "--dry-run":
        if (command === "agent")
          throw new Error("--dry-run is not valid with lab agent")
        dryRun = true
        break
      case "--clean":
        if (
          command !== "cloud" &&
          command !== "local" &&
          command !== "openclaw" &&
          command !== "client"
        )
          throw new Error(
            "--clean is only valid with lab cloud, local, openclaw, or client"
          )
        authMode = "clean"
        break
      case "--import-host":
        if (command !== "auth")
          throw new Error("--import-host is only valid with lab auth")
        importHost = true
        break
      case "--openclaw-source":
        if (command !== "auth" && command !== "openclaw")
          throw new Error(
            "--openclaw-source is only valid with lab auth or openclaw"
          )
        openclawSource = takeValue(argv, i, flag)
        i += 1
        break
      case "--ttl":
        if (command === "agent")
          throw new Error(`--ttl is not valid with lab ${command}`)
        ttl = validateTtl(takeValue(argv, i, flag))
        i += 1
        break
      case "--name":
        name = validateSandboxName(takeValue(argv, i, flag))
        i += 1
        break
      case "--code":
        if (command !== "agent")
          throw new Error("--code is only valid with lab agent")
        code = takeValue(argv, i, flag)
        i += 1
        break
      case "--replace":
        if (command !== "agent")
          throw new Error("--replace is only valid with lab agent")
        replace = true
        break
      case "--origin":
        if (command !== "cloud")
          throw new Error("--origin is only valid with lab cloud")
        origin = validateOrigin(takeValue(argv, i, flag), "cloud")
        i += 1
        break
      case "--target":
        if (command !== "client")
          throw new Error("--target is only valid with lab client")
        target = validateOrigin(takeValue(argv, i, flag), "target")
        i += 1
        break
      case "--source": {
        if (command !== "local" && command !== "openclaw")
          throw new Error("--source is only valid with lab local or openclaw")
        const value = takeValue(argv, i, flag)
        if (value !== "release" && value !== "checkout")
          throw new Error("--source must be release or checkout")
        source = value
        i += 1
        break
      }
      case "--fixture":
        if (
          command !== "local" &&
          command !== "openclaw" &&
          command !== "desktop"
        )
          throw new Error(
            "--fixture is only valid with lab local, openclaw, or desktop"
          )
        fixture = validateFixture(takeValue(argv, i, flag))
        i += 1
        break
      case "--host-port":
        if (command !== "local" && command !== "openclaw")
          throw new Error(
            "--host-port is only valid with lab local or openclaw"
          )
        hostPort = validatePort(takeValue(argv, i, flag))
        i += 1
        break
      case "--public-host":
        if (command !== "local" && command !== "openclaw")
          throw new Error(
            "--public-host is only valid with lab local or openclaw"
          )
        publicHost = validatePublicHost(takeValue(argv, i, flag))
        i += 1
        break
      case "--rebuild":
        if (
          command !== "local" &&
          command !== "openclaw" &&
          command !== "desktop"
        )
          throw new Error("--rebuild is only valid with lab local or desktop")
        rebuild = true
        break
      case "--keep":
        if (command !== "desktop")
          throw new Error("--keep is only valid with lab desktop")
        keep = true
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  if (command === "clean") {
    if (name || ttl !== DEFAULT_TTL)
      throw new Error("lab clean accepts only --dry-run")
    return { command, dryRun, ttl }
  }
  if (command === "auth") {
    return {
      command,
      dryRun,
      ttl,
      ...(name ? { name } : {}),
      importHost,
      ...(openclawSource ? { openclawSource } : {}),
    }
  }
  if (command === "agent") {
    return {
      command,
      client: client!,
      ...(name ? { name } : {}),
      ...(code ? { code } : {}),
      replace,
    }
  }
  if (command === "cloud") {
    if (!origin) throw new Error("lab cloud requires --origin <https-url>")
    return {
      command,
      dryRun,
      ttl,
      ...(name ? { name } : {}),
      origin,
      authMode,
    }
  }
  if (command === "desktop")
    return {
      command,
      dryRun,
      ttl,
      ...(name ? { name } : {}),
      ...(fixture ? { fixture } : {}),
      rebuild,
      keep,
    }
  if (command === "local") {
    if (rebuild && source !== "checkout")
      throw new Error("--rebuild requires --source checkout")
    return {
      command,
      dryRun,
      ttl,
      ...(name ? { name } : {}),
      source,
      ...(fixture ? { fixture } : {}),
      ...(hostPort ? { hostPort } : {}),
      ...(publicHost ? { publicHost } : {}),
      rebuild,
      authMode,
    }
  }
  if (command === "openclaw") {
    if (rebuild && source !== "checkout")
      throw new Error("--rebuild requires --source checkout")
    return {
      command,
      dryRun,
      ttl,
      ...(name ? { name } : {}),
      source,
      ...(fixture ? { fixture } : {}),
      ...(hostPort ? { hostPort } : {}),
      ...(publicHost ? { publicHost } : {}),
      rebuild,
      authMode,
      ...(openclawSource ? { openclawSource } : {}),
    }
  }
  return {
    command,
    dryRun,
    ttl,
    ...(name ? { name } : {}),
    ...(target ? { target } : {}),
    authMode,
  }
}

export function helpText(): string {
  return usage()
}
