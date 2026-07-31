import { describe, expect, it } from "bun:test"
import {
  claimWithThreadLocations,
  worktableAgentPresentationHeaders,
} from "./worktable-client.js"

describe("OpenClaw Worktable client", () => {
  it("keeps Unicode participant names out of ByteString headers", () => {
    const headers = worktableAgentPresentationHeaders({
      adapter: "openclaw",
      installationId: "agent_reg_1",
      label: "OpenClaw · 智能助手 😀",
      machine: "máquina-一",
    })

    expect(headers).toEqual({
      "x-worktable-agent-adapter": "openclaw",
      "x-worktable-agent-installation": "agent_reg_1",
      "x-worktable-agent-label": "OpenClaw",
      "x-worktable-agent-machine": "maquina-",
    })
    expect(() => new Headers(headers)).not.toThrow()
  })

  it("advertises location support while claiming deliveries", async () => {
    const requests: Array<Record<string, unknown>> = []
    const result = await claimWithThreadLocations(async (request) => {
      requests.push(request)
      return { delivery: null }
    }, 25)

    expect(requests).toEqual([
      {
        action: "claim",
        waitSeconds: 25,
        threadLocationVersion: 2,
      },
    ])
    expect(result).toEqual({ delivery: null })
  })

  it("propagates claim failures", async () => {
    const failure = Object.assign(new Error("Unauthorized"), { code: 401 })
    await expect(
      claimWithThreadLocations(() => Promise.reject(failure), 0)
    ).rejects.toBe(failure)
  })
})
