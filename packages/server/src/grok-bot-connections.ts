import type { AgentConnection, GrokBotConnection } from "@worktable/types"
import { currentTeamWorktable } from "./team-database.ts"
import { linkedStatus } from "./linked-runtime.ts"
import { grokBotDeliveries } from "./thread-delivery-store.ts"
import { readGrokBotCandidates, readGrokBots } from "./grok-bot-store.ts"

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
        (d) => d.state === "failed" && d.error?.code !== "DELIVERY_RETIRED"
      )
    const working = deliveries.some(
      (d) => !["queued", "replied", "failed"].includes(d.state)
    )
    grokBots.push({
      connectionId: connection.connectionId,
      participantId: connection.participantId,
      enabled: connection.enabled,
      executionMinutes: connection.executionMinutes,
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
  return {
    grokBots,
    grokBotCandidates: candidates.map(({ id, displayName, participantId }) => ({
      id,
      displayName,
      participantId,
    })),
    grokBotMcpUrl: linkedStatus().mcpUrl ?? null,
  }
}
