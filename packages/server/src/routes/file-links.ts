// File links for agents: PUT sends a file to a one-time upload link, GET
// reads one from a download link. The link's token is the credential, so
// these routes sit outside the API's sign-in; each runs as whoever made the
// link, with their access checked again now.

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Hono, type Context } from "hono"
import { runAsActivityActor } from "../activity-log.ts"
import { resolveCurrentFile } from "../document-page-service.ts"
import { DocumentWriteError } from "../document-write-service.ts"
import {
  pinDownloadTicket,
  redeemFileTicket,
  type FileTicket,
  type UploadTicket,
} from "../file-tickets.ts"
import { serveFile, servedCurrentFile } from "../file-response.ts"
import {
  contentHashFromHex,
  contentHashOf,
  currentFileRevision,
  FileRevisionError,
  sha256Check,
} from "../file-revision.ts"
import { readDocumentCatalogSnapshot } from "../document-query.ts"
import { resolveHtmlDocumentStorageV2 } from "../html-document-storage-v2.ts"
import { HtmlPermissionError } from "../html-permission-authority.ts"
import { DocEditError } from "../markdown-edit.ts"
import { dispatchOperation } from "../mcp/dispatcher.ts"
import { getWorkspaceRoot } from "../workspace.ts"
import {
  FILE_UPLOAD_MAX_BYTES,
  FILE_UPLOAD_TOO_LARGE,
  FileReplaceRefused,
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
  if (error instanceof FileReplaceRefused) {
    return {
      body: { error: error.message, code: error.code, ...error.details },
      status: 409,
    } as const
  }
  if (!(error instanceof DocumentWriteError)) return null
  const status =
    error.reason === "not-found"
      ? 404
      : error.reason === "forbidden"
        ? 403
        : error.reason === "invalid"
          ? 400
          : 409
  return { body: { error: error.message, code: error.code }, status } as const
}

fileLinksRouter.put("/:token", async (c) => {
  if (!filesEnabled()) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const declared = Number(c.req.header("content-length") ?? "0")
  if (declared > FILE_UPLOAD_MAX_BYTES) {
    return c.json({ error: FILE_UPLOAD_TOO_LARGE, code: "PAYLOAD_TOO_LARGE" }, 413)
  }
  const ticket = redeemFileTicket(c.req.param("token"), "upload")
  if (!ticket || ticket.kind === "download") return c.json(GONE, 410)
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
export async function saveFileLinkUpload(ticket: UploadTicket, file: StagedFile) {
  if (ticket.kind === "html-upload") return saveHtmlLinkUpload(ticket, file)
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
    if (ticket.html) return await serveHtmlSource(c, ticket, ticket.html.revision)
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

const USED_UP = "This link is used up: ask worktable_html_write for a new one."

/**
 * Finish the HTML Doc write an upload link stands for, now that its page is
 * here: the same create or update the agent's call would have made, as that
 * agent, with its rules and the revision it named checked again.
 */
async function saveHtmlLinkUpload(
  ticket: Extract<FileTicket, { kind: "html-upload" }>,
  file: StagedFile
) {
  let html: string
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file.path))
  } catch {
    return {
      body: { error: `The page isn't UTF-8 text. Nothing was saved. ${USED_UP}`, code: "INVALID_ENCODING" },
      status: 400,
    } as const
  }
  if (!html.trim()) {
    return { body: { error: `The page is empty. Nothing was saved. ${USED_UP}`, code: "EMPTY" }, status: 400 } as const
  }
  const { call } = ticket
  try {
    const result = (await asMaker(ticket, () =>
      dispatchOperation(call.operation, { ...call.args, html }, {
        principal: ticket.principal,
        identity: call.agentIdentity,
        scopes: call.scopes,
        surface: "preview",
      })
    )) as { widgetId: string; revision: string; warnings: unknown[] }
    return {
      body: {
        ok: true,
        htmlId: result.widgetId,
        revision: result.revision,
        byteLength: file.byteLength,
        warnings: result.warnings,
      },
      status: call.operation === "html.create" ? 201 : 200,
    } as const
  } catch (error) {
    if (error instanceof DocEditError && error.code === "revision_conflict") {
      return {
        body: {
          error: `${error.message} Nothing was saved. ${USED_UP}`,
          code: "REVISION_CHANGED",
          ...error.details,
        },
        status: 409,
      } as const
    }
    if (error instanceof HtmlPermissionError) {
      return { body: { error: error.message, code: "FORBIDDEN", missingScope: error.missingScope }, status: 403 } as const
    }
    if (error instanceof TeamAccessError) {
      return { body: { error: "HTML Doc not found.", code: "NOT_FOUND" }, status: 404 } as const
    }
    // What the tool call would have answered: the page, its path or its
    // permissions don't fit. Nothing was saved.
    if (error instanceof Error) {
      return { body: { error: `${error.message} ${USED_UP}`, code: "REFUSED" }, status: 400 } as const
    }
    throw error
  }
}

/**
 * An HTML Doc's source at the revision a read gave, as an attachment that
 * never runs; once the page changes, the link refuses rather than give
 * other bytes.
 */
async function serveHtmlSource(
  c: Context,
  ticket: Extract<FileTicket, { kind: "download" }>,
  revision: string
): Promise<Response> {
  const source = await asMaker(ticket, async () => {
    // The maker may have lost the Space since making the link.
    assertSpaceAccess(ticket.spaceId, "read")
    // From the read model: each piece of a download asks again.
    const owner = await resolveHtmlDocumentStorageV2(
      ticket.spaceId,
      ticket.path,
      await readDocumentCatalogSnapshot(ticket.spaceId)
    )
    if (!owner) return null
    const path = resolve(getWorkspaceRoot(), "spaces", ticket.spaceId, owner.sourceRelativePath)
    const { revision: fileRevision, size } = await currentFileRevision(path)
    return { path, revision: fileRevision, size }
  })
  if (!source) return c.json({ error: "HTML Doc not found.", code: "NOT_FOUND" }, 404)
  const hex = revision.slice(revision.lastIndexOf(":") + 1)
  const contentHash = await contentHashOf(source)
  if (contentHash !== contentHashFromHex(hex)) {
    return c.json({ error: "This HTML Doc changed after the link was made. Read it again for a new link.", code: "FILE_CHANGED" }, 409)
  }
  return serveFile(
    c,
    {
      fileName: `${ticket.path.split("/").at(-1)}.html`,
      pinned: source,
      contentHash,
      verify: () => sha256Check(hex),
    },
    { cacheForGood: false }
  )
}
