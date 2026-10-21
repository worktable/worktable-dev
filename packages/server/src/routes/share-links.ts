import {
  CreateShareLinkInputSchema,
  ShareLinkKindSchema,
  ShareLinkLevelSchema,
  ShareTargetSchema,
  UpdateShareLinkInputSchema,
  type CreatedShareLink,
  type DocumentShareLinks,
  type ShareLink,
  type ShareLinksPage,
  type SharerPolicy,
  type SharingPolicy,
  type ShareTarget,
} from "@worktable/types"
import { Hono, type Context } from "hono"
import { z } from "zod"
import { mapWithConcurrency } from "../bounded-concurrency.ts"
import { getWorkspaceCollaborationEpoch } from "../collaboration-epoch.ts"
import { publicShareKind } from "../document-page-service.ts"
import {
  readDocumentIdentities,
  useResolvedDocumentHandle,
} from "../document-query.ts"
import { getDocumentSharingConfig } from "../linked-sharing.ts"
import {
  createShareLink,
  getShareLink,
  listDocumentShareLinks,
  listShareLinks,
  revokeShareLink,
  ShareLinksStoreError,
  sharingV2Active,
  updateShareLink,
  type StoredShareLink,
} from "../share-links-store.ts"
import {
  authorizeShareAction,
  currentSharingPolicy,
  effectiveExpiresAt,
  expiryAllowed,
  linkBlockedBy,
  sharerOf,
  type ShareDecision,
} from "../share-policy.ts"
import { ShareArtifactInput } from "../shared-artifact.ts"
import { getSpaceArchiveInfo, listSpaces, readSpace } from "../store.ts"
import { teamsEnabled } from "../team-database.ts"
import { canAccessSpace } from "../team-policy.ts"
import type { TokenIdentity } from "../token-store.ts"

// Share links (v2), behind the sharing preview until the dialog moves to
// them. Mounted inside the shares router, which admits only people: the
// Worktable owner, or in Teams a member.

export const shareLinksRouter = new Hono()

const PAGE_SIZE = 100
const SPACE_READS_AT_ONCE = 4

shareLinksRouter.use("*", async (c, next) => {
  if (!sharingV2Active()) {
    return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  }
  return next()
})

shareLinksRouter.onError((error, c) => {
  // A store from a later version stays closed to this one.
  if (error instanceof ShareLinksStoreError) {
    return c.json(
      { error: "Share links are unavailable", code: error.code },
      503
    )
  }
  throw error
})

type Place = { path: string; title: string } | null

function iso(time: number | null): string | null {
  return time === null ? null : new Date(time).toISOString()
}

function publicLink(
  link: StoredShareLink,
  place: Place,
  canManage: boolean,
  policy: SharingPolicy,
  now = Date.now()
): ShareLink {
  const level = ShareLinkLevelSchema.safeParse(link.level)
  const blockedBy =
    link.revokedAt === null ? linkBlockedBy(link, policy, now) : null
  const status: ShareLink["status"] =
    link.revokedAt !== null
      ? "revoked"
      : link.expiresAt !== null && link.expiresAt <= now
        ? "expired"
        : blockedBy
          ? "blocked"
          : "active"
  return {
    id: link.id,
    spaceId: link.spaceId,
    documentId: link.documentId,
    kind: ShareLinkKindSchema.catch("doc").parse(link.kind),
    path: place?.path ?? null,
    title: place?.title ?? null,
    label: link.label,
    level: level.success ? level.data : "view",
    createdBy: { id: link.createdById, name: link.createdByName },
    createdAt: iso(link.createdAt)!,
    expiresAt: iso(effectiveExpiresAt(link, policy)),
    hasPassword: link.hasPassword,
    lastUsedAt: iso(link.lastUsedAt),
    status,
    ...(status === "blocked" && blockedBy ? { blockedBy } : {}),
    tokenHint: link.tokenHint,
    canManage,
    comments: { ...link.comments, autoPaused: false },
  }
}

