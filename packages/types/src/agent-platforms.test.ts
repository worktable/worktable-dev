import { describe, expect, it } from "bun:test"
import {
  clientIdForAgentLabel,
  platformForClient,
  platformForName,
} from "./agent-platforms.ts"

describe("agent platforms", () => {
  it("knows an agent's platform from its client, label, or name", () => {
    expect(platformForClient("Codex")).toBe("codex")
    expect(clientIdForAgentLabel("managed:claude-code")).toBe("claude-code")
    expect(platformForName("Hermes Agent")).toBe("hermes")
    expect(platformForName("ChatGPT")).toBe("chatgpt")
  })

  it("does not take built-in object keys for platforms", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(platformForName(name)).toBe("other")
      expect(platformForClient(name)).toBe("other")
      expect(clientIdForAgentLabel(name)).toBeNull()
    }
  })
})
