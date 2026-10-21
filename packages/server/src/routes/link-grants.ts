import { createHmac, randomBytes } from "node:crypto"
import { LinkGrantSchema, type LinkGrant } from "@worktable/types"
import { Hono } from "hono"
import { z } from "zod"
import { requireHumanWorkspaceOwner } from "../auth.ts"
import { readLinkGrantSchemas, validateLinkGrant } from "../link-grant.ts"
import { canonicalJson, createLinkKey, linkQueryFailure, openLinkReadView, type LinkKey } from "../link-grant-view.ts"
import { queryRecords } from "../record-store.ts"
import { sharingPreviewEnabled } from "../sharing-preview.ts"
import { readSpace } from "../store.ts"

/**
 * Run as link: an owner checks what a grant would show a visitor, before any
 * link carries it. Behind the sharing preview, for people only.
 */
export const linkGrantsRouter = new Hono()

linkGrantsRouter.use("*", async (c, next) => {
  if (!sharingPreviewEnabled()) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  const denied = await requireHumanWorkspaceOwner()(c, async () => {})
  if (denied) return denied
  c.header("Cache-Control", "no-store")
  return next()
})

const RunAsLinkSchema = z.object({
  spaceId: z.string().min(1),
  collectionId: z.string().min(1),
  grant: LinkGrantSchema,
  query: z.unknown().optional(),
})

// A secret for the life of the process, never stored. Each Space and grant
// gets its own key from it, as each link has its own: ids and cursors stay
// stable while an owner pages through one grant, and a cursor or id from one
// grant or Space means nothing under another.
const runAsLinkSecret = randomBytes(32)
const runAsLinkKeys = new Map<string, LinkKey>()
const RUN_AS_LINK_KEYS_KEPT = 32

function runAsLinkKey(spaceId: string, grant: LinkGrant): LinkKey {
  const secret = createHmac("sha256", runAsLinkSecret).update(`${spaceId}\0${canonicalJson(grant)}`).digest()
  const id = secret.toString("base64url")
  let key = runAsLinkKeys.get(id)
  if (!key) {
    if (runAsLinkKeys.size >= RUN_AS_LINK_KEYS_KEPT) runAsLinkKeys.clear()
    key = createLinkKey(secret)
    runAsLinkKeys.set(id, key)
  }
  return key
}

linkGrantsRouter.post("/query", async (c) => {
  const parsed = RunAsLinkSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400)
  const { spaceId, collectionId, grant, query } = parsed.data
  const space = await readSpace(spaceId)
  if (space.error || !space.data) return c.json({ error: space.error ?? "Space not found", code: "NOT_FOUND" }, 404)
  const issues = validateLinkGrant(grant, await readLinkGrantSchemas(spaceId, grant))
  if (issues.length > 0) {
    return c.json({ error: "This grant doesn't fit the collections it names.", code: "LINK_GRANT_INVALID", issues }, 400)
  }
  try {
    const view = await openLinkReadView(spaceId, grant, runAsLinkKey(spaceId, grant))
    return c.json(await queryRecords(spaceId, collectionId, query ?? {}, { view }))
  } catch (error) {
    const failure = linkQueryFailure(error)
    if (failure) return c.json(failure.body, failure.status)
    throw error
  }
})
