import {
  SHARING_PREVIEW_POLICY_KEYS,
  SharingPolicyInputSchema,
  type SharingPolicy,
  type SharingPolicyResponse,
} from "@worktable/types"
import { Hono, type Context } from "hono"
import { wsManager } from "../ws.ts"
import { canManageUserSettings } from "../auth.ts"
import {
  readSharingPolicy,
  saveSharingPolicy,
  ShareLinksStoreError,
  sharingV2Active,
  type StoredSharingPolicy,
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

function body(stored: StoredSharingPolicy): SharingPolicyResponse {
  return {
    policy: effectiveSharingPolicy(stored.policy),
    canEdit: true,
    revision: stored.revision,
  }
}

/** The revision a save was made from, from `If-Match: "<revision>"`. */
function expectedRevision(c: Context): number | undefined | null {
  const header = c.req.header("If-Match")
  if (header === undefined) return undefined
  const match = /^"(\d{1,15})"$/.exec(header.trim())
  return match ? Number(match[1]) : null
}

sharePolicyRouter.get("/", (c) => c.json(body(readSharingPolicy())))

sharePolicyRouter.put("/", async (c) => {
  const input = SharingPolicyInputSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  const expected = expectedRevision(c)
  if (!input.success || expected === null) {
    return c.json(
      {
        error: input.success ? "Invalid If-Match" : input.error.message,
        code: "VALIDATION_ERROR",
      },
      400
    )
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
  const saved = saveSharingPolicy(
    policy,
    sharerOf(c.get("identity")).id,
    expected
  )
  if (!saved) {
    // Made from an older copy: the newer policy stays, and comes back.
    return c.json(
      {
        error: "The policy changed since it was read",
        code: "POLICY_CHANGED",
        ...body(readSharingPolicy()),
      },
      409
    )
  }
  wsManager.broadcastAll({
    type: "share_policy_changed",
    revision: saved.revision,
  })
  return c.json(body(saved))
})
