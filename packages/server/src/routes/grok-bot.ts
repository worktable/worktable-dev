import { Hono } from "hono"
import { requireAgentManager } from "../auth.ts"
import { z } from "zod"
import { GROK_BOT_SHORTCUT_MESSAGE, isGrokBotShortcut } from "@worktable/types"
import { listAgentConnections } from "../agent-connection-store.ts"
import { visibleGrokBotCandidates } from "../grok-bot-connections.ts"
import {
  GrokBotConfigurationError,
  readGrokBots,
  removeGrokBot,
  saveGrokBot,
  signalGrokBotChange,
  updateGrokBot,
  validateGrokWebhook,
} from "../grok-bot-store.ts"
import {
  grokBotDeliveries,
  retryGrokBotDelivery,
} from "../thread-delivery-store.ts"
import {
  postThreadMessageWithStored,
  readThreadMessage,
} from "../thread-service.ts"
import { notifyWorkspaceChange } from "../workspace-events.ts"
import { assertSpaceAccess, canAccessWorktableThreads } from "../team-policy.ts"

export const grokBotRouter = new Hono()
grokBotRouter.use("*", requireAgentManager())
const saveSchema = z
  .object({
    webhookUrl: z.string().max(2048).optional(),
    webhookKey: z.string().min(1).max(4096).regex(/^\S+$/).optional(),
    enabled: z.boolean().default(true),
    executionMinutes: z.number().int().min(1).max(120).default(30),
  })
  .strict()

grokBotRouter.use("/:id/*", async (c, next) => {
  const candidates = await visibleGrokBotCandidates(
    await listAgentConnections()
  )
  if (!candidates.some((candidate) => candidate.id === c.req.param("id"))) {
    return c.json(
      { error: "Authenticated connection not found", code: "NOT_FOUND" },
      404
    )
  }
  return next()
})
grokBotRouter.put("/:id/configuration", async (c) => {
  const parsed = saveSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success)
    return c.json(
      {
        error:
          "Enter a routine URL, key, and a deadline between 1 and 120 minutes",
        code: "BAD_REQUEST",
      },
      400
    )
  const candidates = await visibleGrokBotCandidates(
    await listAgentConnections()
  )
  if (isGrokBotShortcut(parsed.data.webhookKey ?? ""))
    return c.json(
      { error: GROK_BOT_SHORTCUT_MESSAGE, code: "BAD_REQUEST" },
      400
    )
  const candidate = candidates.find(
    (candidate) => candidate.id === c.req.param("id")
  )!
  const previous = (await readGrokBots()).find(
    (entry) => entry.connectionId === candidate.id
  )
  let webhookUrl: string
  try {
    webhookUrl = validateGrokWebhook(
      parsed.data.webhookUrl ?? previous?.webhookUrl ?? ""
    )
  } catch (error) {
    return c.json({ error: (error as Error).message, code: "BAD_REQUEST" }, 400)
  }
  const webhookKey = parsed.data.webhookKey ?? previous?.webhookKey
  if (!webhookKey)
    return c.json(
      { error: "Enter the routine's webhook key", code: "BAD_REQUEST" },
      400
    )
  const changed =
    previous?.webhookUrl !== webhookUrl || previous?.webhookKey !== webhookKey
  try {
    await saveGrokBot({
      connectionId: candidate.id,
      principalId: candidate.principalId,
      participantId: candidate.participantId,
      participantKey: candidate.participantKey,
      webhookUrl,
      webhookKey,
      executionMinutes: parsed.data.executionMinutes,
      enabled: parsed.data.enabled,
      ...(!changed && previous?.verifiedAt
        ? { verifiedAt: previous.verifiedAt }
        : {}),
      ...(!changed && previous?.probe ? { probe: previous.probe } : {}),
    })
  } catch (error) {
    if (error instanceof GrokBotConfigurationError)
      return c.json({ error: error.message, code: "CONFLICT" }, 409)
    throw error
  }
  notifyWorkspaceChange({ type: "participants" })
  return c.json({ ok: true })
})
grokBotRouter.delete("/:id/configuration", async (c) => {
  await removeGrokBot(c.req.param("id"))
  notifyWorkspaceChange({ type: "participants" })
  return c.json({ ok: true })
})
grokBotRouter.post("/:id/check", async (c) => {
  const connection = (await readGrokBots()).find(
    (entry) => entry.connectionId === c.req.param("id")
  )
  if (!connection?.enabled)
    return c.json(
      { error: "Save and enable the routine first", code: "BAD_REQUEST" },
      400
    )
  if (connection.probe) return c.json({ ok: true, probe: connection.probe })
  const agent = (await listAgentConnections()).find(
    (a) => a.participant?.id === connection.participantId
  )
  const spaceId = agent?.spaceIds?.[0]
  const { result, message } = await postThreadMessageWithStored(
    c.get("identity"),
    {
      location: spaceId ? { kind: "space", spaceId } : { kind: "worktable" },
      title: `Grok Bot connection check ${connection.generation.slice(0, 8)}`,
      to: connection.participantId,
      body: "Worktable connection check. Accept this delivery, then reply on this thread with: Grok Bot is connected. Do not use other connected apps or change any files. Include this message's responseTo and the current deliveryLeaseId.",
      idempotencyKey: `grok-check:${connection.generation}`,
      expectsReply: true,
    }
  )
  const probe = {
    location: result.location,
    threadId: result.threadId,
    messageId: result.messageId,
    identityId: message.responseRequest!.identityId,
  }
  if (
    !(await updateGrokBot(connection, {
      probe,
      error: undefined,
      wake: undefined,
    }))
  ) {
    return c.json(
      {
        error: "The connection changed; start the check again",
        code: "CONFLICT",
      },
      409
    )
  }
  signalGrokBotChange()
  notifyWorkspaceChange({ type: "participants" })
  return c.json({ ok: true, probe })
})
grokBotRouter.post("/:id/retry", async (c) => {
  const connection = (await readGrokBots()).find(
    (entry) => entry.connectionId === c.req.param("id")
  )
  if (!connection?.enabled)
    return c.json(
      { error: "Enable the routine first", code: "BAD_REQUEST" },
      400
    )
  const deliveries = await grokBotDeliveries(connection.participantId)
  const uncertain =
    deliveries.find((d) => d.error?.code === "REMOTE_EXECUTION_UNCONFIRMED") ??
    deliveries.find(
      (d) => d.state === "failed" && d.error?.code !== "DELIVERY_RETIRED"
    )
  if (uncertain) {
    if (uncertain.location.kind === "space")
      assertSpaceAccess(uncertain.location.spaceId, "edit")
    else if (!canAccessWorktableThreads("edit"))
      return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403)
    const { message } = await readThreadMessage(c.get("identity"), uncertain)
    if (
      message.responseRequest?.status !== "open" ||
      message.responseRequest.identityId !== uncertain.identityId
    ) {
      return c.json(
        { error: "This assignment is no longer open", code: "CONFLICT" },
        409
      )
    }
    await retryGrokBotDelivery({
      ...uncertain,
      participantId: connection.participantId,
    })
  }
  await updateGrokBot(connection, { error: undefined, wake: undefined })
  signalGrokBotChange()
  notifyWorkspaceChange({ type: "participants" })
  return c.json({ ok: true })
})
