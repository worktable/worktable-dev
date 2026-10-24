import type { SharingPolicy } from "@worktable/types"
import {
  shareTicketLinkId,
  validShareTicket,
} from "./share-link-credentials.ts"
import { resolve } from "node:path"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import {
  DOC_CONTENT_MAX_BYTES,
  docContentRevision,
  docStoredAs,
  documentContentRevisions,
  htmlContentRevisionOf,
  sha256Hex,
} from "./document-content-revision.ts"
import { publicShareKind } from "./document-page-service.ts"
import {
  DocumentSpaceNotFoundError,
  readDocumentIdentities,
  useResolvedDocumentHandle,
} from "./document-query.ts"
import {
  DocumentSourceReadError,
  readDocumentSource,
} from "./document-source-reader.ts"
import {
  findShareLinkForView,
  findShareLinkWithPolicy,
  ShareLinksStoreError,
  type StoredShareLink,
} from "./share-links-store.ts"
import { effectiveExpiresAt, linkBlockedBy } from "./share-policy.ts"
import { readWidgetDocument } from "./widget-store.ts"
import { getWorkspaceRoot } from "./workspace.ts"

// ============================================================
// What a share link shows, for anonymous visitors
// ============================================================
//
// Resolving a token costs one indexed SELECT, which also reads the owner
// policy's revision, and the Space's read-model snapshot: no share lock, no
// file read while the snapshot is current, and no second lookup after
// rendering. The owner policy and the creator's access are checked on every
// view from memory, so tightening the policy cuts a link off at its next view. The document is found by its durable id, so
// a rename or move keeps the link, and the content revision lets the caller
// answer from its cache without reading content. Only a cache miss reads the
// document, through the same snapshot read members use, and only if the id
// it finds is the link's.

const READ_TIMEOUT_MS = 30_000

export interface ShareLinkView {
  link: StoredShareLink
  path: string
  title: string
  /** The content revision now, or null when the document has none. */
  revision: string | null
  expiresAt: number | null
  ticketSecret: Uint8Array | null
  policy: SharingPolicy
  policyRevision: number
}

/**
 * The live link a token opens and where its document is now. Null when the
 * token is not one of this store's (older links may still know it);
 * "unavailable" for a link that exists but must not be served.
 */
export async function resolveShareLinkView(
  capability: string,
  options: {
    content?: boolean
    unlock?: string
    allowLocked?: boolean
    revision?: boolean
  } = {}
): Promise<
  ShareLinkView | "unavailable" | "expired" | "password-required" | null
> {
  const frameId = options.content
    ? shareTicketLinkId(capability, "frame")
    : null
  // Every HTML frame takes a ticket, never the bearer link.
  if (options.content && !frameId) return "unavailable"
  const found = frameId
    ? findShareLinkWithPolicy(frameId)
    : findShareLinkForView(capability)
  if (!found) return null
  const { link } = found
  const now = Date.now()
  if (
    frameId &&
    (link.kind !== "html" ||
      !found.unlockSecret ||
      !validShareTicket(capability, found.unlockSecret, link, "frame", now))
  )
    return "unavailable"
  const { policy } = found
  const blocked = linkBlockedBy(link, policy, now)
  if (
    link.revokedAt !== null ||
    (blocked !== null && blocked !== "expiry-cap") ||
    link.workspaceEpoch !== (await getWorkspaceCollaborationEpoch())
  )
    return "unavailable"
  const expiresAt = effectiveExpiresAt(link, policy)
  if (expiresAt !== null && expiresAt <= now)
    return "expired"
  if (!frameId && link.hasPassword && !options.allowLocked) {
    if (
      !found.unlockSecret ||
      !validShareTicket(options.unlock, found.unlockSecret, link, "unlock", now)
    )
      return "password-required"
  }
  let snapshot: Awaited<ReturnType<typeof readDocumentIdentities>>
  try {
    snapshot = await readDocumentIdentities(link.spaceId)
  } catch (error) {
    if (error instanceof DocumentSpaceNotFoundError) return "unavailable"
    throw error
  }
  const { catalog, identities } = snapshot
  const target = identities.current.get(link.documentId)
  if (identities.spaceArchived || !target) return "unavailable"
  const revisions =
    options.revision === false || link.grant
      ? null
      : await documentContentRevisions(link.spaceId, [target.path], catalog)
  return {
    link,
    expiresAt,
    ticketSecret: found.unlockSecret,
    policy,
    policyRevision: found.policyRevision,
    path: target.path,
    title: target.title,
    revision: revisions?.get(target.path) ?? null,
  }
}