/** Where each link's document is now, one snapshot read per Space. */
async function placesOf(
  links: readonly StoredShareLink[]
): Promise<Map<string, Place>> {
  const places = new Map<string, Place>()
  // Through each Space's read-model snapshot, as Recent and search rows are:
  // a current snapshot costs no file reads, and a Space read cold publishes
  // its snapshot for the next reader. A few Spaces at a time.
  await mapWithConcurrency(
    [...new Set(links.map((link) => link.spaceId))],
    SPACE_READS_AT_ONCE,
    async (spaceId) => {
      let current: ReadonlyMap<string, { path: string; title: string }>
      try {
        current = (await readDocumentIdentities(spaceId)).identities.current
      } catch {
        current = new Map()
      }
      for (const link of links) {
        if (link.spaceId === spaceId) {
          places.set(link.id, current.get(link.documentId) ?? null)
        }
      }
    }
  )
  return places
}

/** The owner policy as it limits the share dialog. */
function sharerPolicy(policy: SharingPolicy): SharerPolicy {
  return {
    requirePassword: policy.requirePassword,
    maxExpiryDays: policy.maxExpiryDays,
    levels: policy.levels,
    liveLinks: policy.liveLinks,
    records: policy.records,
    recordsDefaultExpiryDays: policy.recordsDefaultExpiryDays,
    allowComments: policy.allowComments,
    allowVisitorsSeeAll: policy.allowVisitorsSeeAll,
  }
}

type Denied = Exclude<ShareDecision, { allowed: true }>

const DENIED: Record<Denied["code"], string> = {
  FORBIDDEN: "Forbidden",
  LEVEL_NOT_AVAILABLE: "Links can't have that access here",
  SHARING_PAUSED: "Links are paused for this Worktable",
  SPACE_NOT_ALLOWED: "Links aren't allowed in this Space",
}

function denied(c: Context, decision: Denied) {
  return c.json(
    { error: DENIED[decision.code], code: decision.code },
    decision.status
  )
}

/** A new expiry past the owner policy's longest one. */
function expiryTooLong(c: Context, policy: SharingPolicy) {
  return c.json(
    {
      error: `Links here expire within ${policy.maxExpiryDays} days`,
      code: "EXPIRY_TOO_LONG",
    },
    400
  )
}

function invalid(c: Context, message: string, code = "VALIDATION_ERROR") {
  return c.json({ error: message, code }, 400)
}

function notFound(c: Context) {
  return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
}

/** An expiry in the future, in ms, or an error message. */
function expiryOf(value: string | null | undefined): number | null | string {
  if (value === null || value === undefined) return null
  const at = Date.parse(value)
  return at > Date.now() ? at : "A link must expire in the future"
}

/** The paths today's share routes accept for each kind. */
function safeTarget(target: ShareTarget): boolean {
  return ShareArtifactInput.safeParse({
    kind: target.kind,
    spaceId: target.spaceId,
    artifactKey: target.path,
  }).success
}

function identityOf(c: Context): TokenIdentity | undefined {
  return c.get("identity")
}

shareLinksRouter.get("/", async (c) => {
  const target = ShareTargetSchema.safeParse({
    kind: c.req.query("kind"),
    spaceId: c.req.query("spaceId"),
    path: c.req.query("path"),
  })
  if (!target.success) return invalid(c, target.error.message)
  if (!safeTarget(target.data)) return invalid(c, "Invalid document path")
  const { spaceId, path, kind } = target.data
  const identity = identityOf(c)
  const read = authorizeShareAction(identity, "read", spaceId)
  if (!read.allowed) return denied(c, read)

  const resolution = await useResolvedDocumentHandle(
    { spaceId, path, snapshot: true },
    async (handle) => ({
      documentId: handle.documentId,
      place: { path: handle.document.path, title: handle.document.title },
      shareable: (await publicShareKind(handle)) === kind,
    })
  )
  if (!("documentId" in resolution)) return notFound(c)
  const { data: space } = await readSpace(spaceId)
  const policy = currentSharingPolicy()
  const create = authorizeShareAction(identity, "create", spaceId, { policy })
  const canCreate =
    create.allowed &&
    resolution.shareable &&
    Boolean(space && !getSpaceArchiveInfo(space))
  const links = listDocumentShareLinks(spaceId, resolution.documentId)
  const now = Date.now()
  const body: DocumentShareLinks = {
    links: links.map((link) =>
      publicLink(
        link,
        resolution.place,
        authorizeShareAction(identity, "manage", spaceId, {
          policy,
          creatorId: link.createdById,
        }).allowed,
        policy,
        now
      )
    ),
    canCreate,
    ...(!create.allowed && create.blockedBy
      ? { createBlockedBy: create.blockedBy }
      : {}),
    policy: sharerPolicy(policy),
  }
  return c.json(body)
})

