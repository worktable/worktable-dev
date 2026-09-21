import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AgentPreflight, ProviderAuth } from "./types.ts"

export interface AgentSystem {
  run(command: string, args: string[], env?: NodeJS.ProcessEnv): string
  env: NodeJS.ProcessEnv
}

const realSystem: AgentSystem = {
  run(command, args, env) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(
        result.stderr ||
          result.stdout ||
          `${command} exited with status ${result.status ?? "unknown"}`
      )
    }
    return `${result.stdout ?? ""}${result.stderr ?? ""}`
  },
  env: process.env,
}

export function parseClaudeVersion(output: string): string {
  const version = output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]
  if (!version)
    throw new Error(
      `Could not parse Claude Code version from: ${output.trim()}`
    )
  return version
}

export function parseCodexVersion(output: string): string {
  const version = output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]
  if (!version)
    throw new Error(`Could not parse Codex version from: ${output.trim()}`)
  return version
}

function present(value: string | undefined): boolean {
  return Boolean(value?.trim())
}

// Desktop OAuth caches are intentionally not portable credentials. Both CLIs
// can refresh them in place, so a disposable copy can rotate the server-side
// session and strand the host with stale tokens. Accept only provider-supported
// environment credentials; otherwise authenticate in the guest's tmpfs profile.
export function selectAgentAuth(
  env: NodeJS.ProcessEnv
): AgentPreflight["auth"] {
  let claude: ProviderAuth = { kind: "guest-login" }
  if (present(env.ANTHROPIC_API_KEY)) {
    claude = {
      kind: "secret",
      envName: "ANTHROPIC_API_KEY",
      allowedHost: "api.anthropic.com",
    }
  } else if (present(env.CLAUDE_CODE_OAUTH_TOKEN)) {
    claude = {
      kind: "secret",
      envName: "CLAUDE_CODE_OAUTH_TOKEN",
      allowedHost: "api.anthropic.com",
    }
  }

  const codex: ProviderAuth = present(env.OPENAI_API_KEY)
    ? {
        kind: "secret",
        envName: "OPENAI_API_KEY",
        allowedHost: "api.openai.com",
      }
    : { kind: "guest-login" }

  return { claude, codex }
}

export function preflightAgents(
  options: { authMode?: "ready" | "clean"; includeOpenClaw?: boolean } = {},
  system: AgentSystem = realSystem
): AgentPreflight {
  let claudeVersionOutput: string
  try {
    claudeVersionOutput = system.run("claude", ["--version"])
  } catch {
    throw new Error(
      "Claude Code is not installed on the host. Install it before starting a lab."
    )
  }
  let codexVersionOutput: string
  try {
    codexVersionOutput = system.run("codex", ["--version"])
  } catch {
    throw new Error(
      "Codex is not installed on the host. Install it before starting a lab."
    )
  }

  const auth =
    options.authMode === "clean"
      ? {
          claude: { kind: "guest-login" } as const,
          codex: { kind: "guest-login" } as const,
        }
      : selectAgentAuth(system.env)
  const openclaw = options.includeOpenClaw
    ? verifiedOpenClawVersion()
    : undefined
  return {
    versions: {
      claude: parseClaudeVersion(claudeVersionOutput),
      codex: parseCodexVersion(codexVersionOutput),
      ...(openclaw ? { openclaw } : {}),
    },
    auth,
  }
}

export function verifiedOpenClawVersion(): string {
  const packagePath = resolve(
    import.meta.dir,
    "../../packages/openclaw-plugin/package.json"
  )
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
    peerDependencies?: { openclaw?: unknown }
    devDependencies?: { openclaw?: unknown }
  }
  const version = pkg.devDependencies?.openclaw
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-\d+)?$/.test(version))
    throw new Error(
      "packages/openclaw-plugin must pin one exact verified OpenClaw development dependency"
    )
  if (pkg.peerDependencies?.openclaw !== `>=${version}`)
    throw new Error(
      "packages/openclaw-plugin must support the verified OpenClaw version and newer compatible hosts"
    )
  return version
}
