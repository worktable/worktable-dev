import { Hono } from "hono"
import type { WithContentRevision } from "@worktable/types"
import { requireScope } from "../auth.ts"
import { withContentRevisions } from "../document-content-revision.ts"
import {
  listRecentDocuments,
  type RecentDocument,
} from "../recent-documents.ts"
import { teamsEnabled } from "../team-database.ts"
import { listTeamAgents, teamMemberForIdentity } from "../team-policy.ts"
import type { TokenIdentity } from "../token-store.ts"

export const recentRouter = new Hono()

recentRouter.use("*", requireScope("documents:read"))

/**
 * On a team, a member and their own agents. Without Teams every agent belongs
 * to the one person, so nothing narrows the list.
 */
function personalActorIds(identity: TokenIdentity): Set<string> | undefined {
  if (!teamsEnabled()) return undefined
  const member = teamMemberForIdentity(identity)
  if (!member) return undefined
  const ids = new Set([member.actorId])
  for (const agent of listTeamAgents(identity)) {
    if (agent.ownership === "personal" && agent.memberId === member.id) {
      ids.add(agent.actorId)
    }
  }
  return ids
}

// GET /api/recent — newest active documents across Spaces, or in one Space.
// lifetime=temporary lists only temporary documents, soonest to archive first.
// temporaryLimit=N adds those as `temporary` beside the main list.
// scope=mine keeps docs the reader or their agents created or edited.
// folder=F, with spaceId, keeps docs in that folder.
// excerpt=true gives the first doc its opening lines, when an agent made it
// in the last day.
recentRouter.get("/", async (c) => {
  const sort = c.req.query("sort") === "created" ? "created" : "updated"
  const limitRaw = Number(c.req.query("limit"))
  const limit = Number.isInteger(limitRaw)
    ? Math.max(1, Math.min(100, limitRaw))
    : 30
  const temporaryLimitRaw = Number(c.req.query("temporaryLimit"))
  const actorIds =
    c.req.query("scope") === "mine" ? personalActorIds(c.get("identity")) : undefined
  const recent = await listRecentDocuments({
    spaceId: c.req.query("spaceId") || undefined,
    sort,
    includeTemporary: c.req.query("includeTemporary") === "true",
    onlyTemporary: c.req.query("lifetime") === "temporary",
    limit,
    temporaryLimit: Number.isInteger(temporaryLimitRaw)
      ? Math.max(0, Math.min(100, temporaryLimitRaw))
      : 0,
    ...(actorIds ? { actorIds } : {}),
    ...(c.req.query("spaceId") && c.req.query("folder")
      ? { folder: c.req.query("folder")! }
      : {}),
    excerpt: c.req.query("excerpt") === "true",
  })
  // Rows open their documents by content revision.
  const listed = [...recent.items, ...(recent.temporary ?? [])]
  const rows = await withContentRevisions(
    listed,
    (item) => ({ spaceId: item.spaceId, path: item.document.path }),
    (item, revision) => ({
      ...item,
      document: { ...item.document, revision } as WithContentRevision<
        RecentDocument["document"]
      >,
    })
  )
  return c.json({
    ...recent,
    items: rows.slice(0, recent.items.length),
    ...(recent.temporary
      ? { temporary: rows.slice(recent.items.length) }
      : {}),
  })
})
