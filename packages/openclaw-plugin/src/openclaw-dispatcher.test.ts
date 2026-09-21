import { describe, expect, test } from "bun:test"
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core"
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store"
import {
  OpenClawAgentDispatcher,
  WORKTABLE_COLLABORATION_PROMPT,
  worktableSessionRoute,
} from "./openclaw-dispatcher.js"

function fakeRuntime(
  inspect: (params: Record<string, unknown>) => Promise<void> | void
): PluginRuntime {
  const route = {
    accountId: "default",
    agentId: "main",
    sessionKey: "agent:main:worktable:direct:thr_one",
  }
  return {
    channel: {
      routing: {
        resolveAgentRoute: () => route,
      },
      session: {
        resolveStorePath: () => "/tmp/openclaw-sessions.json",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => undefined,
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: (context: Record<string, unknown>) => context,
        dispatchReplyWithBufferedBlockDispatcher: async () => ({
          counts: {},
        }),
      },
      inbound: {
        dispatchReply: inspect,
      },
    },
  } as unknown as PluginRuntime
}

describe("OpenClawAgentDispatcher", () => {
  test("uses the channel turn kernel and returns its visible final reply", async () => {
    let dispatched: Record<string, unknown> | undefined
    const runtime = fakeRuntime(async (params) => {
      dispatched = params
      const delivery = params.delivery as {
        deliver: (payload: Record<string, unknown>) => Promise<void>
      }
      await delivery.deliver({ text: "Working details", isReasoning: true })
      await delivery.deliver({ text: "The durable final answer." })
    })
    const dispatcher = new OpenClawAgentDispatcher(
      {} as OpenClawConfig,
      runtime
    )
    const progress: number[] = []

    const reply = await dispatcher.dispatch(
      {
        accountId: "default",
        spaceId: "connected-agents",
        threadId: "thr_one",
        messageId: "msg_one",
        body: "Please investigate",
        sender: { id: "ptc_finn", kind: "agent", name: "Finn" },
      },
      {
        onWorking: async () => undefined,
        onReceiving: async (characters) => {
          progress.push(characters)
        },
      }
    )

    expect(reply).toBe("The durable final answer.")
    expect(progress).toEqual([25])
    expect(dispatched?.routeSessionKey).toBe(
      "agent:main:worktable:direct:connected-agents/thr_one"
    )
    expect(dispatched?.messageId).toBe("connected-agents/thr_one/msg_one")
    expect(
      (dispatched?.ctxPayload as Record<string, unknown>).OriginatingTo
    ).toBe("thread:connected-agents/thr_one")
    expect(dispatched?.replyOptions).toEqual({
      sourceReplyDeliveryMode: "automatic",
    })
    expect(
      (dispatched?.ctxPayload as Record<string, unknown>).ExplicitDeliverRoute
    ).toBeUndefined()
    expect(
      (dispatched?.ctxPayload as Record<string, unknown>).GroupSystemPrompt
    ).toBe(WORKTABLE_COLLABORATION_PROMPT)
  })
})

describe("worktableSessionRoute", () => {
  test("keeps threads isolated while preserving one session per thread", () => {
    const cfg = {} as OpenClawConfig
    const first = worktableSessionRoute(
      cfg,
      "default",
      "connected-agents",
      "thr_one"
    )
    const repeated = worktableSessionRoute(
      cfg,
      "default",
      "connected-agents",
      "thr_one"
    )
    const second = worktableSessionRoute(
      cfg,
      "default",
      "connected-agents",
      "thr_two"
    )
    const copied = worktableSessionRoute(
      cfg,
      "default",
      "copied-space",
      "thr_one"
    )

    expect(repeated).toEqual(first)
    expect(second.sessionKey).not.toBe(first.sessionKey)
    expect(copied.sessionKey).not.toBe(first.sessionKey)
  })
})
