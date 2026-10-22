import { createHmac, randomBytes } from "node:crypto"
import { LinkGrantSchema, type LinkGrant } from "@worktable/types"
import { Hono } from "hono"
import { z } from "zod"
import { requireHumanWorkspaceOwner } from "../auth.ts"
import { readLinkGrantSchemas, validateLinkGrant } from "../link-grant.ts"
import { canonicalJson, createLinkKey, type LinkKey } from "../link-grant-view.ts"
import { queryRecordsForLink } from "../link-query.ts"
import { sharingPreviewEnabled } from "../sharing-preview.ts"
import { readSpace } from "../store.ts"
import { authorizeShareAction, effectiveSharingPolicy } from "../share-policy.ts"
import { readSharingPolicy, ShareLinksStoreError } from "../share-links-store.ts"

/**
 * Run as link: an owner checks what a grant would show a visitor of an HTML
 * Doc, before any link carries it. It takes the path a visitor's queries
 * take, budget included. Behind the sharing preview, for people only.
 */
export const linkGrantsRouter = new Hono()

linkGrantsRouter.onError((error, c) => {
  if (error instanceof ShareLinksStoreError)
    return c.json({ error: "Share links are unavailable", code: error.code }, 503)
  throw error
})

linkGrantsRouter.use("*", async (c, next) => {
  if (!sharingPreviewEnabled()) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const denied = await requireHumanWorkspaceOwner()(c, async () => {})
  if (denied) return denied
  c.header("Cache-Control", "no-store")
  return next()
})

const RunAsLinkSchema = z.object({
  spaceId: z.string().min(1),
  /** The HTML Doc whose permissions the link would run under. */
  path: z.string().min(1),
  collectionId: z.string().min(1),
  grant: LinkGrantSchema,
  query: z.unknown().optional(),
})

// A secret for the life of the process, never stored. Each Space and grant
// gets its own key and budget from it, as each link has its own: ids and
// cursors stay stable while an owner pages through one grant, and a cursor or
// id from one grant or Space means nothing under another.
const runAsLinkSecret = randomBytes(32)
const runAsLinkKeys = new Map<string, LinkKey>()
const RUN_AS_LINK_KEYS_KEPT = 32

function runAsLink(spaceId: string, grant: LinkGrant): { linkId: string; linkKey: LinkKey } {
  const secret = createHmac("sha256", runAsLinkSecret).update(`${spaceId}\0${canonicalJson(grant)}`).digest()
  const id = secret.toString("base64url")
  let key = runAsLinkKeys.get(id)
  if (!key) {
    if (runAsLinkKeys.size >= RUN_AS_LINK_KEYS_KEPT) runAsLinkKeys.clear()
    key = createLinkKey(secret)
    runAsLinkKeys.set(id, key)
  }
  return { linkId: `run-as-link:${id}`, linkKey: key }
}

linkGrantsRouter.post("/query", async (c) => {
  const parsed = RunAsLinkSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400)
  const { spaceId, path, collectionId, grant, query } = parsed.data
  const saved = readSharingPolicy()
  const policy = effectiveSharingPolicy(saved.policy)
  const allowed = authorizeShareAction(c.get("identity"), "create", spaceId, { policy })
  if (!allowed.allowed) return c.json({ error: "This link isn't allowed here", code: allowed.code }, allowed.status)
  if (!policy.liveLinks) return c.json({ error: "Live links aren't allowed here", code: "LIVE_NOT_AVAILABLE" }, 403)
  const space = await readSpace(spaceId)
  if (space.error || !space.data) return c.json({ error: space.error ?? "Space not found", code: "NOT_FOUND" }, 404)
  const issues = validateLinkGrant(grant, await readLinkGrantSchemas(spaceId, grant))
  if (issues.length > 0) {
    return c.json({ error: "This grant doesn't fit the collections it names.", code: "LINK_GRANT_INVALID", issues }, 400)
  }
  const response = await queryRecordsForLink(
    { ...runAsLink(spaceId, grant), spaceId, path, grant },
    collectionId,
    query ?? {},
    { policy },
  )
  if (!sharingPreviewEnabled()) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  if (readSharingPolicy().revision !== saved.revision)
    return c.json({ error: "Sharing settings changed. Try again.", code: "LINK_PREVIEW_CHANGED" }, 503)
  const stillAllowed = authorizeShareAction(c.get("identity"), "create", spaceId, { policy })
  if (!stillAllowed.allowed) return c.json({ error: "This link isn't allowed here", code: stillAllowed.code }, stillAllowed.status)
  return c.json(response.body, response.status, response.headers)
})
