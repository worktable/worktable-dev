import type { AgentAccess } from "@worktable/types"
import { Hono } from "hono"
import { requireAgentManager } from "../auth.ts"
import {
  disconnectAgentConnection,
  AgentConnectionUpdateError,
  listAgentConnections,
  updateAgentConnection,
} from "../agent-connection-store.ts"

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
