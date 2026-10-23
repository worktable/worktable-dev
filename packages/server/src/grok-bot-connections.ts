import type { AgentConnection, GrokBotConnection } from "@worktable/types"
import { currentTeamWorktable } from "./team-database.ts"
import { linkedStatus } from "./linked-runtime.ts"
import {
  grokBotDeliveries,
  isRetiredThreadDelivery,
} from "./thread-delivery-store.ts"
import { readGrokBotCandidates, readGrokBots } from "./grok-bot-store.ts"
import { grokBotEmailSender } from "./grok-bot-email.ts"

export async function visibleGrokBotCandidates(connections: AgentConnection[]) {
  const allowed = new Set(
    connections
      .filter((c) => c.canManage !== false)
      .map((c) => c.participant?.id)
  )
  return (await readGrokBotCandidates()).filter(
    (c) => !currentTeamWorktable() || allowed.has(c.participantId)
  )
}

export async function grokBotInventory(connections: AgentConnection[]) {
  const candidates = await visibleGrokBotCandidates(connections)
  const allowed = new Set(candidates.map((c) => c.id))
  const grokBots: GrokBotConnection[] = []
  for (const connection of await readGrokBots()) {
    if (connection.removed || !allowed.has(connection.connectionId)) continue
    const deliveries = await grokBotDeliveries(connection.participantId)
    const uncertain = deliveries.find(
      (d) => d.error?.code === "REMOTE_EXECUTION_UNCONFIRMED"
    )
    const failed =
      uncertain ??
      deliveries.find(
        (d) =>
          d.state === "failed" &&
          (!isRetiredThreadDelivery(d) ||
            d.messageId === connection.probe?.messageId)
      )
    const working = deliveries.some(
      (d) => !["queued", "replied", "failed"].includes(d.state)
    )
    grokBots.push({
      connectionId: connection.connectionId,
      participantId: connection.participantId,
      enabled: connection.enabled,
      executionMinutes: connection.executionMinutes,
      wakeMethod: connection.wakeMethod,
      ...(connection.emailAddress
        ? { emailAddress: connection.emailAddress }
        : {}),
      status: !connection.enabled
        ? "paused"
        : failed || connection.error
          ? "needs-attention"
          : working
            ? "working"
            : connection.verifiedAt
              ? "ready"
              : connection.probe
                ? "checking"
                : "configured",
      ...(connection.verifiedAt ? { verifiedAt: connection.verifiedAt } : {}),
      ...(connection.probe ? { probe: connection.probe } : {}),
      ...(connection.error || failed
        ? { error: connection.error ?? failed?.error?.message }
        : {}),
      ...(failed
        ? {
            failed: {
              location: failed.location,
              threadId: failed.threadId,
              messageId: failed.messageId,
              identityId: failed.identityId,
            },
          }
        : {}),
      ...(uncertain
        ? {
            uncertain: {
              location: uncertain.location,
              threadId: uncertain.threadId,
              messageId: uncertain.messageId,
              identityId: uncertain.identityId,
            },
          }
        : {}),
    })
  }
  const link = linkedStatus()
  return {
    grokBots,
    grokBotCandidates: await Promise.all(
      candidates.map(
        async ({ id, displayName, participantId, principalId }) => ({
          id,
          displayName:
            connections.find((c) => c.participant?.id === participantId)
              ?.displayName ?? displayName,
          participantId,
          emailSender: await grokBotEmailSender(principalId),
        })
      )
    ),
    grokBotMcpUrl: link.state === "online" ? (link.mcpUrl ?? null) : null,
  }
}
