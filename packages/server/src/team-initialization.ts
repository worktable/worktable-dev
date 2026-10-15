import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { isHosted } from "./hosted.ts"
import { getTeamAuth } from "./team-auth.ts"
import { TeamAccessError } from "./team-policy.ts"
import { ENV } from "@worktable/hosted-contract"
import { getAppDir } from "./app-storage.ts"
import {
  currentTeamWorktable,
  currentWorktableId,
  openTeamDatabase,
  teamDatabasePath,
  TeamStateError,
  requireTeamDatabase,
  teamSecret,
} from "./team-database.ts"
import {
  ensureWorkspaceManifest,
  workspaceCacheKey,
  writeWorkspaceManifest,
} from "./workspace.ts"

const intentPath = () => `${teamDatabasePath()}.initialization.json`

/** Written only after the configured initial owner has supplied verified identity. */
export function beginTeamInitialization(
  mode: "local" | "cloud",
  userId: string
): void {
  const value = {
    version: 1,
    worktableId: currentWorktableId(),
    rootKey: workspaceCacheKey(),
    mode,
    userId,
    ...(mode === "cloud"
      ? {
          owner: process.env[ENV.OWNER_SUBJECT],
          issuer: process.env[ENV.AUTH_SERVER_URL],
        }
      : {}),
    authEpoch: createHash("sha256")
      .update(teamSecret(requireTeamDatabase()))
      .digest("hex"),
  }
  const temporary = `${intentPath()}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, intentPath())
}

export function finishTeamInitialization(): void {
  rmSync(intentPath(), { force: true })
}

/** Recover a proven incomplete activation; never turn lost established team state into solo mode. */
export function recoverTeamInitialization(): void {
  if (!existsSync(intentPath())) return
  const info = lstatSync(intentPath())
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
    throw new TeamStateError("Team initialization state is invalid")
  const intent = JSON.parse(readFileSync(intentPath(), "utf8"))
  if (
    intent.version !== 1 ||
    intent.worktableId !== currentWorktableId() ||
    intent.rootKey !== workspaceCacheKey() ||
    typeof intent.userId !== "string" ||
    !intent.userId ||
    !["local", "cloud"].includes(intent.mode) ||
    (intent.mode === "cloud"
      ? !isHosted() ||
        !intent.owner ||
        intent.owner !== process.env[ENV.OWNER_SUBJECT] ||
        !intent.issuer ||
        intent.issuer !== process.env[ENV.AUTH_SERVER_URL]
      : isHosted())
  )
    throw new TeamStateError("Team initialization identity changed")
  const db = openTeamDatabase()
  if (!db) throw new TeamStateError()
  // The marker is written inside the activation transaction. IMMEDIATE also
  // excludes that transaction in another process while recovery touches files.
  db.transaction(() => {
    if (
      db
        .query("SELECT id FROM wt_worktables WHERE root_key = ?")
        .get(workspaceCacheKey())
    ) {
      currentTeamWorktable()
      finishTeamInitialization()
      return
    }
    if (!db.query("SELECT id FROM user WHERE id = ?").get(intent.userId))
      throw new TeamStateError("Team initialization account is unavailable")
    if (
      intent.authEpoch !==
      createHash("sha256").update(teamSecret(db)).digest("hex")
    )
      throw new TeamStateError(
        "Team initialization authentication state changed"
      )
    if (
      [
        "wt_worktables",
        "wt_enrollments",
        "wt_actors",
        "wt_agents",
        "wt_space_policy",
        "wt_space_grants",
      ].some((table) => db.query(`SELECT 1 FROM ${table} LIMIT 1`).get())
    )
      throw new TeamStateError()
    const marker = join(
      getAppDir(),
      "teams",
      "worktables",
      `${workspaceCacheKey()}.json`
    )
    if (existsSync(marker)) {
      const value = JSON.parse(readFileSync(marker, "utf8"))
      if (value.version !== 1 || value.worktableId !== intent.worktableId)
        throw new TeamStateError()
      rmSync(marker)
    }
    const manifest = { ...ensureWorkspaceManifest() }
    delete manifest.teamAccessRequired
    writeWorkspaceManifest(manifest)
    // Keep the intent through retry: an orphaned organization may still exist.
  }).immediate()
}

/** Retry adopts only the authenticated initial owner's otherwise unused organization. */
export async function getInitialTeamOrganization(
  origin: string,
  userId: string,
  options: {
    /** Local activation: an unfinished attempt with another account is discarded. */
    replaceUnfinished?: boolean
  } = {}
): Promise<{ organizationId: string; ownerMemberId: string }> {
  const auth = await getTeamAuth(origin)
  const db = requireTeamDatabase()
  const slug = `worktable-${currentWorktableId()}`
  let existing = db
    .query<
      { id: string },
      [string]
    >("SELECT id FROM organization WHERE slug = ?")
    .get(slug)
  if (
    existing &&
    !db
      .query("SELECT id FROM member WHERE organizationId = ? LIMIT 1")
      .get(existing.id)
  ) {
    if (
      db
        .query("SELECT id FROM invitation WHERE organizationId = ? LIMIT 1")
        .get(existing.id)
    )
      throw new TeamAccessError(
        "Team initialization has unexpected invitations"
      )
    db.query("DELETE FROM organization WHERE id = ?").run(existing.id)
    existing = null
  }
  if (existing) {
    const members = db
      .query<
        { id: string; userId: string; role: string },
        [string]
      >("SELECT id, userId, role FROM member WHERE organizationId = ?")
      .all(existing.id)
    const matches =
      members.length === 1 &&
      members[0]!.userId === userId &&
      members[0]!.role === "owner"
    const unfinished =
      !db.query("SELECT id FROM wt_worktables LIMIT 1").get() &&
      !db
        .query("SELECT id FROM invitation WHERE organizationId = ? LIMIT 1")
        .get(existing.id)
    if (!matches && options.replaceUnfinished && unfinished) {
      db.transaction(() => {
        db.query("DELETE FROM member WHERE organizationId = ?").run(existing!.id)
        db.query("DELETE FROM organization WHERE id = ?").run(existing!.id)
      })()
      existing = null
    } else if (!matches) {
      throw new TeamAccessError(
        "Team initialization does not match its initial owner"
      )
    } else {
      return { organizationId: existing.id, ownerMemberId: members[0]!.id }
    }
  }
  const org = await auth.api.createOrganization({
    body: { userId, name: ensureWorkspaceManifest().name, slug },
  })
  return { organizationId: org.id, ownerMemberId: org.members[0]!.id }
}
