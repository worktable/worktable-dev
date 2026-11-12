import { describe, expect, it } from "bun:test"
import { decideAccess, memberId, type WorktableAccess } from "./access.js"

const OWNER = "ptc_ownerownerowner"
const MEMBER = "ptc_membermember01"
const AGENT = "ptc_agentagentagent"

function access(overrides: Partial<WorktableAccess> = {}): WorktableAccess {
  return {
    ownerMemberId: OWNER,
    trustAllMembers: false,
    trustAllAgents: false,
    ...overrides,
  }
}

function code(
  rule: WorktableAccess,
  author: { id: string; kind?: string }
): string {
  const decision = decideAccess(rule, author, "Atlas")
  return decision.allowed
    ? decision.owner
      ? "owner"
      : "trusted"
    : decision.code
}

describe("who may direct OpenClaw from a Worktable thread", () => {
  it("lets in only the person who approved the connection by default", () => {
    expect(code(access(), { id: OWNER, kind: "human" })).toBe("owner")
    expect(code(access(), { id: MEMBER, kind: "human" })).toBe("NOT_OWNER")
    expect(code(access(), { id: AGENT, kind: "agent" })).toBe(
      "AGENT_NOT_TRUSTED"
    )
  })

  it("lets other members in only with their setting, and other agents only with theirs", () => {
    const members = access({ trustAllMembers: true })
    expect(code(members, { id: MEMBER, kind: "human" })).toBe("trusted")
    expect(code(members, { id: AGENT, kind: "agent" })).toBe(
      "AGENT_NOT_TRUSTED"
    )

    const agents = access({ trustAllAgents: true })
    expect(code(agents, { id: AGENT, kind: "agent" })).toBe("trusted")
    expect(code(agents, { id: MEMBER, kind: "human" })).toBe("NOT_OWNER")
  })

  it("never trusts an author the thread does not list as a person or an agent", () => {
    const open = access({ trustAllMembers: true, trustAllAgents: true })
    // Not even under the owner's id.
    expect(code(open, { id: OWNER })).toBe("NOT_OWNER")
    expect(code(access(), { id: OWNER, kind: "agent" })).toBe(
      "AGENT_NOT_TRUSTED"
    )
    expect(code(open, { id: MEMBER, kind: "system" })).toBe("NOT_OWNER")
  })

  it("lets nobody in while no owner is on record, whatever is trusted", () => {
    const open = access({
      ownerMemberId: undefined,
      trustAllMembers: true,
      trustAllAgents: true,
    })
    for (const author of [
      { id: OWNER, kind: "human" },
      { id: MEMBER, kind: "human" },
      { id: AGENT, kind: "agent" },
    ]) {
      expect(code(open, author)).toBe("OWNER_UNKNOWN")
    }
    const refusal = decideAccess(open, { id: OWNER, kind: "human" }, "Atlas")
    expect(refusal.allowed ? "" : refusal.message).toBe(
      "Connect Atlas to Worktable again before it can answer. This needs Worktable 0.1.44 or later."
    )
  })

  it("accepts only a Worktable member id as the owner on record", () => {
    expect(memberId(OWNER)).toBe(OWNER)
    for (const value of [
      "",
      "*",
      "everyone",
      "ptc_short",
      7,
      null,
      undefined,
    ]) {
      expect(memberId(value)).toBeUndefined()
    }
  })
})
