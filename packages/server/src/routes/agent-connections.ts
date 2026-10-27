import { randomUUID } from "node:crypto"
import { hostedOAuthPrincipalId } from "@worktable/hosted-contract"
import {
  agentConnectionPlatform,
  DEFAULT_AGENT_ACCESS,
  isAgentPlatformId,
  isDirectAgentLabel,
  type AgentAccess,
  type AgentConnection,
  type AgentPlatformId,
} from "@worktable/types"
import { Hono, type Context } from "hono"
import { requireAgentManager } from "../auth.ts"
import {
  createAgentCredential,
  findAppAgent,
  disconnectAgentConnection,
  AgentConnectionUpdateError,
  listAgentConnections,
  updateAgentConnection,
  updateSignInAgent,
} from "../agent-connection-store.ts"
import { isHosted } from "../hosted.ts"
import { disconnectedSignIns } from "../team-agent-connections.ts"
import { getOwnerSubject } from "../oauth-jwt.ts"
import { withAutoReply } from "../auto-reply.ts"
import { grokBotInventory } from "../grok-bot-connections.ts"
import {
  readGrokBotCandidates,
  readGrokBots,
  removeGrokBot,
} from "../grok-bot-store.ts"
import { CLAUDE_CODE_TASK, validateWebhookDestination } from "../agent-wake.ts"
import {
  cloudTaskFor,
  removeCloudTask,
  saveCloudTask,
  signalCloudTaskChange,
  updateCloudTask,
} from "../cloud-task-store.ts"
import { configuredMcpSurface } from "../mcp/surface.ts"
import { postThreadMessageWithStored } from "../thread-service.ts"

export const agentConnectionsRouter = new Hono()

agentConnectionsRouter.use("*", requireAgentManager())

agentConnectionsRouter.get("/", async (c) => {
  const connections = await listAgentConnections()
  return c.json({
    connections: await withAutoReply(connections),
    ...(await grokBotInventory(connections)),
  })
})

agentConnectionsRouter.delete("/:id", async (c) => {
  const connection = (await listAgentConnections()).find(
    (entry) => entry.id === c.req.param("id")
  )
  const disconnected = await disconnectAgentConnection(c.req.param("id"))
  if (disconnected && connection?.participant) {
    const ids = new Set([
      ...(await readGrokBots())
        .filter((grok) => grok.participantId === connection.participant!.id)
        .map((grok) => grok.connectionId),
      ...(await readGrokBotCandidates())
        .filter(
          (candidate) => candidate.participantId === connection.participant!.id
        )
        .map((candidate) => candidate.id),
    ])
    for (const id of ids) await removeGrokBot(id, { forgetIdentity: true })
    await removeCloudTask(connection.participant.id)
    signalCloudTaskChange()
  }
  // On Cloud the gateway revokes these sign-ins, so only a new approval
  // brings the agent back.
  const signIns =
    disconnected && isHosted() ? disconnectedSignIns(c.req.param("id")) : []
  return c.json({ ok: true, ...(signIns.length ? { signIns } : {}) })
})

const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function parseAccess(value: unknown): AgentAccess | undefined | false {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const access = value as Record<string, unknown>
  return typeof access["threads"] === "boolean" &&
    typeof access["read"] === "boolean" &&
    typeof access["edit"] === "boolean"
    ? {
        threads: access["threads"],
        read: access["read"],
        edit: access["edit"],
      }
    : false
}

function badRequest(error: string) {
  return { error, code: "BAD_REQUEST" }
}

// The agent an app already is, so connecting it again starts from its name
// and access rather than resetting them.
agentConnectionsRouter.get("/apps/:label", async (c) => {
  const label = c.req.param("label")
  const connection = isDirectAgentLabel(label)
    ? await findAppAgent(label)
    : null
  return c.json({ connection })
})

