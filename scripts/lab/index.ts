#!/usr/bin/env bun
import { helpText, parseArgs } from "./args.ts"
import { preflightAgents } from "./agents.ts"
import {
  assertReusableAuthAvailable,
  ensureLabAuthVolume,
  importHostCredentials,
} from "./auth-profile.ts"
import { removeOwnedDesktopLabs, runDesktopLab } from "./desktop.ts"
import { runDesktopAgent } from "./desktop-agent.ts"
import {
  allocatePort,
  assertPortAvailable,
  buildLocalLabNetwork,
  discoverNetwork,
  discoverNetworkOptional,
  needsHostNetwork,
} from "./network.ts"
import { prepareCheckoutArtifacts } from "./local-worktable.ts"
import {
  attachSandbox,
  createAgentSandbox,
  makeSandboxName,
  preflightMicrosandbox,
  preflightMicrosandboxCleanup,
  removeOwnedSandboxes,
  removeSandbox,
  realSystem,
} from "./microsandbox.ts"
import { fixturePath } from "./workspace-seed.ts"
import { prepareOpenClawArtifacts } from "./openclaw.ts"

export async function runLab(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText())
    return
  }
  const options = parseArgs(argv)

  if (options.command === "agent") {
    await runDesktopAgent(options)
    return
  }

  if (options.command === "clean") {
    const hasMicrosandbox = Boolean(Bun.which("msb"))
    const desktop = removeOwnedDesktopLabs({ dryRun: options.dryRun })
    let names: string[] = []
    let microsandboxError: unknown
    if (hasMicrosandbox) {
      try {
        preflightMicrosandboxCleanup()
        names = removeOwnedSandboxes({
          state: "stopped",
          dryRun: options.dryRun,
        })
      } catch (error) {
        microsandboxError = error
      }
    }
    const removable = [
      ...names.map((name) => `sandbox ${name}`),
      ...desktop.removed.map((path) => `desktop ${path}`),
    ]
    if (removable.length === 0 && !microsandboxError)
      console.log("No inactive owned Worktable manual labs found.")
    else if (removable.length > 0)
      console.log(
        `${options.dryRun ? "Would remove" : "Removed"}:\n${removable.map((item) => `  ${item}`).join("\n")}`
      )
    if (desktop.running.length > 0)
      console.log(
        `Kept running Desktop labs:\n${desktop.running.map((path) => `  ${path}`).join("\n")}`
      )
    if (microsandboxError)
      throw new Error(
        `Desktop cleanup completed, but Microsandbox cleanup could not run: ${microsandboxError instanceof Error ? microsandboxError.message : String(microsandboxError)}`
      )
    return
  }

  if (options.command === "desktop") {
    await runDesktopLab(options)
    return
  }

  preflightMicrosandbox({
    requireCopy:
      options.command === "auth" ||
      options.command === "openclaw" ||
      (options.command === "local" &&
        (options.source === "checkout" ||
          (options.fixture !== undefined && options.fixture !== "empty"))),
  })

  const authMode = options.command === "auth" ? "ready" : options.authMode
  if (authMode === "ready" && !options.dryRun) {
    ensureLabAuthVolume(realSystem)
    assertReusableAuthAvailable(realSystem)
  }

  if (options.command === "auth") {
    const name = makeSandboxName("auth", options.name)
    const preflight = preflightAgents({
      authMode: "ready",
      includeOpenClaw: true,
    })
    if (options.dryRun) {
      console.log(
        JSON.stringify(
          {
            command: "auth",
            name,
            ttl: options.ttl,
            reusableProfile: true,
            importHost: options.importHost,
            agentVersions: preflight.versions,
            openclawSource: options.openclawSource ?? "verified package",
          },
          null,
          2
        )
      )
      return
    }
    const artifacts = prepareOpenClawArtifacts({
      ...(options.openclawSource
        ? { sourceDirectory: options.openclawSource }
        : {}),
    })
    let created = false
    try {
      createAgentSandbox({
        kind: "auth",
        name,
        ttl: options.ttl,
        preflight,
        authMode: "ready",
        openclaw: {
          version: artifacts.version,
          pluginArtifact: artifacts.pluginArtifact,
          ...(artifacts.runtimeArtifact
            ? { runtimeArtifact: artifacts.runtimeArtifact }
            : {}),
        },
      })
      created = true
      if (options.importHost) {
        const imports = importHostCredentials(name, realSystem)
        for (const result of imports)
          console.log(
            `[lab] ${result.provider}: ${result.imported ? "imported host file into the reusable lab profile" : result.reason}`
          )
        console.warn(
          "[lab] imported OAuth files now belong to the serialized lab profile; do not run host and lab refreshes concurrently"
        )
      }
      await attachSandbox(name)
    } finally {
      artifacts.cleanup()
      if (created) {
        console.log(`\n[lab] removing ${name}; reusable auth is retained`)
        removeSandbox(name)
      }
    }
    return
  }

  const network =
    (options.command === "local" || options.command === "openclaw") &&
    options.publicHost
      ? discoverNetworkOptional()
      : needsHostNetwork(options.command)
        ? discoverNetwork()
        : undefined
  const name = makeSandboxName(options.command, options.name)
  const callbackHostPort =
    options.command === "cloud" || options.command === "client"
      ? await allocatePort()
      : undefined
  const worktableHostPort =
    options.command === "local" || options.command === "openclaw"
      ? (options.hostPort ?? (await allocatePort()))
      : undefined
  if (
    (options.command === "local" || options.command === "openclaw") &&
    options.hostPort
  )
    await assertPortAvailable(options.hostPort)
  const preflight = preflightAgents({
    authMode,
    includeOpenClaw: options.command === "openclaw",
  })
  const localNetwork =
    options.command === "local" || options.command === "openclaw"
      ? buildLocalLabNetwork({
          hostPort: worktableHostPort!,
          ...(options.publicHost ? { publicHost: options.publicHost } : {}),
          ...(network ? { network } : {}),
        })
      : undefined

  if (
    (options.command === "local" || options.command === "openclaw") &&
    options.fixture &&
    options.fixture !== "empty"
  )
    fixturePath(options.fixture)
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          command: options.command,
          name,
          ttl: options.ttl,
          ...(network ? { lanAddress: network.lanAddress } : {}),
          ...(network?.tailscaleAddress
            ? { tailscaleAddress: network.tailscaleAddress }
            : {}),
          ...(callbackHostPort
            ? {
                callbackHostPort,
                callbackUrl: `http://${network!.lanAddress}:${callbackHostPort}/callback`,
              }
            : {}),
          ...(options.command === "local" || options.command === "openclaw"
            ? {
                source: options.source,
                fixture: options.fixture ?? null,
                hostPort: worktableHostPort,
                publicOrigin: localNetwork!.publicOrigin,
                checkoutArtifacts:
                  options.source === "checkout"
                    ? options.rebuild
                      ? "will rebuild"
                      : "will reuse or build"
                    : null,
              }
            : {}),
          ...(options.command === "cloud"
            ? { origin: options.origin }
            : options.command === "client"
              ? { target: options.target ?? null }
              : {}),
          agentVersions: preflight.versions,
          authMode,
          ...(options.command === "openclaw"
            ? {
                openclawRuntime: options.openclawSource
                  ? `source checkout: ${options.openclawSource}`
                  : `verified package ${preflight.versions.openclaw}`,
              }
            : {}),
          worktableConnection: "manual",
          providerAuthentication: {
            claude:
              authMode === "ready"
                ? "reusable isolated profile; lab-status verifies readiness"
                : preflight.auth.claude.kind === "secret"
                  ? `ephemeral ${preflight.auth.claude.envName}`
                  : "guest login required",
            codex:
              authMode === "ready"
                ? "reusable isolated profile; lab-status verifies readiness"
                : preflight.auth.codex.kind === "secret"
                  ? `ephemeral ${preflight.auth.codex.envName}`
                  : "guest login required",
          },
        },
        null,
        2
      )
    )
    return
  }

  removeOwnedSandboxes({ state: "stopped" })
  const checkoutArtifacts =
    (options.command === "local" || options.command === "openclaw") &&
    options.source === "checkout"
      ? prepareCheckoutArtifacts({
          rebuild: options.rebuild,
          system: realSystem,
        })
      : undefined
  const openclawArtifacts =
    options.command === "openclaw"
      ? prepareOpenClawArtifacts({
          ...(options.openclawSource
            ? { sourceDirectory: options.openclawSource }
            : {}),
        })
      : undefined
  let created = false
  try {
    createAgentSandbox({
      kind: options.command,
      name,
      ttl: options.ttl,
      ...(callbackHostPort ? { callbackHostPort } : {}),
      preflight,
      authMode,
      ...(openclawArtifacts
        ? {
            openclaw: {
              version: openclawArtifacts.version,
              pluginArtifact: openclawArtifacts.pluginArtifact,
              ...(openclawArtifacts.runtimeArtifact
                ? { runtimeArtifact: openclawArtifacts.runtimeArtifact }
                : {}),
            },
          }
        : {}),
      ...(network ? { network } : {}),
      ...(options.command === "cloud" ? { origin: options.origin } : {}),
      ...(options.command === "client" && options.target
        ? { target: options.target }
        : {}),
      ...(options.command === "local" || options.command === "openclaw"
        ? {
            local: {
              source: options.source,
              ...(options.fixture ? { fixture: options.fixture } : {}),
              network: localNetwork!,
              ...(checkoutArtifacts ? { checkoutArtifacts } : {}),
            },
          }
        : {}),
    })
    created = true
    await attachSandbox(name)
  } finally {
    openclawArtifacts?.cleanup()
    if (created) {
      console.log(`\n[lab] removing ${name}`)
      removeSandbox(name)
    }
  }
}

if (import.meta.main)
  runLab(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