/**
 * Whether a link a view resolved still opens: checked again after rendering
 * a page, which can take a while, so a link revoked or held back meanwhile
 * isn't served. A store that can't be read says no.
 */
export function shareLinkStillOpens(
  link: StoredShareLink,
  policyRevision?: number,
  options: { comments?: boolean } = {}
): boolean {
  let found: ReturnType<typeof findShareLinkWithPolicy>
  try {
    found = findShareLinkWithPolicy(link.id)
  } catch (error) {
    if (error instanceof ShareLinksStoreError) return false
    throw error
  }
  const now = Date.now()
  return Boolean(
    found &&
    (!options.comments ||
      (found.link.level === link.level &&
        found.link.comments.acceptComments === link.comments.acceptComments)) &&
    found.link.revokedAt === null &&
    found.link.passwordRevision === link.passwordRevision &&
    found.link.grantRevision === link.grantRevision &&
    (policyRevision === undefined || found.policyRevision === policyRevision) &&
    !(found.link.expiresAt !== null && found.link.expiresAt <= now) &&
    linkBlockedBy(found.link, found.policy, now) === null
  )
}

export type ShareLinkDocument =
  | {
      kind: "doc"
      title: string
      revision: string
      format: "markdown" | "blocknote"
      content: unknown[] | string
    }
  | { kind: "html"; title: string; revision: string; html: string }
  /** An HTML Doc's outer page needs only its title. */
  | { kind: "html-title"; title: string }

/**
 * Read the link's document for rendering. Null when the path now holds
 * another document, the document can no longer be shared this way, or its
 * source cannot be read.
 */
export async function readShareLinkDocument(
  view: ShareLinkView,
  surface: "projection" | "content"
): Promise<ShareLinkDocument | null> {
  const { link } = view
  const result = await useResolvedDocumentHandle(
    { spaceId: link.spaceId, path: view.path, snapshot: true },
    async (handle): Promise<{ document: ShareLinkDocument | null }> => {
      if (
        handle.documentId !== link.documentId ||
        handle.document.health !== "supported" ||
        (await publicShareKind(handle)) !== link.kind
      ) {
        return { document: null }
      }
      const title = handle.document.title
      if (link.kind === "html") {
        if (surface === "projection") {
          return { document: { kind: "html-title", title } }
        }
        const { data } = await readWidgetDocument(
          link.spaceId,
          handle.document.path
        )
        if (!data || data.widget.archive) return { document: null }
        return {
          document: {
            kind: "html",
            title,
            revision: htmlContentRevisionOf(data),
            html: data.html,
          },
        }
      }
      const storedAs =
        handle.source.kind === "file"
          ? docStoredAs(handle.source.relativePath)
          : null
      if (surface !== "projection" || !storedAs) return { document: null }
      let bytes: Uint8Array
      try {
        bytes = await readDocumentSource({
          spaceRoot: resolve(getWorkspaceRoot(), "spaces", link.spaceId),
          documentId: handle.documentId,
          format: handle.document.format,
          source: handle.source,
          maxBytes: DOC_CONTENT_MAX_BYTES,
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        })
      } catch (error) {
        if (error instanceof DocumentSourceReadError) return { document: null }
        throw error
      }
      const revision = docContentRevision({
        storedAs,
        sha256: sha256Hex(bytes),
      })
      const text = Buffer.from(bytes).toString("utf8")
      if (storedAs === "md") {
        return {
          document: {
            kind: "doc",
            title,
            revision,
            format: "markdown",
            content: text,
          },
        }
      }
      let blocks: unknown
      try {
        blocks = JSON.parse(text)
      } catch {
        return { document: null }
      }
      if (!Array.isArray(blocks)) return { document: null }
      return {
        document: {
          kind: "doc",
          title,
          revision,
          format: "blocknote",
          content: blocks,
        },
      }
    }
  )
  return "document" in result ? result.document : null
}
