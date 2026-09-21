import { Hono } from "hono"
import {
  isAuthorizedLocalOperatorRequest,
  writeLiveOperatorWorkspaceExport,
} from "../operator-export.ts"

export const operatorRouter = new Hono()

operatorRouter.post("/workspace-export", async (c) => {
  if (!isAuthorizedLocalOperatorRequest(c.req.raw)) {
    return c.json({ error: "Forbidden", code: "OPERATOR_REQUIRED" }, 403)
  }
  const body = (await c.req.json().catch(() => null)) as {
    destination?: unknown
  } | null
  if (!body || typeof body.destination !== "string") {
    return c.json({ error: "operator export destination is required" }, 400)
  }
  try {
    return c.json(await writeLiveOperatorWorkspaceExport(body.destination))
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : String(error),
        code: "OPERATOR_EXPORT_FAILED",
      },
      422
    )
  }
})
