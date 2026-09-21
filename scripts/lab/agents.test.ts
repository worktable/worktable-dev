import { describe, expect, test } from "bun:test"
import {
  parseClaudeVersion,
  parseCodexVersion,
  preflightAgents,
  selectAgentAuth,
  type AgentSystem,
  verifiedOpenClawVersion,
} from "./agents.ts"

function fakeSystem(overrides: Partial<AgentSystem> = {}): AgentSystem {
  return {
    env: {},
    run(command, args) {
      const key = `${command} ${args.join(" ")}`
      if (key === "claude --version") return "2.1.211 (Claude Code)\n"
      if (key === "codex --version") return "codex-cli 0.144.5\n"
      throw new Error(`unexpected: ${key}`)
    },
    ...overrides,
  }
}

describe("agent preflight", () => {
  test("parses exact host versions without cloning host login caches", () => {
    expect(parseClaudeVersion("2.1.211 (Claude Code)")).toBe("2.1.211")
    expect(parseCodexVersion("codex-cli 0.144.5")).toBe("0.144.5")
    const result = preflightAgents({}, fakeSystem())
    expect(result.versions).toEqual({ claude: "2.1.211", codex: "0.144.5" })
    expect(result.auth).toEqual({
      claude: { kind: "guest-login" },
      codex: { kind: "guest-login" },
    })
  })

  test("selects supported ephemeral environment credentials", () => {
    expect(
      selectAgentAuth({
        CLAUDE_CODE_OAUTH_TOKEN: "claude-secret",
        OPENAI_API_KEY: "openai-secret",
      })
    ).toEqual({
      claude: {
        kind: "secret",
        envName: "CLAUDE_CODE_OAUTH_TOKEN",
        allowedHost: "api.anthropic.com",
      },
      codex: {
        kind: "secret",
        envName: "OPENAI_API_KEY",
        allowedHost: "api.openai.com",
      },
    })
  })

  test("prefers an Anthropic API key when both supported Claude credentials exist", () => {
    expect(
      selectAgentAuth({
        ANTHROPIC_API_KEY: "api-key",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      }).claude
    ).toEqual({
      kind: "secret",
      envName: "ANTHROPIC_API_KEY",
      allowedHost: "api.anthropic.com",
    })
  })

  test("does not expose credential values in its result", () => {
    const serialized = JSON.stringify(
      preflightAgents(
        {},
        fakeSystem({
          env: {
            ANTHROPIC_API_KEY: "anthropic-do-not-print",
            OPENAI_API_KEY: "openai-do-not-print",
          },
        })
      )
    )
    expect(serialized).not.toContain("do-not-print")
  })

  test("fails before sandbox creation when a CLI is unavailable", () => {
    const system = fakeSystem({
      run(command, args) {
        if (command === "claude") throw new Error("missing")
        return fakeSystem().run(command, args)
      },
    })
    expect(() => preflightAgents({}, system)).toThrow("not installed")
  })

  test("reads one exact verified OpenClaw compatibility version", () => {
    expect(verifiedOpenClawVersion()).toMatch(/^\d+\.\d+\.\d+(?:-\d+)?$/)
    expect(
      preflightAgents(
        { authMode: "clean", includeOpenClaw: true },
        fakeSystem()
      )
    ).toMatchObject({
      versions: { openclaw: verifiedOpenClawVersion() },
      auth: {
        claude: { kind: "guest-login" },
        codex: { kind: "guest-login" },
      },
    })
  })
})