// The owner connects an app with a credential made here, named and with the
// access chosen. Cloud connects these apps by signing in instead.
agentConnectionsRouter.post("/", async (c) => {
  if (isHosted()) {
    return c.json(
      {
        error: "On Worktable Cloud, apps connect by signing in.",
        code: "HOSTED_DISABLED",
      },
      403
    )
  }
  const body = (await c.req.json().catch(() => null)) as {
    client?: unknown
    displayName?: unknown
    icon?: unknown
    access?: unknown
  } | null
  if (!body) return c.json(badRequest("Expected a JSON object"), 400)
  if (body.client !== null && !isDirectAgentLabel(body.client)) {
    return c.json(badRequest("client must be an app Worktable connects"), 400)
  }
  const displayName =
    body.displayName === undefined
      ? undefined
      : typeof body.displayName === "string"
        ? body.displayName.trim()
        : ""
  if (displayName !== undefined && (!displayName || displayName.length > 100)) {
    return c.json(badRequest("displayName must be 1 to 100 characters"), 400)
  }
  if (
    body.icon !== undefined &&
    body.icon !== null &&
    (typeof body.icon !== "string" ||
      body.icon.length > 64 ||
      !ICON_NAME.test(body.icon))
  ) {
    return c.json(badRequest("icon must be an icon name or null"), 400)
  }
  const access = parseAccess(body.access)
  if (access === false) {
    return c.json(
      badRequest("access must have boolean threads, read, and edit"),
      400
    )
  }
  try {
    const created = await createAgentCredential({
      label: body.client,
      access: access ?? DEFAULT_AGENT_ACCESS,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(body.icon !== undefined ? { icon: body.icon as string | null } : {}),
    })
    return c.json(created, 201)
  } catch (error) {
    if (error instanceof AgentConnectionUpdateError) {
      return c.json(badRequest(error.message), 400)
    }
    throw error
  }
})

// The owner renames an agent, changes its icon, or changes its access.
agentConnectionsRouter.patch("/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    displayName?: unknown
    icon?: unknown
    access?: unknown
    spaceIds?: unknown
  } | null
  if (!body) return c.json(badRequest("Expected a JSON object"), 400)
  let displayName: string | undefined
  if (body.displayName !== undefined) {
    displayName =
      typeof body.displayName === "string" ? body.displayName.trim() : ""
    if (!displayName || displayName.length > 100) {
      return c.json(badRequest("displayName must be 1 to 100 characters"), 400)
    }
  }
  if (
    body.icon !== undefined &&
    body.icon !== null &&
    (typeof body.icon !== "string" ||
      body.icon.length > 64 ||
      !ICON_NAME.test(body.icon))
  ) {
    return c.json(badRequest("icon must be an icon name or null"), 400)
  }
  const access = parseAccess(body.access)
  if (access === false) {
    return c.json(
      badRequest("access must have boolean threads, read, and edit"),
      400
    )
  }
  if (
    body.spaceIds !== undefined &&
    body.spaceIds !== null &&
    (!Array.isArray(body.spaceIds) ||
      body.spaceIds.length > 1000 ||
      body.spaceIds.some((id) => typeof id !== "string" || !id))
  ) {
    return c.json(badRequest("spaceIds must be Space identifiers or null"), 400)
  }
  try {
    const connection = await updateAgentConnection(c.req.param("id"), {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(body.icon !== undefined ? { icon: body.icon as string | null } : {}),
      ...(access ? { access } : {}),
      ...(body.spaceIds !== undefined
        ? { spaceIds: body.spaceIds as string[] | null }
        : {}),
    })
    if (!connection) {
      return c.json(
        { error: "Agent connection not found", code: "NOT_FOUND" },
        404
      )
    }
    return c.json({ ok: true as const, connection })
  } catch (error) {
    if (error instanceof AgentConnectionUpdateError) {
      return c.json(badRequest(error.message), 400)
    }
    throw error
  }
})

const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/

// On Cloud, the owner's name, icon, and platform for a sign-in agent such as
// Claude or ChatGPT. Cloud keeps its access and grant; this workspace keeps
// how it appears in threads.
agentConnectionsRouter.put("/sign-ins/:clientId", async (c) => {
  const owner = getOwnerSubject()
  const clientId = c.req.param("clientId")
  if (!isHosted() || !owner || !CLIENT_ID.test(clientId)) {
    return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  }
  const body = (await c.req.json().catch(() => null)) as {
    displayName?: unknown
    icon?: unknown
    platform?: unknown
    threads?: unknown
  } | null
  if (!body) return c.json(badRequest("Expected a JSON object"), 400)
  if (body.threads !== undefined && typeof body.threads !== "boolean") {
    return c.json(badRequest("threads must be true or false"), 400)
  }
  const displayName =
    body.displayName === undefined
      ? undefined
      : typeof body.displayName === "string"
        ? body.displayName.trim()
        : ""
  if (displayName !== undefined && (!displayName || displayName.length > 100)) {
    return c.json(badRequest("displayName must be 1 to 100 characters"), 400)
  }
  if (
    body.icon !== undefined &&
    body.icon !== null &&
    (typeof body.icon !== "string" ||
      body.icon.length > 64 ||
      !ICON_NAME.test(body.icon))
  ) {
    return c.json(badRequest("icon must be an icon name or null"), 400)
  }
  if (body.platform !== undefined && !isAgentPlatformId(body.platform)) {
    return c.json(badRequest("platform must be a known agent platform"), 400)
  }
  try {
    await updateSignInAgent(hostedOAuthPrincipalId(clientId, owner), {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(body.icon !== undefined ? { icon: body.icon as string | null } : {}),
      ...(body.platform !== undefined
        ? { platform: body.platform as AgentPlatformId }
        : {}),
      ...(typeof body.threads === "boolean" ? { threads: body.threads } : {}),
    })
  } catch (error) {
    if (error instanceof AgentConnectionUpdateError)
      return c.json(badRequest(error.message), 400)
    throw error
  }
  return c.json({ ok: true as const })
})

