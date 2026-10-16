import { getTeamAuth } from "../team-auth.ts";
import { requireTeamDatabase, currentTeamWorktable } from "../team-database.ts";
import { resolveWorkspaceOriginForRequest } from "../workspace-origin.ts";
import { Hono } from "hono"
import { z } from "zod"
import { canManageUserSettings } from "../auth.ts"
import { resolveParticipant } from "../participant-store.ts"
import { teamsEnabled } from "../team-database.ts"
import { requireTeamHuman } from "../team-policy.ts"
import {
  PersonalNavigationSchema,
  personalNavigationProblem,
} from "@worktable/types"
import { canReadSpaceFor, personalPreferencesKey } from "../personal-identity.ts"
import {
  PreferencesUnreadableError,
  savePersonalNavigation,
} from "../personal-navigation-store.ts"
import { occupiedSpaceIds } from "../store.ts"
import { wsManager } from "../ws.ts"

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

const SaveNavigationSchema = PersonalNavigationSchema.omit({
  revision: true,
}).extend({
  expectedRevision: PersonalNavigationSchema.shape.revision,
  /** The Spaces the client could show; entries for others are kept. */
  knownSpaces: z.array(z.string().min(1).max(200)).max(5000),
})

// The person's own groups and pins. Reads arrive with the workspace summary.
profileRouter.put("/navigation", async (c) => {
  const person = personalPreferencesKey(c)
  if (!person) return c.json(forbidden(), 403)
  const parsed = SaveNavigationSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) return c.json({ error: "Invalid navigation" }, 400)
  const problem = personalNavigationProblem(parsed.data)
  if (problem) return c.json({ error: problem }, 400)
  const { expectedRevision, knownSpaces, ...next } = parsed.data
  let result
  try {
    result = await savePersonalNavigation(
      person,
      expectedRevision,
      next,
      knownSpaces,
      canReadSpaceFor(c),
      await occupiedSpaceIds()
    )
  } catch (error) {
    if (error instanceof PreferencesUnreadableError) {
      return c.json({ error: error.message, code: error.code }, 503)
    }
    throw error
  }
  if (!result.saved) {
    return c.json(
      {
        error: "Navigation changed since it was read",
        code: "NAVIGATION_CONFLICT",
        navigation: result.current,
      },
      409
    )
  }
  wsManager.sendToPerson(person, {
    type: "navigation_changed",
    data: { revision: result.navigation.revision },
  })
  return c.json({ navigation: result.navigation })
})
