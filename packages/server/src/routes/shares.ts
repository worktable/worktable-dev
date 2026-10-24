import { teamsEnabled } from "../team-database.ts";
import { requireTeamHuman } from "../team-policy.ts";
import { Hono } from "hono"
import { requireHumanWorkspaceOwner } from "../auth.ts"
import { getDocumentSharingConfig } from "../linked-sharing.ts"
import { shareLinksRouter } from "./share-links.ts"
import { sharePolicyRouter } from "./share-policy.ts"

// Sharing for people: a document's links and the owner policy. Links the
// earlier version made in document-shares.json move into the links store at
// boot; nothing makes links there any more.
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
sharesRouter.route("/policy", sharePolicyRouter)
