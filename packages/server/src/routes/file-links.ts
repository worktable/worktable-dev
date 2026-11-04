// File links for agents: PUT sends a file to a one-time upload link, GET
// reads one from a download link. The link's token is the credential, so
// these routes sit outside the API's sign-in; each runs as whoever made the
// link, with their access checked again now.

import { Hono } from "hono"
import { runAsActivityActor } from "../activity-log.ts"
import { resolveCurrentFile } from "../document-page-service.ts"
import { DocumentWriteError } from "../document-write-service.ts"
import {
  pinDownloadTicket,
  redeemFileTicket,
  type FileTicket,
} from "../file-tickets.ts"
import { serveFile, servedCurrentFile } from "../file-response.ts"
import { FileRevisionError } from "../file-revision.ts"
import {
  FILE_UPLOAD_MAX_BYTES,
  FILE_UPLOAD_TOO_LARGE,
  withStagedUpload,
  writeUploadedFile,
} from "../file-uploads.ts"
import type { StagedFile } from "../staged-file.ts"
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

const CHANGED = {
  error: "This file changed after the link was made. Read it again for a new link.",
  code: "FILE_CHANGED",
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
  const saved = await withStagedUpload(c.req.raw, (file) =>
    saveFileLinkUpload(ticket, file)
  )
  if (!saved) {
    return c.json({ error: FILE_UPLOAD_TOO_LARGE, code: "PAYLOAD_TOO_LARGE" }, 413)
  }
  return c.json(saved.body, saved.status)
})

/**
 * Save an upload link's staged file as whoever made the link. Its ticket is
 * already redeemed: here, or by Worktable Link once every piece is in.
 */
export async function saveFileLinkUpload(
  ticket: Extract<FileTicket, { kind: "upload" }>,
  file: StagedFile
) {
  try {
    const written = await asMaker(ticket, () =>
      writeUploadedFile({
        spaceId: ticket.spaceId,
        path: ticket.path,
        file,
        mode: ticket.mode,
        actor: ticket.actor,
        source: "mcp",
      })
    )
    return {
      body: {
        ok: true,
        path: written.result.path,
        sourceRevision: written.result.sourceRevision,
        byteLength: file.byteLength,
        contentHash: written.contentHash,
      },
      status: written.status,
    }
  } catch (error) {
    const failure = writeFailure(error)
    if (failure) return failure
    throw error
  }
}

fileLinksRouter.get("/:token", async (c) => {
  if (!filesEnabled()) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const ticket = redeemFileTicket(c.req.param("token"), "download")
  if (!ticket || ticket.kind !== "download") return c.json(GONE, 410)
  try {
    const result = await asMaker(ticket, () => {
      // The maker may have lost the Space since making the link.
      assertSpaceAccess(ticket.spaceId, "read")
      return resolveCurrentFile({
        spaceId: ticket.spaceId,
        path: ticket.path,
        ...(ticket.revision !== undefined ? { revision: ticket.revision } : {}),
      })
    })
    if (result.kind === "not-found") {
      return c.json({ error: "File not found.", code: "NOT_FOUND" }, 404)
    }
    if (result.kind === "changed") return c.json(CHANGED, 409)
    if (result.kind !== "file") {
      return c.json({ error: "This file can't be read safely.", code: "CONFLICT" }, 409)
    }
    pinDownloadTicket(ticket, result.current.pinned.revision)
    // Two first uses at once pin only the first one's revision.
    if (ticket.revision !== result.current.pinned.revision) return c.json(CHANGED, 409)
    return await serveFile(c, await servedCurrentFile(result.current), {
      cacheForGood: false,
    })
  } catch (error) {
    if (error instanceof TeamAccessError) {
      return c.json({ error: "File not found.", code: "NOT_FOUND" }, 404)
    }
    if (error instanceof FileRevisionError) {
      return error.reason === "changed"
        ? c.json(CHANGED, 409)
        : c.json({ error: "This file can't be read safely.", code: "SOURCE_UNAVAILABLE" }, 409)
    }
    throw error
  }
})