shareLinksRouter.post("/", async (c) => {
  const input = CreateShareLinkInputSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!input.success) return invalid(c, input.error.message)
  const { target, label, level, comments } = input.data
  if (!safeTarget(target)) return invalid(c, "Invalid document path")
  const identity = identityOf(c)
  const policy = currentSharingPolicy()
  const decision = authorizeShareAction(identity, "create", target.spaceId, {
    level,
    policy,
  })
  if (!decision.allowed) return denied(c, decision)
  if (input.data.password !== undefined) {
    return invalid(
      c,
      "Passwords aren't available yet",
      "PASSWORD_NOT_AVAILABLE"
    )
  }
  const expiresAt = expiryOf(input.data.expiresAt)
  if (typeof expiresAt === "string") return invalid(c, expiresAt)
  if (!expiryAllowed(expiresAt, policy)) return expiryTooLong(c, policy)
  const { data: space } = await readSpace(target.spaceId)
  if (!space || getSpaceArchiveInfo(space)) return notFound(c)

  const workspaceEpoch = await getWorkspaceCollaborationEpoch()
  // The id is made durable first, as comments do, so the link follows the
  // document through renames and moves. Creating under the document's path
  // lock orders it against an archive or delete of the same document.
  const created = await useResolvedDocumentHandle(
    { spaceId: target.spaceId, path: target.path, materializeIdentity: true },
    async (handle) => {
      if ((await publicShareKind(handle)) !== target.kind) return null
      // Sharing can stop while this request waits, as when Link disconnects;
      // a link nobody can be given is never made.
      const config = getDocumentSharingConfig()
      if (!config) return null
      // Policy and membership may change during document resolution. Nothing
      // asynchronous separates this final authorization from the insert.
      const latestPolicy = currentSharingPolicy()
      const latestDecision = authorizeShareAction(
        identity,
        "create",
        target.spaceId,
        {
          level,
          policy: latestPolicy,
        }
      )
      if (!latestDecision.allowed) return { denied: latestDecision }
      if (!expiryAllowed(expiresAt, latestPolicy))
        return { expiryPolicy: latestPolicy }
      return {
        config,
        ...createShareLink({
          workspaceEpoch,
          spaceId: target.spaceId,
          documentId: handle.documentId,
          kind: target.kind,
          label,
          level: "view",
          createdBy: sharerOf(identity!),
          expiresAt,
          comments,
        }),
        place: { path: handle.document.path, title: handle.document.title },
      }
    }
  )
  if (created && "denied" in created && created.denied)
    return denied(c, created.denied)
  if (created && "expiryPolicy" in created && created.expiryPolicy)
    return expiryTooLong(c, created.expiryPolicy)
  if (!created || !("token" in created)) return notFound(c)
  // Archiving or removing a Space changes it before revoking its links, so a
  // link made while that ran is caught here.
  const { data: after } = await readSpace(target.spaceId)
  if (!after || getSpaceArchiveInfo(after)) {
    revokeShareLink(
      created.link.id,
      "system",
      after ? "space-archived" : "space-removed"
    )
    return notFound(c)
  }
  const { config } = created
  const body: CreatedShareLink = {
    link: publicLink(created.link, created.place, true, currentSharingPolicy()),
    url: `${config.shareOrigin}/s/${encodeURIComponent(config.workspaceId)}/${created.token}`,
  }
  return c.json(body, 201)
})

const LinkIdSchema = z.string().regex(/^lnk_[A-Za-z0-9_-]{22}$/)

