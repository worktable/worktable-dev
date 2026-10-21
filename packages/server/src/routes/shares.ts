import { teamsEnabled } from "../team-database.ts";
import { requireTeamHuman, assertSpaceAccess } from "../team-policy.ts";
import { Hono, type Context } from "hono"
import { requireHumanWorkspaceOwner } from "../auth.ts"
import { getDocumentSharingConfig } from "../linked-sharing.ts"
import {
  createDocumentShareIfEligible,
  getDocumentShare,
  stopDocumentShare,
  type DocumentShare,
  type ShareArtifact,
} from "../share-store.ts"
import {
  readSharedArtifact,
  ShareArtifactInput,
  sharedArtifactIdentityIsCurrent,
} from "../shared-artifact.ts"
import { shareLinksRouter } from "./share-links.ts"

export const sharesRouter = new Hono()

sharesRouter.use("*", async (c, next) => {
  if (!getDocumentSharingConfig()) {
    return c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
  }
  if (teamsEnabled()) requireTeamHuman(c.get("identity"));
  else {
    const denied = await requireHumanWorkspaceOwner()(c, async () => {});
    if (denied) return denied;
  }
  c.header("Cache-Control", "no-store")
  return next()
})

sharesRouter.route("/links", shareLinksRouter)

function publicShare(
  share: DocumentShare,
  config: NonNullable<ReturnType<typeof getDocumentSharingConfig>>
) {
  return {
    url: `${config.shareOrigin}/s/${encodeURIComponent(config.workspaceId)}/${share.token}`,
    createdAt: share.createdAt,
  }
}

async function parseBody(c: Context) {
  return ShareArtifactInput.safeParse(await c.req.json().catch(() => null))
}

sharesRouter.get("/", async (c) => {
  const parsed = ShareArtifactInput.safeParse({
    kind: c.req.query("kind"),
    spaceId: c.req.query("spaceId"),
    artifactKey: c.req.query("artifactKey"),
  })
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }

  if (teamsEnabled()) assertSpaceAccess(parsed.data.spaceId, "manage");
  const share = await getDocumentShare(parsed.data)
  if (!share) return c.json({ share: null })
  if (!(await sharedArtifactIdentityIsCurrent(parsed.data))) {
    await stopDocumentShare(parsed.data)
    return c.json({ share: null })
  }
  return c.json({
    share: publicShare(share, getDocumentSharingConfig()!),
  })
})

sharesRouter.post("/", async (c) => {
  const parsed = await parseBody(c)
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }
  if (teamsEnabled()) assertSpaceAccess(parsed.data.spaceId, "manage");
  const share = await createDocumentShareIfEligible(
    parsed.data,
    async () => (await readSharedArtifact(parsed.data)) !== null
  )
  if (!share) {
    return c.json({ error: "Artifact not found", code: "NOT_FOUND" }, 404)
  }
  return c.json(
    { share: publicShare(share, getDocumentSharingConfig()!) },
    201
  )
})

sharesRouter.delete("/", async (c) => {
  const parsed = await parseBody(c)
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }
  if (teamsEnabled()) assertSpaceAccess(parsed.data.spaceId, "manage");
  await stopDocumentShare(parsed.data as ShareArtifact)
  return c.json({ ok: true })
})
