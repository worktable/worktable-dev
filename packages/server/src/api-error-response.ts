// ============================================================
// Errors the routes leave to the server
// ============================================================
//
// Routes answer the errors they expect themselves. These kinds can come from
// any route, so the server answers them once, each with its status and
// code; anything else gets a generic message and an id that is also logged.

import { APIError } from "better-auth/api"
import type { Context } from "hono"
import { SpaceTooLargeError } from "./document-adapters.ts"
import { DocumentAnnotationError } from "./document-annotation-service.ts"
import { unexpectedErrorResponse } from "./request-timing.ts"
import { StorageLimitError, storageLimitBody } from "./storage-limit.ts"
import { TeamStateError } from "./team-database.ts"
import { TeamAccessError } from "./team-policy.ts"
import { WorkspaceUnavailableError } from "./workspace-safety.ts"

export function apiErrorResponse(err: Error, c: Context): Response {
  if (err instanceof APIError)
    return new Response(
      JSON.stringify({ error: err.message, code: err.body?.code }),
      {
        status: err.statusCode,
        headers: { "Content-Type": "application/json" },
      }
    )
  if (err instanceof TeamAccessError)
    return c.json({ error: err.message, code: err.code }, 403)
  if (err instanceof TeamStateError)
    return c.json({ error: err.message, code: err.code }, 503)
  if (err instanceof WorkspaceUnavailableError) {
    return c.json({ error: err.message, code: err.code }, 503)
  }
  // A comment on a Doc that is not there, or a comment that is gone.
  if (err instanceof DocumentAnnotationError) {
    return err.reason === "not-found"
      ? c.json({ error: err.message, code: "NOT_FOUND" }, 404)
      : c.json({ error: err.message, code: "CONFLICT" }, 409)
  }
  if (err instanceof SpaceTooLargeError) {
    return c.json({ error: err.message, code: err.code }, 413)
  }
  if (err instanceof StorageLimitError) {
    return c.json(storageLimitBody(err), 507)
  }
  return unexpectedErrorResponse(c, err)
}
