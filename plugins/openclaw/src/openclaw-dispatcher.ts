import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime"
import {
  buildAgentSessionKey,
  resolveAgentRoute,
} from "openclaw/plugin-sdk/routing"
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core"
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store"
import {
  worktableConversationId,
  worktableThreadTarget,
} from "./delivery-identity.js"
import { getWorktableRuntime } from "./runtime.js"
import type {
  AgentDispatcher,
  AgentDispatchCallbacks,
  AgentDispatchInput,
} from "./types.js"

export const WORKTABLE_COLLABORATION_PROMPT =
  "Worktable collaboration rules: Treat inspection, research, review, and discussion as read-only unless the message explicitly asks for edits. Make only requested changes. After changing Worktable content, name every changed Worktable path in the reply and use portable Worktable links."

function visibleText(payload: ReplyPayload): string {
  if (
    payload.isReasoning ||
    payload.isCommentary ||
    payload.isCompactionNotice ||
    payload.isFallbackNotice ||
    payload.isStatusNotice
  ) {
    return ""
  }
  return payload.text?.trim() ?? ""
}

export class OpenClawAgentDispatcher implements AgentDispatcher {
  readonly #cfg: OpenClawConfig
  readonly #runtime: PluginRuntime

  constructor(cfg: OpenClawConfig, runtime = getWorktableRuntime()) {
    this.#cfg = cfg
    this.#runtime = runtime
  }

  async dispatch(
    input: AgentDispatchInput,
    callbacks: AgentDispatchCallbacks,
    signal?: AbortSignal
  ): Promise<string> {
    const core = this.#runtime
    const conversationId =
      input.conversationId ??
      (input.spaceId
        ? worktableConversationId(input.spaceId, input.threadId)
        : input.threadId)
    const threadTarget =
      input.threadTarget ??
      (input.spaceId
        ? worktableThreadTarget(input.spaceId, input.threadId)
        : `thread:${input.threadId}`)
    const { agentId, sessionKey } = worktableSessionRoute(
      this.#cfg,
      input.accountId,
      conversationId
    )
    const eventId = `${conversationId}/${input.messageId}`
    const storePath = core.channel.session.resolveStorePath(
      this.#cfg.session?.store,
      { agentId }
    )
    const parts: string[] = []
    let receivedCharacters = 0
    const context = core.channel.reply.finalizeInboundContext({
      Body: input.body,
      BodyForAgent: input.body,
      RawBody: input.body,
      CommandBody: input.body,
      BodyForCommands: input.body,
      From: `participant:${input.sender.id}`,
      To: threadTarget,
      SessionKey: sessionKey,
      AgentId: agentId,
      AccountId: input.accountId,
      MessageSid: eventId,
      SenderId: input.sender.id,
      SenderName: input.sender.name,
      Provider: "worktable",
      Surface: "worktable",
      ChatType: "direct",
      ConversationLabel: input.threadId,
      ChatId: conversationId,
      GroupSystemPrompt: WORKTABLE_COLLABORATION_PROMPT,
      OriginatingChannel: "worktable",
      OriginatingTo: threadTarget,
      CommandAuthorized: true,
      Timestamp: Date.now(),
      ChannelContext: {
        sender: { id: input.sender.id },
        chat: { id: conversationId },
      },
    })

    await callbacks.onWorking()
    await core.channel.inbound.dispatchReply({
      cfg: this.#cfg,
      channel: "worktable",
      accountId: input.accountId,
      agentId,
      routeSessionKey: sessionKey,
      storePath,
      ctxPayload: context,
      recordInboundSession: core.channel.session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher:
        core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        deliver: async (payload) => {
          const text = visibleText(payload)
          if (!text) return
          parts.push(text)
          receivedCharacters += text.length
          await callbacks.onReceiving(receivedCharacters)
        },
        onError: (error) => {
          throw error
        },
      },
      replyPipeline: {},
      dispatcherOptions: {
        onReplyStart: callbacks.onWorking,
      },
      // The connector owns the durable reply append so it can preserve
      // Worktable's inReplyTo delivery contract. The channel outbound adapter
      // remains available for Klaus-initiated messages.
      replyOptions: {
        sourceReplyDeliveryMode: "automatic",
        abortSignal: signal,
      },
      record: {},
      messageId: eventId,
    })

    return parts.join("\n\n").trim()
  }
}

export function worktableSessionRoute(
  cfg: OpenClawConfig,
  accountId: string,
  conversationIdOrSpaceId: string,
  legacyThreadId?: string
): { agentId: string; sessionKey: string } {
  const conversationId = legacyThreadId
    ? worktableConversationId(conversationIdOrSpaceId, legacyThreadId)
    : conversationIdOrSpaceId
  const route = resolveAgentRoute({
    cfg,
    channel: "worktable",
    accountId,
    peer: { kind: "direct", id: conversationId },
  })
  return {
    agentId: route.agentId,
    sessionKey: buildAgentSessionKey({
      agentId: route.agentId,
      channel: "worktable",
      accountId,
      peer: { kind: "direct", id: conversationId },
      dmScope: "per-channel-peer",
    }),
  }
}
