import { getTeamAuth } from "../team-auth.ts";
import { requireTeamDatabase, currentTeamWorktable } from "../team-database.ts";
import { resolveWorkspaceOriginForRequest } from "../workspace-origin.ts";
import { Hono } from "hono"
import { canManageUserSettings } from "../auth.ts"
import { resolveParticipant } from "../participant-store.ts"
import { teamsEnabled } from "../team-database.ts"
import { requireTeamHuman } from "../team-policy.ts"

export const profileRouter = new Hono()

const MAX_NAME_LENGTH = 100

function forbidden() {
  return { error: "Forbidden", required: "owner" }
}

profileRouter.get("/", async (c) => {
  if (teamsEnabled()) requireTeamHuman(c.get("identity"))
  else if (!canManageUserSettings(c)) return c.json(forbidden(), 403)
  const identity = c.get("identity");
  const { participant } = await resolveParticipant(identity, teamsEnabled() ? { initialName: identity.principal.displayName } : {})
  return c.json({ id: participant.id, name: participant.name })
})

profileRouter.put("/", async (c) => {
  if (teamsEnabled()) requireTeamHuman(c.get("identity"))
  else if (!canManageUserSettings(c)) return c.json(forbidden(), 403)
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown
  } | null
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!name) return c.json({ error: "name must not be empty" }, 400)
  if (name.length > MAX_NAME_LENGTH) {
    return c.json(
      { error: `name must be at most ${MAX_NAME_LENGTH} characters` },
      400
    )
  }
  if (teamsEnabled()) {
    const member = requireTeamHuman(c.get("identity"));
    const auth = await getTeamAuth(resolveWorkspaceOriginForRequest(c.req.raw).origin);
    const context = await auth.$context;
    await context.internalAdapter.updateUser(member.userId, { name });
    requireTeamDatabase().query("UPDATE wt_actors SET name = ? WHERE worktable_id = ? AND user_id = ?").run(name, currentTeamWorktable()!.id, member.userId);
  }
  const { participant } = await resolveParticipant(c.get("identity"), {
    name,
  })
  return c.json({ id: participant.id, name: participant.name })
})