// Claude's cloud task, with the MCP preview: Worktable fires the owner's
// Claude Code scheduled task when something is sent to Claude
// (cloud-task-runtime.ts). Its URL and token never come back from here.

const CLAUDE_TOKEN = /^sk-ant-\S+$/

/** The Claude agent a task route names, or the answer refusing it. */
async function claudeAgent(
  c: Context,
  id: string,
  { removing = false } = {}
): Promise<{ connection: AgentConnection; participantId: string } | Response> {
  const connection =
    configuredMcpSurface() === "preview"
      ? (await listAgentConnections()).find((entry) => entry.id === id)
      : undefined
  // Removing goes by the agent, so a renamed one can still let go of its task.
  if (
    !connection ||
    (!removing && agentConnectionPlatform(connection) !== "claude") ||
    connection.canManage === false
  )
    return c.json(
      { error: "Agent connection not found", code: "NOT_FOUND" },
      404
    )
  if (!connection.participant)
    return c.json(badRequest("Use Worktable from Claude once first."), 400)
  // The test is a thread, and so is most of what Claude answers.
  if (!removing && connection.access?.threads === false)
    return c.json(badRequest("Turn on Threads access for Claude first."), 400)
  return { connection, participantId: connection.participant.id }
}

/** Something for Claude to answer: one thread for every test of a URL and token. */
async function postTestThread(
  c: Context,
  connection: AgentConnection,
  participantId: string,
  generation: string
): Promise<void> {
  const spaceId = connection.spaceIds?.[0]
  await postThreadMessageWithStored(c.get("identity"), {
    location: spaceId ? { kind: "space", spaceId } : { kind: "worktable" },
    title: "Auto-reply test",
    to: participantId,
    body: "Worktable is testing Auto-reply. Reply on this thread with: Auto-reply works.",
    idempotencyKey: `cloud-task-test:${generation}`,
    expectsReply: true,
  })
}

// Save the URL and token Claude shows, then test them. Either may be left out
// to keep the saved one.
agentConnectionsRouter.put("/:id/cloud-task", async (c) => {
  const agent = await claudeAgent(c, c.req.param("id"))
  if (agent instanceof Response) return agent
  const body = (await c.req.json().catch(() => null)) as {
    url?: unknown
    token?: unknown
  } | null
  if (!body || typeof body !== "object")
    return c.json(badRequest("Expected a JSON object"), 400)
  const text = (value: unknown) =>
    typeof value === "string" ? value.trim() : ""
  const saved = await cloudTaskFor(agent.participantId)
  let url: string
  try {
    url = validateWebhookDestination(
      CLAUDE_CODE_TASK,
      text(body.url) || saved?.url || ""
    )
  } catch (error) {
    return c.json(badRequest((error as Error).message), 400)
  }
  const token = text(body.token) || saved?.token || ""
  if (token.length > 4096 || !CLAUDE_TOKEN.test(token))
    return c.json(
      badRequest("Paste the token Claude shows. It starts with sk-ant-"),
      400
    )
  const generation = randomUUID()
  await postTestThread(c, agent.connection, agent.participantId, generation)
  await saveCloudTask({
    participantId: agent.participantId,
    url,
    token,
    generation,
  })
  signalCloudTaskChange()
  return c.json({ ok: true as const })
})

agentConnectionsRouter.post("/:id/cloud-task/test", async (c) => {
  const agent = await claudeAgent(c, c.req.param("id"))
  if (agent instanceof Response) return agent
  const task = await cloudTaskFor(agent.participantId)
  if (!task) return c.json(badRequest("Set up the task first."), 400)
  await postTestThread(
    c,
    agent.connection,
    agent.participantId,
    task.generation
  )
  await updateCloudTask(agent.participantId, task.generation, (t) => {
    const now = Date.now()
    Object.assign(t, {
      testingSince: now,
      nextAt: now,
      verifiedAt: undefined,
      error: undefined,
      firedAt: undefined,
      attempts: undefined,
    })
  })
  signalCloudTaskChange()
  return c.json({ ok: true as const })
})

agentConnectionsRouter.delete("/:id/cloud-task", async (c) => {
  const agent = await claudeAgent(c, c.req.param("id"), { removing: true })
  if (agent instanceof Response) return agent
  await removeCloudTask(agent.participantId)
  signalCloudTaskChange()
  return c.json({ ok: true as const })
})
