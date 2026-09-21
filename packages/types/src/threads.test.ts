import { describe, expect, it } from "bun:test"
import {
  ThreadSchema,
  ThreadV3Schema,
  threadLocation,
  upgradeThreadToV3,
} from "./threads"

const base = {
  type: "worktable.thread" as const,
  id: "thr_abcdefghijkl",
  title: "A portable thread",
  participants: [
    { id: "ptc_abcdefghijkl", kind: "human" as const, name: "Finn" },
    { id: "ptc_mnopqrstuvwx", kind: "agent" as const, name: "Atlas" },
  ],
  revision: 1,
  messages: [
    {
      id: "msg_abcdefghijkl",
      sequence: 1,
      authorId: "ptc_abcdefghijkl",
      recipientIds: ["ptc_mnopqrstuvwx"],
      body: "Hello.",
      expectsReply: true,
      idempotencyKey: "first",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

describe("portable thread versions", () => {
  it("parses V1 and normalizes its Space location", () => {
    const thread = ThreadSchema.parse({
      ...base,
      version: 1,
      spaceId: "research",
    })
    expect(threadLocation(thread)).toEqual({
      kind: "space",
      spaceId: "research",
    })
  })

  it("preserves additive fields in portable V1 envelopes", () => {
    const thread = ThreadSchema.parse({
      ...base,
      version: 1,
      spaceId: "research",
      externalSession: { provider: "another-tool", id: "session-1" },
    })
    expect(thread).toMatchObject({
      externalSession: { provider: "another-tool", id: "session-1" },
    })
    expect(upgradeThreadToV3(thread)).toMatchObject({
      version: 3,
      spaceId: "research",
      externalSession: { provider: "another-tool", id: "session-1" },
    })
  })

  it("disambiguates duplicate legacy names without losing the thread", () => {
    for (const legacyLocation of [
      { version: 1 as const, spaceId: "research" },
      {
        version: 2 as const,
        location: { kind: "worktable" as const },
      },
    ]) {
      const legacy = ThreadSchema.parse({
        ...base,
        ...legacyLocation,
        participants: [
          base.participants[0],
          { ...base.participants[1], name: "finn" },
          {
            id: "ptc_zyxwvutsrqpo",
            kind: "agent" as const,
            name: "Finn (2)",
          },
        ],
      })

      expect(
        upgradeThreadToV3(legacy).identities.map((identity) => identity.name)
      ).toEqual(["Finn", "finn (2)", "Finn (2) (2)"])
    }
  })

  it("parses Worktable and Space V2 locations", () => {
    for (const location of [
      { kind: "worktable" as const },
      { kind: "space" as const, spaceId: "research" },
    ]) {
      const thread = ThreadSchema.parse({ ...base, version: 2, location })
      expect(threadLocation(thread)).toEqual(location)
    }
  })

  it("rejects mixed or incomplete version and location fields", () => {
    expect(
      ThreadSchema.safeParse({
        ...base,
        version: 1,
        spaceId: "research",
        location: { kind: "worktable" },
      }).success
    ).toBe(false)
    expect(
      ThreadSchema.safeParse({
        ...base,
        version: 2,
        location: { kind: "worktable" },
        spaceId: "research",
      }).success
    ).toBe(false)
    expect(ThreadSchema.safeParse({ ...base, version: 2 }).success).toBe(false)
  })

  it("mechanically upgrades V2 members, identities, and response intent", () => {
    const legacy = ThreadSchema.parse({
      ...base,
      version: 2,
      location: { kind: "worktable" },
      messages: [
        {
          ...base.messages[0],
          body: "[Finn → Atlas] Please check this.",
        },
        {
          id: "msg_mnopqrstuvwx",
          sequence: 2,
          authorId: "ptc_abcdefghijkl",
          recipientIds: ["ptc_mnopqrstuvwx"],
          body: "One clarification before Atlas answers.",
          inReplyTo: "msg_abcdefghijkl",
          expectsReply: false,
          idempotencyKey: "clarification",
          createdAt: "2026-01-01T00:00:30.000Z",
        },
        {
          id: "msg_zyxwvutsrqpo",
          sequence: 3,
          authorId: "ptc_mnopqrstuvwx",
          recipientIds: ["ptc_abcdefghijkl"],
          body: "Done.",
          inReplyTo: "msg_abcdefghijkl",
          expectsReply: false,
          idempotencyKey: "reply",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ],
      revision: 3,
      updatedAt: "2026-01-01T00:01:00.000Z",
    })

    const upgraded = upgradeThreadToV3(legacy)

    expect(upgraded).toMatchObject({
      version: 3,
      members: [{ id: "ptc_abcdefghijkl" }, { id: "ptc_mnopqrstuvwx" }],
      identities: [
        {
          id: "idt_abcdefghijkl",
          memberId: "ptc_abcdefghijkl",
          name: "Finn",
          default: true,
        },
        {
          id: "idt_mnopqrstuvwx",
          memberId: "ptc_mnopqrstuvwx",
          name: "Atlas",
          default: true,
        },
      ],
    })
    expect(upgraded.messages[0]).toMatchObject({
      body: "[Finn → Atlas] Please check this.",
      authorIdentityId: "idt_abcdefghijkl",
      notifyIdentityIds: [],
      responseRequest: {
        identityId: "idt_mnopqrstuvwx",
        status: "responded",
        respondedBy: "msg_zyxwvutsrqpo",
      },
    })
    expect(upgraded.messages[2]).toMatchObject({
      authorIdentityId: "idt_mnopqrstuvwx",
      inReplyTo: "msg_abcdefghijkl",
    })
    expect(upgraded.messages[2]?.responseRequest).toBeUndefined()
  })

  it("accepts general posts and visible mentions without conflating replies", () => {
    const createdAt = "2026-01-01T00:00:00.000Z"
    const thread = {
      type: "worktable.thread" as const,
      version: 3 as const,
      id: "thr_abcdefghijkl",
      location: { kind: "worktable" as const },
      title: "A V3 conversation",
      members: [
        {
          id: "ptc_abcdefghijkl",
          kind: "agent" as const,
          name: "Codex",
          addedAt: createdAt,
        },
      ],
      identities: [
        {
          id: "idt_abcdefghijkl",
          memberId: "ptc_abcdefghijkl",
          name: "Research",
          default: true,
          status: "active" as const,
          createdAt,
          updatedAt: createdAt,
        },
      ],
      revision: 2,
      messages: [
        {
          id: "msg_abcdefghijkl",
          sequence: 1,
          authorIdentityId: "idt_abcdefghijkl",
          authorMemberId: "ptc_abcdefghijkl",
          notifyIdentityIds: [],
          body: "General context.",
          idempotencyKey: "general",
          createdAt,
        },
        {
          id: "msg_mnopqrstuvwx",
          sequence: 2,
          authorIdentityId: "idt_abcdefghijkl",
          authorMemberId: "ptc_abcdefghijkl",
          notifyIdentityIds: ["idt_abcdefghijkl"],
          body: "@Research, continue this in the next session.",
          idempotencyKey: "handoff",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ],
      createdAt,
      updatedAt: "2026-01-01T00:01:00.000Z",
    }

    expect(ThreadV3Schema.parse(thread)).toEqual(thread)

    expect(
      ThreadV3Schema.safeParse({
        ...thread,
        identities: [
          ...thread.identities,
          {
            ...thread.identities[0],
            id: "idt_mnopqrstuvwx",
            default: false,
            name: "research",
          },
        ],
      }).success
    ).toBe(false)

    expect(
      ThreadV3Schema.safeParse({
        ...thread,
        messages: [
          {
            ...thread.messages[0],
            responseRequest: {
              identityId: "idt_abcdefghijkl",
              status: "responded",
              respondedBy: "msg_mnopqrstuvwx",
              resolvedAt: "2026-01-01T00:01:00.000Z",
            },
          },
          thread.messages[1],
        ],
      }).success
    ).toBe(false)
  })
})
