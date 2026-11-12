import { describe, expect, it } from "bun:test"
import {
  accessSettingsToKeep,
  decideAccess,
  memberId,
  ONE_PERSON,
  resolveOwnership,
  type Ownership,
  type WorktableAccess,
} from "./access.js"

const OWNER = "ptc_ownerownerowner"
const TEAMMATE = "ptc_teammateteammate"
const AGENT = "ptc_agentagentagent"

function access(overrides: Partial<WorktableAccess> = {}): WorktableAccess {
  return {
    trustOwnAgents: true,
    trustAllMembers: false,
    trustAllAgents: false,
    ...overrides,
  }
}

/** What a current Worktable says: who connected this agent and the author. */
function told(authorOwner?: string): Ownership {
  return { told: true, owner: OWNER, authorOwner }
}

function outcome(
  rule: WorktableAccess,
  ownership: Ownership,
  author: { id: string; kind?: string }
): string {
  const decision = decideAccess(rule, ownership, author, "Atlas")
  return decision.allowed
    ? decision.owner
      ? "owner"
      : "trusted"
    : decision.code
}

const person = (id: string) => ({ id, kind: "human" })
const agent = { id: AGENT, kind: "agent" }

describe("who may direct OpenClaw from a Worktable thread", () => {
  it("lets in the person who connected it, and other people only with their setting", () => {
    expect(outcome(access(), told(), person(OWNER))).toBe("owner")
    expect(outcome(access(), told(), person(TEAMMATE))).toBe("NOT_OWNER")
    const members = access({ trustAllMembers: true })
    expect(outcome(members, told(), person(TEAMMATE))).toBe("trusted")
    // Trusting people says nothing about other people's agents.
    expect(outcome(members, told(TEAMMATE), agent)).toBe("AGENT_NOT_TRUSTED")
  })

  it("lets in the agents its owner connected unless the owner turns that off", () => {
    expect(outcome(access(), told(OWNER), agent)).toBe("trusted")
    const off = access({ trustOwnAgents: false })
    expect(outcome(off, told(OWNER), agent)).toBe("AGENT_NOT_TRUSTED")
    // The owner is unaffected by a setting about agents.
    expect(outcome(off, told(), person(OWNER))).toBe("owner")
  })

  it("lets in another person's agent, or one nobody is on record for, only with its setting", () => {
    for (const authorOwner of [TEAMMATE, undefined]) {
      expect(outcome(access(), told(authorOwner), agent)).toBe(
        "AGENT_NOT_TRUSTED"
      )
      expect(
        outcome(access({ trustAllAgents: true }), told(authorOwner), agent)
      ).toBe("trusted")
    }
    // Trusting other people's agents says nothing about other people.
    expect(
      outcome(access({ trustAllAgents: true }), told(), person(TEAMMATE))
    ).toBe("NOT_OWNER")
  })

  it("never trusts an author the thread does not list as a person or an agent", () => {
    const open = access({ trustAllMembers: true, trustAllAgents: true })
    // Not even under the owner's id, or with the owner on record for it.
    expect(outcome(open, told(OWNER), { id: OWNER })).toBe("NOT_OWNER")
    expect(outcome(open, told(OWNER), { id: OWNER, kind: "system" })).toBe(
      "NOT_OWNER"
    )
    // The owner's id on an agent is an agent, not the owner.
    expect(outcome(access(), told(), { id: OWNER, kind: "agent" })).toBe(
      "AGENT_NOT_TRUSTED"
    )
  })

  it("lets nobody in while nobody is known to have connected it, and says what to do", () => {
    const open = access({ trustAllMembers: true, trustAllAgents: true })
    for (const author of [person(OWNER), person(TEAMMATE), agent]) {
      expect(outcome(open, { told: true }, author)).toBe("OWNER_UNKNOWN")
      expect(outcome(open, { told: false }, author)).toBe("WORKTABLE_TOO_OLD")
    }
    const message = (ownership: Ownership) => {
      const refusal = decideAccess(open, ownership, person(OWNER), "Atlas")
      return refusal.allowed ? "" : refusal.message
    }
    expect(message({ told: true })).toBe(
      "Connect Atlas to Worktable again before it can answer."
    )
    expect(message({ told: false })).toBe(
      "Update this Worktable to 0.1.45 or later before Atlas can answer."
    )
  })
})

