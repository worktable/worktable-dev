// The links file tools hand an agent: a short-lived download link with every
// read of a file, and a one-time upload link from files_write's upload.

import { issueFileTicket, type FileTicketInput } from "../file-tickets.ts"
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

/** A download link for a file, or nothing where links can't reach. */
export function fileDownloadLink(
  origin: string | null | undefined,
  principal: RequestPrincipal,
  spaceId: string,
  path: string
): { downloadUrl: string; downloadExpiresAt: string } | Record<string, never> {
  if (!origin) return {}
  const ticket: FileTicketInput = {
    kind: "download",
    spaceId,
    path,
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
