// The links file tools hand an agent: a short-lived download link with every
// read of a file, and a one-time upload link from files_write's upload.

import {
  issueFileTicket,
  type FileTicketInput,
  type HtmlUploadCall,
} from "../file-tickets.ts"
import type { FileUploadMode } from "../file-uploads.ts"
import { currentRequestIdentity } from "../team-policy.ts"
import type { RequestPrincipal } from "../token-store.ts"

function linkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/api/file-links/${token}`
}

function ticketMaker(principal: RequestPrincipal) {
  return {
    identity: currentRequestIdentity() ?? null,
    principal,
    actor: principal.id,
  }
}

/**
 * A download link for a file, or nothing where links can't reach. With
 * `revision`, the revision a read gave the agent, it gives those bytes or
 * none.
 */
export function fileDownloadLink(
  origin: string | null | undefined,
  principal: RequestPrincipal,
  spaceId: string,
  path: string,
  revision?: string
): { downloadUrl: string; downloadExpiresAt: string } | Record<string, never> {
  if (!origin) return {}
  const ticket: FileTicketInput = {
    kind: "download",
    spaceId,
    path,
    ...(revision !== undefined ? { revision } : {}),
    ...ticketMaker(principal),
  }
  const { token, expiresAt } = issueFileTicket(ticket)
  return {
    downloadUrl: linkUrl(origin, token),
    downloadExpiresAt: new Date(expiresAt).toISOString(),
  }
}

/** A one-time upload link for a file at `path`. */
export function fileUploadLink(
  origin: string,
  principal: RequestPrincipal,
  spaceId: string,
  path: string,
  mode: FileUploadMode
): { uploadUrl: string; expiresAt: string } {
  const { token, expiresAt } = issueFileTicket({
    kind: "upload",
    spaceId,
    path,
    mode,
    ...ticketMaker(principal),
  })
  return {
    uploadUrl: linkUrl(origin, token),
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

/** A one-time upload link that finishes an HTML Doc's create or update. */
export function htmlUploadLink(
  origin: string,
  principal: RequestPrincipal,
  spaceId: string,
  path: string,
  call: HtmlUploadCall
): { uploadUrl: string; expiresAt: string } {
  const { token, expiresAt } = issueFileTicket({
    kind: "html-upload",
    spaceId,
    path,
    call,
    ...ticketMaker(principal),
  })
  return {
    uploadUrl: linkUrl(origin, token),
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

/**
 * A download link for an HTML Doc's source at the revision a read gave, or
 * nothing where links can't reach. Its first use after a change refuses.
 */
export function htmlDownloadLink(
  origin: string | null | undefined,
  principal: RequestPrincipal,
  spaceId: string,
  path: string,
  revision: string
): { downloadUrl: string; downloadExpiresAt: string } | Record<string, never> {
  if (!origin) return {}
  const { token, expiresAt } = issueFileTicket({
    kind: "download",
    spaceId,
    path,
    html: { revision },
    ...ticketMaker(principal),
  })
  return {
    downloadUrl: linkUrl(origin, token),
    downloadExpiresAt: new Date(expiresAt).toISOString(),
  }
}
