import { existsSync, lstatSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { LabAuthMode } from "./types.ts"
import type { SandboxSystem } from "./microsandbox.ts"

export const LAB_AUTH_VOLUME = "worktable-agent-auth-v1"
export const LAB_AUTH_LABEL = "auth-profile=worktable-agent-auth-v1"
export const LAB_AUTH_ROOT = "/run/worktable-lab-auth"

function runMsb(
  args: string[],
  system: SandboxSystem,
  options?: { inherit?: boolean }
): string {
  return system.run("msb", args, options)
}

export function ensureLabAuthVolume(system: SandboxSystem): void {
  const volumes = runMsb(["volume", "ls", "-q"], system)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (volumes.includes(LAB_AUTH_VOLUME)) return
  runMsb(["volume", "create", "--quiet", LAB_AUTH_VOLUME], system)
}

export function assertReusableAuthAvailable(system: SandboxSystem): void {
  const active = runMsb(
    [
      "ls",
      "-q",
      "--label",
      "app=worktable",
      "--label",
      LAB_AUTH_LABEL,
      "--running",
    ],
    system
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (active.length === 0) return
  throw new Error(
    `Reusable lab authentication is already mounted by ${active.join(", ")}. Exit that lab first, or use --clean for an independent unauthenticated lab.`
  )
}

export function authStorageArgs(mode: LabAuthMode): string[] {
  if (mode === "clean")
    return ["--tmpfs", `${LAB_AUTH_ROOT}:256M`, "--label", "auth-mode=clean"]
  return [
    "--mount-named",
    `${LAB_AUTH_VOLUME}:${LAB_AUTH_ROOT}`,
    "--label",
    LAB_AUTH_LABEL,
    "--label",
    "auth-mode=ready",
  ]
}

function safeCredentialFile(
  path: string,
  expectedParent: string
): string | null {
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Refusing to import non-regular credential file: ${path}`)
  const parent = realpathSync(expectedParent)
  const file = realpathSync(path)
  if (!file.startsWith(`${parent}/`))
    throw new Error(`Credential file escapes its expected profile: ${path}`)
  return file
}

export interface HostCredentialImport {
  provider: "claude" | "codex"
  imported: boolean
  reason?: string
}

/**
 * Explicit one-time bootstrap for a reusable lab profile. We never copy a host
 * OpenClaw profile or retain lab OpenClaw state: each OpenClaw lab owns a
 * disposable config, workspace, pairing, and session store. OpenClaw reaches
 * the reusable Codex login through its supported Codex-home configuration.
 */
export function importHostCredentials(
  sandbox: string,
  system: SandboxSystem
): HostCredentialImport[] {
  const claudeRoot = resolve(
    process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude")
  )
  const codexRoot = resolve(
    process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")
  )
  const candidates = [
    {
      provider: "claude" as const,
      source: safeCredentialFile(
        join(claudeRoot, ".credentials.json"),
        claudeRoot
      ),
      destination: `${LAB_AUTH_ROOT}/claude/.credentials.json`,
    },
    {
      provider: "codex" as const,
      source: safeCredentialFile(join(codexRoot, "auth.json"), codexRoot),
      destination: `${LAB_AUTH_ROOT}/codex/auth.json`,
    },
  ]
  const results: HostCredentialImport[] = []
  for (const candidate of candidates) {
    if (!candidate.source) {
      results.push({
        provider: candidate.provider,
        imported: false,
        reason: "No file-based host credential was found",
      })
      continue
    }
    runMsb(
      [
        "copy",
        "--quiet",
        candidate.source,
        `${sandbox}:${candidate.destination}`,
      ],
      system
    )
    runMsb(
      [
        "exec",
        sandbox,
        "--",
        "sh",
        "-c",
        `chown tester:tester "$1" && chmod 600 "$1"`,
        "sh",
        candidate.destination,
      ],
      system
    )
    results.push({ provider: candidate.provider, imported: true })
  }
  return results
}
