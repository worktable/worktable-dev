// File links for agents: PUT sends a file to a one-time upload link, GET
// reads one from a download link. The link's token is the credential, so
// these routes sit outside the API's sign-in; each runs as whoever made the
// link, with their access checked again now.

import { Hono } from "hono"
import { runAsActivityActor } from "../activity-log.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "../document-format-registry.ts"
import { readRawDocumentSource } from "../document-page-service.ts"
import { DocumentSourceReadError } from "../document-source-errors.ts"
import { DocumentWriteError } from "../document-write-service.ts"
import { redeemFileTicket, type FileTicket } from "../file-tickets.ts"
import { serveFileBytes } from "../file-response.ts"
import {
  FILE_UPLOAD_MAX_BYTES,
  FILE_UPLOAD_TOO_LARGE,
  readLimitedBody,
  writeUploadedFile,
} from "../file-uploads.ts"
import { filesEnabled } from "../files-enabled.ts"
import {
  assertSpaceAccess,
  runWithTeamIdentity,
  TeamAccessError,
} from "../team-policy.ts"

export const fileLinksRouter = new Hono()

const GONE = {
  error: "This link has expired or was used. Ask for a new one.",
  code: "LINK_EXPIRED",
}

function asMaker<T>(ticket: FileTicket, work: () => Promise<T>): Promise<T> {
  const run = () => runAsActivityActor(ticket.principal, work)
  return ticket.identity ? runWithTeamIdentity(ticket.identity, run) : run()
}

function writeFailure(error: unknown) {
  if (!(error instanceof DocumentWriteError)) return null
  const status =
    error.reason === "not-found"
      ? 404
      : error.reason === "forbidden"
        ? 403
        : error.reason === "invalid"
          ? 400
          : 409
  return { body: { error: error.message, code: error.reason.toUpperCase() }, status } as const
}

fileLinksRouter.put("/:token", async (c) => {
  if (!filesEnabled()) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const declared = Number(c.req.header("content-length") ?? "0")
  if (declared > FILE_UPLOAD_MAX_BYTES) {
    return c.json({ error: FILE_UPLOAD_TOO_LARGE, code: "PAYLOAD_TOO_LARGE" }, 413)
  }
  const ticket = redeemFileTicket(c.req.param("token"), "upload")
  if (!ticket || ticket.kind !== "upload") return c.json(GONE, 410)
  const bytes = await readLimitedBody(c.req.raw, FILE_UPLOAD_MAX_BYTES)
  if (!bytes) {
    return c.json({ error: FILE_UPLOAD_TOO_LARGE, code: "PAYLOAD_TOO_LARGE" }, 413)
  }
  try {
    const written = await asMaker(ticket, () =>
      writeUploadedFile({
        spaceId: ticket.spaceId,
        path: ticket.path,
        bytes,
        mode: ticket.mode,
        actor: ticket.actor,
        source: "mcp",
      })
    )
    return c.json(
      {
        ok: true,
        path: written.result.path,
        sourceRevision: written.result.sourceRevision,
        byteLength: bytes.byteLength,
        contentHash: written.contentHash,
      },
      written.status
    )
  } catch (error) {
    const failure = writeFailure(error)
    if (failure) return c.json(failure.body, failure.status)
    throw error
  }
})

fileLinksRouter.get("/:token", async (c) => {
  if (!filesEnabled()) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const ticket = redeemFileTicket(c.req.param("token"), "download")
  if (!ticket) return c.json(GONE, 410)
  try {
    const result = await asMaker(ticket, () => {
      // The maker may have lost the Space since making the link.
      assertSpaceAccess(ticket.spaceId, "read")
      return readRawDocumentSource({
        spaceId: ticket.spaceId,
        path: ticket.path,
        includeArchived: true,
      })
    })
    if (
      result.kind === "not-found" ||
      (result.kind === "source" &&
        result.source.formatId !== BUILTIN_DOCUMENT_FORMATS.file)
    ) {
      return c.json({ error: "File not found.", code: "NOT_FOUND" }, 404)
    }
    if (result.kind !== "source") {
      return c.json({ error: "This file can't be read safely.", code: "CONFLICT" }, 409)
    }
    return serveFileBytes(c, result.source.bytes, result.source.fileName, {
      cacheForGood: false,
    })
  } catch (error) {
    if (error instanceof TeamAccessError) {
      return c.json({ error: "File not found.", code: "NOT_FOUND" }, 404)
    }
    if (error instanceof DocumentSourceReadError) {
      return c.json(
        { error: "This file can't be read safely.", code: "SOURCE_UNAVAILABLE" },
        409
      )
    }
    const failure = writeFailure(error)
    if (failure) return c.json(failure.body, failure.status)
    throw error
  }
})
