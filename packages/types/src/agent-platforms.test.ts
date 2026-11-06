import { describe, expect, it } from "bun:test"
import {
  clientIdForAgentLabel,
  clientIdForSignInPrincipal,
  platformForClient,
  platformForName,
  signInAgentName,
} from "./agent-platforms.ts"
import { agentConnectionPlatform } from "./agent-connections.ts"

describe("agent platforms", () => {
  it("knows an agent's platform from its client, label, or name", () => {
    expect(platformForClient("Codex")).toBe("codex")
    expect(clientIdForAgentLabel("managed:claude-code")).toBe("claude-code")
    expect(platformForName("Hermes Agent")).toBe("hermes")
    expect(platformForName("ChatGPT")).toBe("chatgpt")
    expect(platformForName("claude-code@work-laptop")).toBe("claude-code")
    expect(platformForName("Sage (Codex)")).toBe("codex")
    expect(platformForName("Sage (a helper)")).toBe("other")
  })

  it("knows a sign-in's app from its signed client id, not its name", () => {
    // Codex signs in for ChatGPT Desktop's own MCP servers and for Codex CLI.
    const codex = "https://chatgpt.com/oauth/codex/AbCdEf123456/client.json"
    expect(platformForClient(codex)).toBe("chatgpt-desktop")
    expect(
      platformForClient("https://chatgpt.com/oauth/GhIjKl789012/client.json")
    ).toBe("chatgpt")
    expect(
      platformForClient("https://claude.ai/oauth/claude-code-client-metadata")
    ).toBe("claude-code")
    // Only the vendor's own origin counts.
    for (const lookalike of [
      "https://chatgpt.com.example/oauth/codex/x/client.json",
      "http://chatgpt.com/oauth/codex/x/client.json",
      "client_01EXAMPLEDYNAMICREGISTRATION",
    ])
      expect(platformForClient(lookalike)).toBe("other")

    const principal = `oauth:${codex}:user_01`
    expect(clientIdForSignInPrincipal(principal)).toBe(codex)
    expect(signInAgentName(principal, "Codex")).toBe("ChatGPT Desktop")
    // A self-registered client keeps the name it gave itself.
    expect(signInAgentName("oauth:client_01:user_01", "Cursor")).toBe("Cursor")
    // The signed id outweighs a platform recorded from the name before.
    expect(
      agentConnectionPlatform({
        platform: "codex",
        target: { kind: "mcp-client", clientId: codex },
        displayName: "Codex",
      })
    ).toBe("chatgpt-desktop")
  })

  it("does not take built-in object keys for platforms", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(platformForName(name)).toBe("other")
      expect(platformForClient(name)).toBe("other")
      expect(clientIdForAgentLabel(name)).toBeNull()
    }
  })
})
