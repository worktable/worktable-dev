import { Hono } from "hono"
import { requireWorkspaceOwner } from "../auth.ts"
import { perfDiagnosticsSnapshot } from "../perf-diagnostics.ts"

export const diagnosticsRouter = new Hono()

diagnosticsRouter.use("*", requireWorkspaceOwner())

// GET /api/diagnostics/perf — event-loop lag, per-route latency, operation
// timings and memory for this server process. Durations are milliseconds.
diagnosticsRouter.get("/perf", async (c) => {
  c.header("Cache-Control", "no-store")
  return c.json(await perfDiagnosticsSnapshot())
})
