import { describe, expect, test } from "bun:test"
import {
  ThreadSchema,
  upgradeThreadToV3,
  type Thread,
  type ThreadActivity,
} from "@worktable/types"
import {
  availableParticipantSelection,
  pendingHumanReplyTarget,
} from "./thread-replies"

const legacyThread = {
  type: "worktable.thread",
  version: 1,
  id: "thr_abcdefghijklmnop",
  spaceId: "connected-agents",
  title: "Proactive message",
  participants: [
    { id: "ptc_humanparticipant", kind: "human", name: "Owner" },
    { id: "ptc_agentparticipant", kind: "agent", name: "Atlas" },
  ],
  revision: 1,
  messages: [
    {
      id: "msg_proactivemessage",
      sequence: 1,
      authorId: "ptc_agentparticipant",
      recipientIds: ["ptc_humanparticipant"],
      body: "I found something useful.",
      expectsReply: true,
      idempotencyKey: "proactive",
      createdAt: "2026-07-25T00:00:00.000Z",
    },
  ],
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
}
const thread: Thread = upgradeThreadToV3(ThreadSchema.parse(legacyThread))

function activity(state: ThreadActivity["state"]): ThreadActivity {
  return {
    messageId: "msg_proactivemessage",
    participantId: "ptc_humanparticipant",
    state,
    revision: 1,
    attempts: 0,
    updatedAt: "2026-07-25T00:00:00.000Z",
  }
}

describe("thread reply targeting", () => {
  test("links a web reply to the latest open human-addressed delivery", () => {
    expect(
      pendingHumanReplyTarget(
        thread,
        [activity("queued")],
        "ptc_humanparticipant"
      )
    ).toBe("msg_proactivemessage")
    const withdrawn: Thread = {
      ...thread,
      messages: [
        {
          ...thread.messages[0]!,
          responseRequest: {
            identityId: "idt_humanparticipant",
            status: "withdrawn",
            resolvedAt: "2026-07-25T00:01:00.000Z",
          },
        },
      ],
    }
    expect(
      pendingHumanReplyTarget(
        withdrawn,
        [activity("queued")],
        "ptc_humanparticipant"
      )
    ).toBeUndefined()
  })

  test("links a two-human reply only to a message addressed to the viewer", () => {
    const humanThread = upgradeThreadToV3(
      ThreadSchema.parse({
        ...legacyThread,
        participants: [
          { id: "ptc_humanparticipant", kind: "human", name: "Owner" },
          { id: "ptc_otherhumanmember", kind: "human", name: "Collaborator" },
        ],
        messages: [
          {
            ...legacyThread.messages[0]!,
            id: "msg_forowner123456",
            authorId: "ptc_otherhumanmember",
            recipientIds: ["ptc_humanparticipant"],
          },
          {
            ...legacyThread.messages[0]!,
            id: "msg_forother123456",
            sequence: 2,
            authorId: "ptc_humanparticipant",
            recipientIds: ["ptc_otherhumanmember"],
          },
        ],
      })
    )

    expect(
      pendingHumanReplyTarget(humanThread, [], "ptc_humanparticipant")
    ).toBe("msg_forowner123456")
    expect(
      pendingHumanReplyTarget(humanThread, [], "ptc_otherhumanmember")
    ).toBe("msg_forother123456")
  })

  test("replaces a participant selection that is no longer discoverable", () => {
    expect(
      availableParticipantSelection(
        [
          { id: "ptc_firstagent", kind: "agent", name: "Finn" },
          { id: "ptc_secondagent", kind: "agent", name: "Atlas" },
        ],
        "ptc_revokedagent"
      )
    ).toBe("ptc_firstagent")
    expect(availableParticipantSelection([], "ptc_revokedagent")).toBe("")
  })
})
