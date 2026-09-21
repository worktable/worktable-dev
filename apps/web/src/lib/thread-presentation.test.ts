import { describe, expect, test } from "bun:test"
import type {
  ConversationIdentity,
  ThreadActivity,
  ThreadMember,
  ThreadMessage,
} from "@worktable/types"

import {
  availableConversationIdentities,
  beginsLocalCalendarDate,
  conversationIdentityDescription,
  deliveryPresentation,
  directAlwaysOnAgentIdentity,
  isCurrentAssignmentActivity,
  resolveMessageAuthor,
  resolveReplyTarget,
  threadExcerpt,
  threadMentionRequestsResponse,
  visibleNonterminalActivityKeys,
} from "./thread-presentation"

const createdAt = "2026-08-03T12:00:00.000Z"
const members: ThreadMember[] = [
  {
    id: "ptc_humanparticipant",
    kind: "human",
    name: "Atlas H",
    addedAt: createdAt,
  },
  {
    id: "ptc_agentparticipant",
    kind: "agent",
    name: "Atlas",
    addedAt: createdAt,
  },
]
const identities: ConversationIdentity[] = [
  {
    id: "idt_humanparticipant",
    memberId: members[0]!.id,
    name: "Atlas H",
    default: true,
    status: "active",
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: "idt_agentparticipant",
    memberId: members[1]!.id,
    name: "Atlas",
    default: true,
    status: "active",
    createdAt,
    updatedAt: createdAt,
  },
]

const message: ThreadMessage = {
  id: "msg_firstmessage00",
  sequence: 1,
  authorIdentityId: identities[1]!.id,
  authorMemberId: members[1]!.id,
  notifyIdentityIds: [],
  responseRequest: { identityId: identities[0]!.id, status: "open" },
  body: "# A useful [answer](https://example.com)\n\nWith details.",
  idempotencyKey: "first",
  createdAt: "2026-08-03T12:00:00.000Z",
}

function activity(
  state: ThreadActivity["state"],
  attempts = 0
): ThreadActivity {
  return {
    messageId: message.id,
    participantId: members[1]!.id,
    state,
    revision: 1,
    attempts,
    updatedAt: "2026-08-03T12:00:00.000Z",
    ...(state === "failed"
      ? {
          error: {
            code: "NOPE",
            message: "Agent unavailable",
            retryable: false,
          },
        }
      : {}),
  }
}