describe("who connected this OpenClaw", () => {
  const never = () => Promise.reject(new Error("not asked"))

  it("takes Worktable's word with each message, so an earlier connection needs no reconnecting", async () => {
    // Nothing was recorded at pairing by a plugin that did not ask.
    expect(
      await resolveOwnership(
        { recipient: OWNER, author: TEAMMATE },
        undefined,
        never
      )
    ).toEqual({ told: true, owner: OWNER, authorOwner: TEAMMATE })
    // Worktable's word is current; what pairing recorded only stands in.
    expect(
      await resolveOwnership(
        { recipient: OWNER, author: null },
        TEAMMATE,
        never
      )
    ).toEqual({ told: true, owner: OWNER, authorOwner: undefined })
  })

  it("falls back to the approver recorded at pairing for an agent nobody is on record for", async () => {
    const said = { recipient: null, author: "everyone" }
    expect(await resolveOwnership(said, OWNER, never)).toEqual({
      told: true,
      owner: OWNER,
      authorOwner: undefined,
    })
    expect(await resolveOwnership(said, undefined, never)).toEqual({
      told: true,
      owner: undefined,
      authorOwner: undefined,
    })
  })

  it("treats everyone an older one-person Worktable lists as that person or theirs", async () => {
    const onePerson = await resolveOwnership(undefined, undefined, () =>
      Promise.resolve(true)
    )
    expect(onePerson).toEqual({ told: false, owner: ONE_PERSON })
    expect(outcome(access(), onePerson, person(OWNER))).toBe("owner")
    expect(outcome(access(), onePerson, agent)).toBe("trusted")
    expect(outcome(access({ trustOwnAgents: false }), onePerson, agent)).toBe(
      "AGENT_NOT_TRUSTED"
    )
    // Still only people and agents the thread lists.
    expect(outcome(access(), onePerson, { id: OWNER })).toBe("NOT_OWNER")
  })

  it("keeps to the approver recorded at pairing on an older Worktable with teammates", async () => {
    const team = () => Promise.resolve(false)
    const recorded = await resolveOwnership(undefined, OWNER, team)
    expect(recorded).toEqual({ told: false, owner: OWNER })
    expect(outcome(access(), recorded, person(OWNER))).toBe("owner")
    expect(outcome(access(), recorded, person(TEAMMATE))).toBe("NOT_OWNER")
    // It cannot say whose an agent is, so none counts as the owner's own.
    expect(outcome(access(), recorded, agent)).toBe("AGENT_NOT_TRUSTED")
    // With nothing recorded either, nobody is let in.
    expect(
      outcome(
        access(),
        await resolveOwnership(undefined, undefined, team),
        person(OWNER)
      )
    ).toBe("WORKTABLE_TOO_OLD")
  })

  it("accepts only a Worktable member id as a person", () => {
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

  it("keeps the owner's opt-ins only for the same Worktable and approver, and a restriction always", () => {
    const section = {
      server: "https://worktable.example.com",
      ownerMemberId: OWNER,
      trustOwnAgents: false,
      trustAllMembers: true,
      trustAllAgents: true,
    }
    expect(
      accessSettingsToKeep(section, {
        // The same address, written with a trailing slash.
        server: `${section.server}/`,
        ownerMemberId: OWNER,
      })
    ).toEqual({
      ownerMemberId: OWNER,
      trustOwnAgents: false,
      trustAllMembers: true,
      trustAllAgents: true,
    })
    expect(
      accessSettingsToKeep(section, {
        server: section.server,
        ownerMemberId: TEAMMATE,
      })
    ).toEqual({ ownerMemberId: TEAMMATE, trustOwnAgents: false })
    expect(
      accessSettingsToKeep(section, {
        server: section.server,
        ownerMemberId: undefined,
      })
    ).toEqual({ trustOwnAgents: false })
  })
})
