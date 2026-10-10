import { hostedOAuthPrincipalId } from "@worktable/hosted-contract"
import {
  DEFAULT_AGENT_ACCESS,
  isAgentPlatformId,
  isDirectAgentLabel,
  type AgentAccess,
  type AgentPlatformId,
} from "@worktable/types"
import { Hono } from "hono"
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
import { getOwnerSubject } from "../oauth-jwt.ts"

export const agentConnectionsRouter = new Hono()

agentConnectionsRouter.use("*", requireAgentManager())

agentConnectionsRouter.get("/", async (c) =>
  c.json({ connections: await listAgentConnections() })
)

agentConnectionsRouter.delete("/:id", async (c) => {
  await disconnectAgentConnection(c.req.param("id"))
  return c.json({ ok: true })
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
  if (!isDirectAgentLabel(body.client)) {
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
  try {
    const connection = await updateAgentConnection(c.req.param("id"), {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(body.icon !== undefined ? { icon: body.icon as string | null } : {}),
      ...(access ? { access } : {}),
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
  await updateSignInAgent(hostedOAuthPrincipalId(clientId, owner), {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(body.icon !== undefined ? { icon: body.icon as string | null } : {}),
    ...(body.platform !== undefined
      ? { platform: body.platform as AgentPlatformId }
      : {}),
    ...(typeof body.threads === "boolean" ? { threads: body.threads } : {}),
  })
  return c.json({ ok: true as const })
})
