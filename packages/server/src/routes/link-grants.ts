import { randomBytes } from "node:crypto"
import { LinkGrantSchema } from "@worktable/types"
import { Hono } from "hono"
import { z } from "zod"
import { requireHumanWorkspaceOwner } from "../auth.ts"
import { readLinkGrantSchemas, validateLinkGrant } from "../link-grant.ts"
import { createLinkKey, linkQueryFailure, openLinkReadView, type LinkKey } from "../link-grant-view.ts"
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

// One key for the life of the process and never stored: ids and cursors stay
// stable while an owner pages through results, and no real link shares it.
let runAsLinkKey: LinkKey | null = null

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
  runAsLinkKey ??= createLinkKey(randomBytes(32))
  try {
    const view = await openLinkReadView(spaceId, grant, runAsLinkKey)
    return c.json(await queryRecords(spaceId, collectionId, query ?? {}, { view }))
  } catch (error) {
    const failure = linkQueryFailure(error)
    if (failure) return c.json(failure.body, failure.status)
    throw error
  }
})