function linkFor(c: Context): StoredShareLink | null {
  const id = LinkIdSchema.safeParse(c.req.param("linkId"))
  return id.success ? getShareLink(id.data) : null
}

shareLinksRouter.patch("/:linkId", async (c) => {
  const input = UpdateShareLinkInputSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!input.success) return invalid(c, input.error.message)
  const link = linkFor(c)
  if (!link) return notFound(c)
  const identity = identityOf(c)
  const policy = currentSharingPolicy()
  const decision = authorizeShareAction(identity, "manage", link.spaceId, {
    ...(input.data.level ? { level: input.data.level } : {}),
    creatorId: link.createdById,
    policy,
  })
  if (!decision.allowed) return denied(c, decision)
  if (input.data.password !== undefined) {
    return invalid(
      c,
      "Passwords aren't available yet",
      "PASSWORD_NOT_AVAILABLE"
    )
  }
  if (link.revokedAt !== null) {
    return c.json({ error: "This link was revoked", code: "LINK_REVOKED" }, 409)
  }
  const expiresAt =
    input.data.expiresAt === undefined
      ? undefined
      : expiryOf(input.data.expiresAt)
  if (typeof expiresAt === "string") return invalid(c, expiresAt)
  if (expiresAt !== undefined && !expiryAllowed(expiresAt, policy)) {
    return expiryTooLong(c, policy)
  }
  const updated = updateShareLink(link.id, {
    ...(input.data.label !== undefined ? { label: input.data.label } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(input.data.comments ? { comments: input.data.comments } : {}),
  })
  if (!updated) return notFound(c)
  const places = await placesOf([updated])
  return c.json({
    link: publicLink(updated, places.get(updated.id) ?? null, true, policy),
  })
})

shareLinksRouter.delete("/:linkId", async (c) => {
  const link = linkFor(c)
  if (!link) return notFound(c)
  const identity = identityOf(c)
  const policy = currentSharingPolicy()
  const decision = authorizeShareAction(identity, "manage", link.spaceId, {
    creatorId: link.createdById,
    policy,
  })
  if (!decision.allowed) return denied(c, decision)
  const revoked = revokeShareLink(link.id, sharerOf(identity!).id) ?? link
  const places = await placesOf([revoked])
  return c.json({
    link: publicLink(revoked, places.get(revoked.id) ?? null, true, policy),
  })
})

const ListQuerySchema = z.strictObject({
  spaceId: z.string().min(1).max(256).optional(),
  status: z.enum(["active", "expired", "revoked"]).optional(),
  cursor: z.string().max(256).optional(),
})

shareLinksRouter.get("/all", async (c) => {
  const query = ListQuerySchema.safeParse(c.req.query())
  if (!query.success) return invalid(c, query.error.message)
  const identity = identityOf(c)
  const { spaceId, status, cursor } = query.data
  const everything = authorizeShareAction(identity, "oversee", null).allowed
  const visible = (await listSpaces()).filter(
    (space) =>
      everything ||
      (teamsEnabled() && canAccessSpace(space.id, "manage", identity))
  )
  if (spaceId) {
    const decision = authorizeShareAction(identity, "oversee", spaceId)
    if (!decision.allowed) return denied(c, decision)
  } else if (!everything && visible.length === 0) {
    return denied(c, { allowed: false, status: 403, code: "FORBIDDEN" })
  }
  const page = listShareLinks({
    spaceIds: spaceId
      ? [spaceId]
      : everything
        ? null
        : visible.map((s) => s.id),
    ...(status ? { status } : {}),
    cursor: cursor ?? null,
    limit: PAGE_SIZE,
  })
  const places = await placesOf(page.links)
  const policy = currentSharingPolicy()
  const now = Date.now()
  const body: ShareLinksPage = {
    links: page.links.map((link) =>
      publicLink(
        link,
        places.get(link.id) ?? null,
        authorizeShareAction(identity, "manage", link.spaceId, {
          policy,
          creatorId: link.createdById,
        }).allowed,
        policy,
        now
      )
    ),
    nextCursor: page.nextCursor,
    spaces: visible.map((space) => ({ id: space.id, name: space.name })),
  }
  return c.json(body)
})
