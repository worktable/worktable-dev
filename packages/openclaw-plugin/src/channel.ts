import {
  createChannelPluginBase,
  createChatChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core"
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot"
import { hostname } from "node:os"
import {
  accessSettingsToKeep,
  memberId,
  type WorktableAccess,
} from "./access.js"
import {
  parseWorktableAgentAuth,
  WorktableAgentCredentialProvider,
} from "./agent-auth.js"
import {
  loadAgentCredential,
  promotePendingAgentAuth,
  saveAgentCredential,
} from "./agent-auth-config.js"
import type {
  WorktableAgentAuth,
  WorktableChannelAccount,
  WorktableClient,
  WorktableThreadSummary,
} from "./types.js"

const CHANNEL_ID = "worktable"

function channelSection(cfg: OpenClawConfig): Record<string, unknown> {
  return (
    ((cfg.channels as Record<string, unknown> | undefined)?.[CHANNEL_ID] as
      | Record<string, unknown>
      | undefined) ?? {}
  )
}

export function resolveWorktableAccount(
  cfg: OpenClawConfig,
  accountId?: string | null
): WorktableChannelAccount {
  const section = channelSection(cfg)
  return {
    accountId: accountId ?? "default",
    enabled: section.enabled !== false,
    server: typeof section.server === "string" ? section.server : "",
    token: typeof section.token === "string" ? section.token : "",
    authMode:
      section.authMode === "agent-registration"
        ? "agent-registration"
        : "local-token",
    agentAuth: parseWorktableAgentAuth(section.agentAuth),
    pendingAgentAuth: parseWorktableAgentAuth(section.pendingAgentAuth),
    participantName:
      typeof section.participantName === "string"
        ? section.participantName
        : undefined,
    defaultSpaceId:
      typeof section.defaultSpaceId === "string"
        ? section.defaultSpaceId
        : undefined,
    pendingPairingCode:
      typeof section.pendingPairingCode === "string"
        ? section.pendingPairingCode
        : undefined,
    ownerMemberId: memberId(section.ownerMemberId),
    // On unless the owner turned it off.
    trustOwnAgents: section.trustOwnAgents !== false,
    trustAllMembers: section.trustAllMembers === true,
    trustAllAgents: section.trustAllAgents === true,
  }
}

/** Who this connection takes direction from, as its settings stand. */
export function worktableAccess(
  account: WorktableChannelAccount
): WorktableAccess {
  return {
    ownerMemberId: account.ownerMemberId,
    trustOwnAgents: account.trustOwnAgents,
    trustAllMembers: account.trustAllMembers,
    trustAllAgents: account.trustAllAgents,
  }
}

/**
 * The rule as saved now, read from storage for each message. The owner's
 * trust settings do not restart the channel, so a change, above all turning
 * one off, must hold for the very next message.
 */
export function savedWorktableAccess(accountId?: string): WorktableAccess {
  return worktableAccess(
    resolveWorktableAccount(
      getRuntimeConfig({ pin: false, skipPluginValidation: true }),
      accountId
    )
  )
}

/**
 * Whether a Worktable too old to say who connected its agents has one
 * person: it answers that it is not a Team Worktable. Then every person it
 * lists is its owner and every agent is the owner's. Anything else, an
 * unreachable Worktable included, is not known to be one person's.
 */
export async function isOnePersonWorktable(
  server: string,
  token: string
): Promise<boolean> {
  if (!server || !token) return false
  try {
    const response = await fetch(`${server.replace(/\/+$/, "")}/api/team`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return false
    const team = (await response.json()) as { enabled?: unknown } | null
    return team?.enabled === false
  } catch {
    return false
  }
}

export function agentCredentialForConnection(
  account: WorktableChannelAccount
): WorktableAgentAuth | undefined {
  return account.authMode === "agent-registration"
    ? (account.pendingAgentAuth ?? account.agentAuth)
    : undefined
}

function accountIsConfigured(account: WorktableChannelAccount): boolean {
  if (!account.server) return false
  return account.authMode === "agent-registration"
    ? Boolean(account.pendingAgentAuth ?? account.agentAuth)
    : Boolean(account.token)
}

export function pendingAgentRegistrationToPromote(
  account: WorktableChannelAccount,
  connectedRegistrationId?: string
): string | undefined {
  return account.pendingAgentAuth?.registrationId === connectedRegistrationId
    ? connectedRegistrationId
    : undefined
}

async function worktableClient(
  account: WorktableChannelAccount,
  credential = agentCredentialForConnection(account)
) {
  const { McpWorktableClient } = await import("./worktable-client.js")
  if (!credential) {
    return new McpWorktableClient(account.server, account.token)
  }
  const provider = new WorktableAgentCredentialProvider({
    credential,
    load: () => loadAgentCredential(credential.registrationId),
    save: (next) => saveAgentCredential(credential.registrationId, next),
  })
  return new McpWorktableClient(account.server, {
    provider,
    adapter: "openclaw",
    installationId: credential.registrationId,
    label: account.participantName
      ? `OpenClaw · ${account.participantName}`
      : "OpenClaw",
    machine: hostname(),
  })
}

async function withClient<T>(
  account: WorktableChannelAccount,
  run: (client: WorktableClient) => Promise<T>
): Promise<T> {
  const client = await worktableClient(account)
  try {
    return await run(client)
  } finally {
    await client.close()
  }
}

function normalizeTarget(raw: string): string | undefined {
  const target = raw.trim()
  if (/^thread:[A-Za-z0-9][A-Za-z0-9_-]*\/thr_[A-Za-z0-9_-]+$/.test(target)) {
    return target
  }
  if (/^(participant:ptc_|thread:thr_)[A-Za-z0-9_-]+$/.test(target)) {
    return target
  }
  if (/^ptc_[A-Za-z0-9_-]+$/.test(target)) return `participant:${target}`
  if (/^thr_[A-Za-z0-9_-]+$/.test(target)) return `thread:${target}`
  return undefined
}

export function resolveWorktableThreadTarget(
  target: string,
  _legacyDefaultSpaceId?: string
): { spaceId?: string; threadId: string } | null {
  const qualified =
    /^thread:([A-Za-z0-9][A-Za-z0-9_-]*)\/(thr_[A-Za-z0-9_-]+)$/.exec(target)
  if (qualified) {
    return { spaceId: qualified[1]!, threadId: qualified[2]! }
  }
  const unqualified = /^thread:(thr_[A-Za-z0-9_-]+)$/.exec(target)
  return unqualified ? { threadId: unqualified[1]! } : null
}

export function worktableThreadHandle(thread: WorktableThreadSummary): string {
  const spaceId =
    thread.spaceId ??
    (thread.location?.kind === "space" ? thread.location.spaceId : undefined)
  return spaceId ? `thread:${spaceId}/${thread.id}` : `thread:${thread.id}`
}

export async function listDirectoryThreads(
  client: Pick<WorktableClient, "listThreads">,
  legacyDefaultSpaceId?: string
): Promise<WorktableThreadSummary[]> {
  try {
    return await client.listThreads()
  } catch (unscopedError) {
    const invalidParams =
      typeof unscopedError === "object" &&
      unscopedError !== null &&
      "code" in unscopedError &&
      unscopedError.code === -32602
    if (!legacyDefaultSpaceId || !invalidParams) throw unscopedError
    try {
      return await client.listThreads(legacyDefaultSpaceId)
    } catch {
      throw unscopedError
    }
  }
}

/**
 * Completes a new pairing on the first successful connection only. Clearing
 * the saved code does not restart the channel, so later reconnects must not
 * repeat a completion Worktable has already accepted. A failed attempt is
 * retried on the next connection.
 */
export function pairingCompletionOnce(
  pairingCode: string | undefined,
  complete: (pairingCode: string) => Promise<void>
): () => Promise<void> {
  let pending = pairingCode
  return async () => {
    if (!pending) return
    await complete(pending)
    pending = undefined
  }
}

const base = createChannelPluginBase<WorktableChannelAccount>({
  id: CHANNEL_ID,
  meta: {
    label: "Worktable",
    selectionLabel: "Worktable",
    docsPath: "/channels/worktable",
    blurb: "Durable Worktable threads with agent-session continuity.",
    markdownCapable: true,
    showInSetup: true,
  },
  capabilities: {
    chatTypes: ["direct", "thread"],
    reply: true,
    threads: true,
    blockStreaming: false,
  },
  config: {
    listAccountIds: () => ["default"],
    defaultAccountId: () => "default",
    resolveAccount: resolveWorktableAccount,
    inspectAccount(cfg, accountId) {
      const account = resolveWorktableAccount(cfg, accountId)
      return {
        enabled: account.enabled,
        configured: accountIsConfigured(account),
        tokenStatus: accountIsConfigured(account) ? "available" : "missing",
      }
    },
    isEnabled: (account) => account.enabled,
    isConfigured: accountIsConfigured,
  },
  setup: {
    applyAccountConfig({ cfg, input }) {
      const section = { ...channelSection(cfg) }
      const server = input.url ?? input.baseUrl
      // A token given by hand names no approver. The one on record stays only
      // for the same Worktable address.
      const access =
        section.server === server
          ? accessSettingsToKeep(section, {
              server,
              ownerMemberId: section.ownerMemberId,
            })
          : {}
      delete section.agentAuth
      delete section.pendingAgentAuth
      delete section.ownerMemberId
      delete section.trustAllMembers
      delete section.trustAllAgents
      const channels = {
        ...(cfg.channels as Record<string, unknown> | undefined),
        [CHANNEL_ID]: {
          ...section,
          ...access,
          enabled: true,
          server,
          token: input.token,
          authMode: "local-token",
        },
      }
      return { ...cfg, channels } as OpenClawConfig
    },
    validateInput({ cfg, input }) {
      if (!input.url && !input.baseUrl) return "--url is required"
      if (!input.token) return "--token is required"
      return null
    },
  },
})

export const worktableChannel = createChatChannelPlugin({
  base: {
    ...base,
    capabilities: base.capabilities!,
    config: base.config!,
    reload: {
      configPrefixes: [`channels.${CHANNEL_ID}`],
      // The running channel clears its pairing code once Worktable confirms
      // it. Nothing reads the code after that, and replacing the plugin for
      // that write left the channel stopped until the Gateway restarted.
      // The trust settings are read from storage for every message instead.
      noopPrefixes: [
        `channels.${CHANNEL_ID}.pendingPairingCode`,
        `channels.${CHANNEL_ID}.trustOwnAgents`,
        `channels.${CHANNEL_ID}.trustAllMembers`,
        `channels.${CHANNEL_ID}.trustAllAgents`,
      ],
    },
    gateway: {
      async startAccount(ctx) {
        if (!accountIsConfigured(ctx.account)) {
          throw new Error("Worktable channel is not configured")
        }
        const [
          { OpenClawAgentDispatcher },
          { WorktableConnector },
          { createOpenClawReplyOutbox },
        ] = await Promise.all([
          import("./openclaw-dispatcher.js"),
          import("./connector.js"),
          import("./reply-outbox.js"),
        ])
        const connectedCredential = agentCredentialForConnection(ctx.account)
        const completePairing = pairingCompletionOnce(
          ctx.account.pendingPairingCode,
          async (pairingCode) => {
            const { resumePendingPairingCompletion } =
              await import("./pairing.js")
            await resumePendingPairingCompletion({
              origin: ctx.account.server,
              pairingCode,
              token: ctx.account.token,
            })
          }
        )
        const connector = new WorktableConnector({
          client: await worktableClient(ctx.account, connectedCredential),
          dispatcher: new OpenClawAgentDispatcher(ctx.cfg),
          access: () => savedWorktableAccess(ctx.accountId),
          isOnePersonWorktable: () =>
            isOnePersonWorktable(ctx.account.server, ctx.account.token),
          name: ctx.account.participantName,
          replyOutbox: createOpenClawReplyOutbox(),
          accountId: ctx.accountId,
          worktableOrigin: ctx.account.server,
          logger: ctx.log,
          async onConnected() {
            await completePairing()
            const registrationId = pendingAgentRegistrationToPromote(
              ctx.account,
              connectedCredential?.registrationId
            )
            if (registrationId) {
              await promotePendingAgentAuth(registrationId)
            }
          },
          onConnectionState(state) {
            const now = Date.now()
            ctx.setStatus({
              ...ctx.getStatus(),
              configured: true,
              enabled: true,
              running: true,
              linked: state.connected,
              connected: state.connected,
              statusState: state.connected ? "connected" : "disconnected",
              lastConnectedAt: state.connected
                ? now
                : ctx.getStatus().lastConnectedAt,
              lastDisconnect: state.connected
                ? ctx.getStatus().lastDisconnect
                : { at: now, error: state.errorCode },
              lastError: state.connected ? null : state.errorCode,
            })
          },
        })
        ctx.setStatus({
          ...ctx.getStatus(),
          configured: true,
          enabled: true,
          running: true,
          linked: false,
          connected: false,
          statusState: "connecting",
        })
        try {
          await connector.run(ctx.abortSignal)
        } finally {
          ctx.setStatus({
            ...ctx.getStatus(),
            running: false,
            linked: false,
            connected: false,
            statusState: "disconnected",
          })
        }
      },
    },
    directory: {
      async listPeers({ cfg, accountId }) {
        const account = resolveWorktableAccount(cfg, accountId)
        return withClient(account, async (client) =>
          (await client.participants()).map((participant) => ({
            kind: "user" as const,
            id: `participant:${participant.id}`,
            name: participant.name,
            handle: `participant:${participant.id}`,
          }))
        )
      },
      async listGroups({ cfg, accountId }) {
        const account = resolveWorktableAccount(cfg, accountId)
        return withClient(account, async (client) =>
          (await listDirectoryThreads(client, account.defaultSpaceId)).map(
            (thread) => {
              const handle = worktableThreadHandle(thread)
              return {
                kind: "group" as const,
                id: handle,
                name: thread.title,
                handle,
              }
            }
          )
        )
      },
    },
    messaging: {
      targetPrefixes: ["participant:", "thread:"],
      normalizeTarget,
      inferTargetChatType: ({ to }) =>
        to.startsWith("thread:") ? "group" : "direct",
      resolveSessionConversation({ rawId }) {
        const target = normalizeTarget(rawId)
        if (!target?.startsWith("thread:")) return null
        return { id: target }
      },
      resolveSessionTarget({ id }) {
        return normalizeTarget(id)
      },
    },
  },
  threading: { topLevelReplyToMode: "reply" },
  outbound: {
    attachedResults: {
      channel: CHANNEL_ID,
      async sendText(ctx) {
        const account = resolveWorktableAccount(ctx.cfg, ctx.accountId)
        const target = normalizeTarget(ctx.to)
        if (!target) throw new Error(`Invalid Worktable target: ${ctx.to}`)
        const threadTarget = target.startsWith("thread:")
          ? resolveWorktableThreadTarget(target)
          : null
        const result = await withClient(account, (client) =>
          client.post({
            ...(threadTarget
              ? threadTarget
              : {
                  to: target.slice("participant:".length),
                  ...(account.defaultSpaceId
                    ? { spaceId: account.defaultSpaceId }
                    : {}),
                }),
            body: ctx.text,
            idempotencyKey:
              ctx.deliveryQueueId ?? `openclaw-out:${crypto.randomUUID()}`,
          })
        )
        return {
          messageId: result.messageId,
          conversationId: result.threadId,
        }
      },
    },
    base: {
      deliveryMode: "direct",
      resolveTarget({ to }) {
        const target = to ? normalizeTarget(to) : undefined
        return target
          ? { ok: true, to: target }
          : { ok: false, error: new Error("A Worktable target is required") }
      },
    },
  },
})