describe("thread presentation", () => {
  test("infers direct replies only for always-on agents", () => {
    expect(
      directAlwaysOnAgentIdentity(
        members,
        identities,
        [{ id: members[1]!.id, alwaysOn: true }],
        members[0]!.id
      )
    ).toBe(identities[1])
    expect(
      directAlwaysOnAgentIdentity(
        members,
        identities,
        [{ id: members[1]!.id, alwaysOn: false }],
        members[0]!.id
      )
    ).toBeUndefined()
  })

  test("promotes mentions only when they make or address a group", () => {
    const prospectiveIdentity = {
      ...identities[1]!,
      id: "idt_prospectiveagent",
      memberId: "ptc_prospectiveagent",
    }
    const groupMembers = [
      ...members,
      {
        id: "ptc_groupmember",
        kind: "human" as const,
        name: "Maya",
        addedAt: createdAt,
      },
    ]

    expect(threadMentionRequestsResponse(members, identities[1]!)).toBe(false)
    expect(threadMentionRequestsResponse(members, prospectiveIdentity)).toBe(
      true
    )
    expect(threadMentionRequestsResponse(groupMembers, identities[1]!)).toBe(
      true
    )
  })

  test("builds readable bounded Markdown excerpts", () => {
    expect(threadExcerpt(message.body, 140)).toBe(
      "A useful answer With details."
    )
    expect(threadExcerpt("A".repeat(160), 140)).toHaveLength(140)
  })

  test("resolves message authors and reply targets by durable id", () => {
    expect(resolveMessageAuthor(members, identities, message)).toEqual({
      id: members[1]!.id,
      kind: "agent",
      name: "Atlas",
    })
    expect(resolveReplyTarget([message], message.id)).toBe(message)
    expect(resolveReplyTarget([message], "msg_missingtarget00")).toBeUndefined()
  })

  test("identifies local date boundaries", () => {
    const before = new Date(2026, 7, 3, 23, 59)
    const after = new Date(2026, 7, 4, 0, 1)
    expect(beginsLocalCalendarDate(before)).toBe(true)
    expect(beginsLocalCalendarDate(after, before)).toBe(true)
    expect(beginsLocalCalendarDate(new Date(2026, 7, 3, 12), before)).toBe(
      false
    )
  })

  test("names every delivery state without announcing durable replies twice", () => {
    expect(deliveryPresentation(activity("queued"), "Atlas")).toEqual({
      label: "Assigned to Atlas",
      visible: true,
      live: false,
      failed: false,
    })
    expect(deliveryPresentation(activity("queued", 1), "Atlas").label).toBe(
      "Retrying Atlas · attempt 2"
    )
    expect(deliveryPresentation(activity("working", 1), "Atlas").live).toBe(
      true
    )
    expect(deliveryPresentation(activity("receiving", 1), "Atlas").label).toBe(
      "Atlas is responding…"
    )
    expect(deliveryPresentation(activity("failed", 3), "Atlas")).toMatchObject({
      label: "Agent unavailable after 3 attempts",
      visible: true,
      failed: true,
    })
    expect(deliveryPresentation(activity("replied", 1), "Atlas").visible).toBe(
      false
    )
    expect(
      deliveryPresentation(
        {
          ...activity("failed"),
          error: {
            code: "DELIVERY_RETIRED",
            message: "The assignment changed.",
            retryable: false,
          },
        },
        "Atlas"
      )
    ).toMatchObject({ visible: false, failed: false })
  })

  test("shows every active delivery by message and conversation identity", () => {
    const olderResearch = {
      ...activity("queued"),
      messageId: "msg_olderresearch0",
      identityId: "idt_research0000",
    }
    const research = {
      ...activity("receiving"),
      identityId: "idt_research0000",
    }
    const review = {
      ...activity("working"),
      identityId: "idt_review000000",
    }
    const selected = visibleNonterminalActivityKeys([
      olderResearch,
      research,
      review,
    ])

    expect(selected).toEqual(
      new Set([
        `msg_olderresearch0:idt_research0000`,
        `${message.id}:idt_research0000`,
        `${message.id}:idt_review000000`,
      ])
    )
  })

  test("shows delivery state only for the message's current assignment", () => {
    const retired = {
      ...activity("failed"),
      identityId: "idt_previousagent0",
      error: {
        code: "DELIVERY_RETIRED",
        message: "The assignment changed.",
        retryable: false,
      },
    }
    const current = {
      ...activity("queued"),
      identityId: identities[0]!.id,
    }

    expect(isCurrentAssignmentActivity(message, retired)).toBe(false)
    expect(isCurrentAssignmentActivity(message, current)).toBe(true)
    expect(
      isCurrentAssignmentActivity(
        {
          ...message,
          responseRequest: {
            ...message.responseRequest!,
            status: "withdrawn",
            resolvedAt: createdAt,
          },
        },
        current
      )
    ).toBe(false)
    expect(
      isCurrentAssignmentActivity(
        { ...message, responseRequest: undefined },
        retired
      )
    ).toBe(false)
  })

  test("disambiguates active identities with the same visible name", () => {
    const duplicate = {
      ...identities[0]!,
      id: "idt_duplicateperson",
      memberId: members[1]!.id,
      name: identities[0]!.name,
    }
    expect(
      conversationIdentityDescription(identities[0]!, members, [
        ...identities,
        duplicate,
      ])
    ).toBe("Person 1")
    expect(
      conversationIdentityDescription(duplicate, members, [
        ...identities,
        duplicate,
      ])
    ).toBe("Atlas")
  })

  test("presents collision-safe names for prospective default identities", () => {
    const active = {
      ...identities[1]!,
      name: "Sam",
    }
    const later = {
      id: "ptc_same_name_z",
      kind: "agent" as const,
      name: "Sam",
    }
    const earlier = {
      id: "ptc_same_name_a",
      kind: "agent" as const,
      name: "Sam",
    }

    const options = availableConversationIdentities([active], [later, earlier])
    expect(
      Object.fromEntries(
        options.map((identity) => [identity.memberId, identity.name])
      )
    ).toEqual({
      [active.memberId]: "Sam",
      [later.id]: "Sam (3)",
      [earlier.id]: "Sam (2)",
    })
  })
})
