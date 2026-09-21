import { Hono } from "hono"
import { requireMintAuth, requireScope, trustedLocalIdentity } from "../auth.ts"
import {
  disconnectAgentConnection,
  listAgentConnections,
  renameAgentConnection,
} from "../agent-connection-store.ts"
import { isHosted } from "../hosted.ts"

export const agentConnectionsRouter = new Hono()

agentConnectionsRouter.use("*", async (c, next) => {
  if (isHosted()) {
    return c.json(
      {
        error:
          "Local agent connections are not available on Worktable Cloud; connect agents with OAuth.",
        code: "HOSTED_DISABLED",
      },
      403
    )
  }
  return next()
})
agentConnectionsRouter.use("*", trustedLocalIdentity())
agentConnectionsRouter.use("*", requireMintAuth())
agentConnectionsRouter.use("*", requireScope("tokens:manage"))

agentConnectionsRouter.get("/", async (c) =>
  c.json({ connections: await listAgentConnections() })
)

agentConnectionsRouter.delete("/:id", async (c) => {
  await disconnectAgentConnection(c.req.param("id"))
  return c.json({ ok: true })
})

agentConnectionsRouter.patch("/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    displayName?: unknown
  } | null
  const displayName =
    typeof body?.displayName === "string" ? body.displayName.trim() : ""
  if (!displayName || displayName.length > 100) {
    return c.json(
      { error: "displayName must be 1–100 characters", code: "BAD_REQUEST" },
      400
    )
  }
  if (!(await renameAgentConnection(c.req.param("id"), displayName))) {
    return c.json(
      { error: "Agent connection not found", code: "NOT_FOUND" },
      404
    )
  }
  return c.json({ ok: true as const })
})
