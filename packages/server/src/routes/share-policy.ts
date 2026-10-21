import {
  SHARING_PREVIEW_POLICY_KEYS,
  SharingPolicyInputSchema,
  type SharingPolicy,
  type SharingPolicyResponse,
} from "@worktable/types"
import { Hono, type Context } from "hono"
import { canManageUserSettings } from "../auth.ts"
import {
  readSharingPolicy,
  saveSharingPolicy,
  ShareLinksStoreError,
  sharingV2Active,
} from "../share-links-store.ts"
import {
  effectiveSharingPolicy,
  sharerOf,
  usesPreviewPolicy,
} from "../share-policy.ts"
import { sharingPreviewEnabled } from "../sharing-preview.ts"

// The owner policy for share links. Mounted inside the shares router, which
// admits only people; this router admits only owners: in Teams the Worktable
// owner, solo the person who manages its settings. Agents never reach it.

export const sharePolicyRouter = new Hono()

sharePolicyRouter.use("*", async (c, next) => {
  if (!sharingV2Active()) {
    return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  }
  if (!canManageUserSettings(c)) {
    return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403)
  }
  return next()
})

sharePolicyRouter.onError((error, c) => {
  // A store from a later version stays closed to this one.
  if (error instanceof ShareLinksStoreError) {
    return c.json(
      { error: "Share links are unavailable", code: error.code },
      503
    )
  }
  throw error
})

function respond(c: Context, policy: SharingPolicy) {
  const body: SharingPolicyResponse = {
    policy: effectiveSharingPolicy(policy),
    canEdit: true,
  }
  return c.json(body)
}

sharePolicyRouter.get("/", (c) => respond(c, readSharingPolicy().policy))

sharePolicyRouter.put("/", async (c) => {
  const input = SharingPolicyInputSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!input.success) {
    return c.json({ error: input.error.message, code: "VALIDATION_ERROR" }, 400)
  }
  let policy: SharingPolicy = input.data
  if (!sharingPreviewEnabled()) {
    if (usesPreviewPolicy(policy)) {
      return c.json(
        {
          error: "That setting needs the sharing preview",
          code: "PREVIEW_POLICY_NOT_AVAILABLE",
        },
        400
      )
    }
    // Settings saved while the preview was on keep their values for when it
    // is on again; until then they act as their defaults.
    const saved = readSharingPolicy().policy
    policy = { ...policy }
    for (const key of SHARING_PREVIEW_POLICY_KEYS) {
      Object.assign(policy, { [key]: saved[key] })
    }
  }
  return respond(
    c,
    saveSharingPolicy(policy, sharerOf(c.get("identity")).id).policy
  )
})
