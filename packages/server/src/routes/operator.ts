import { Hono } from "hono"
import { auditWorkspaceBackup } from "../workspace-backup-notifier.ts"
import { writeLiveOperatorWorkspaceSnapshot } from "../operator-snapshot.ts"
import { restoreLiveWorkspaceSnapshot } from "../workspace-snapshot-restore.ts"
import {
  isAuthorizedLocalOperatorRequest,
  writeLiveOperatorWorkspaceExport,
} from "../operator-export.ts"

export const operatorRouter = new Hono()

operatorRouter.post("/workspace-backup-audit", async (c) => {
  if (!isAuthorizedLocalOperatorRequest(c.req.raw))
    return c.json({ error: "Forbidden" }, 403)
  return c.json(await auditWorkspaceBackup())
})

operatorRouter.post("/workspace-snapshot-restore", async (c) => {
  if (!isAuthorizedLocalOperatorRequest(c.req.raw))
    return c.json({ error: "Forbidden", code: "OPERATOR_REQUIRED" }, 403)
  const body = await c.req.json().catch(() => null)
  if (
    !body ||
    ["operationId", "workspaceId", "sourceCheckpoint", "safetyCheckpoint"].some(
      (key) => typeof body[key] !== "string"
    )
  )
    return c.json({ error: "invalid restore request" }, 400)
  try {
    return c.json(await restoreLiveWorkspaceSnapshot(body))
  } catch {
    return c.json(
      {
        error: "Checkpoint restore could not be prepared",
        code: "OPERATOR_RESTORE_FAILED",
      },
      422
    )
  }
})

operatorRouter.post("/workspace-snapshot", async (c) => {
  if (!isAuthorizedLocalOperatorRequest(c.req.raw))
    return c.json({ error: "Forbidden", code: "OPERATOR_REQUIRED" }, 403)
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.operationId !== "string")
    return c.json({ error: "snapshot operation id is required" }, 400)
  try {
    return c.json(
      await writeLiveOperatorWorkspaceSnapshot(
        body.operationId,
        body.maxCaptureMs
      )
    )
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : String(error),
        code: "OPERATOR_SNAPSHOT_FAILED",
      },
      422
    )
  }
})

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
