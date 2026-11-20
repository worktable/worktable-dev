// ============================================================
// GET /api/viewers: the frames files are shown in, and their files
// ============================================================
//
// See viewer-frames.ts. These carry no workspace content: the frame is
// viewer code, and a viewer's files are its fonts and decoders.

import { Hono } from "hono"
import { viewerFileResponse, viewerFrameResponse } from "../viewer-frames.ts"

export const viewersRouter = new Hono()

viewersRouter.get("/:key", (c) =>
  viewerFrameResponse(c.req.param("key"), c.req.raw)
)

viewersRouter.get("/:key/files/:kind/:name", (c) =>
  viewerFileResponse(
    c.req.param("key"),
    c.req.param("kind"),
    c.req.param("name"),
    c.req.raw
  )
)
