import { Database } from "bun:sqlite"
import { createHash, randomBytes } from "node:crypto"
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { getAppDir } from "./app-storage.ts"
import {
  readBoundedRegularFileBytes,
  BoundedFileReadError,
} from "./bounded-file.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { clearTeamAuthInstances } from "./team-auth.ts"
import {
  closeTeamDatabases,
  currentTeamWorktable,
  currentWorktableId,
  requireTeamDatabase,
  teamDatabasePath,
  writeTeamMarker,
} from "./team-database.ts"
import { getWorkspaceRoot, workspaceCacheKey } from "./workspace.ts"
import { listTokens, revokeToken } from "./token-store.ts"

const MAX_TEAM_STATE_BYTES = 64 * 1024 * 1024
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")
const file = z.object({
  size: z.number().int().nonnegative().max(MAX_TEAM_STATE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export const TeamBackupStateSchema = z.object({
  version: z.literal(1),
  worktableId: z.string().min(1),
  authentication: file,
  participants: file.optional(),
})
export type TeamBackupState = z.infer<typeof TeamBackupStateSchema>

/** Prevent account enrollment/removal from straddling the operator snapshot. */
export function withTeamBackupBarrier<T>(
  capture: () => Promise<T>
): Promise<T> {
  return withCrossProcessLock(
    `${teamDatabasePath()}.activation.lock`,
    { label: "Team snapshot", timeoutMs: 30000 },
    () =>
      withCrossProcessLock(
        `${teamDatabasePath()}.members.lock`,
        { label: "Team snapshot", timeoutMs: 30000 },
        capture
      )
  )
}

function hasTable(db: Database, name: string): boolean {
  return Boolean(
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name)
  )
}

/** Retire every bearer capability: sessions, agent credentials, pairings,
 * invitation links and one-time verification tokens. People keep accounts. */
function invalidateConnections(db: Database): void {
  db.transaction(() => {
    db.exec(
      "DELETE FROM session; DELETE FROM wt_cloud_sessions; DELETE FROM wt_pairings; UPDATE wt_agent_credentials SET active = 0;"
    )
    // A restored disconnect must not let a later sign-in reconnect it.
    if (
      db
        .query(
          "SELECT 1 FROM pragma_table_info('wt_agent_credentials') WHERE name = 'disconnected_at'"
        )
        .get()
    )
      db.exec("UPDATE wt_agent_credentials SET disconnected_at = NULL")
    if (hasTable(db, "wt_pairing_authorizations"))
      db.exec("DELETE FROM wt_pairing_authorizations")
    // An invitation link authorizes joining, so a restored one must not
    // revive a link that was cancelled after the backup.
    if (hasTable(db, "invitation"))
      db.exec("UPDATE invitation SET status = 'canceled' WHERE status = 'pending'")
    if (hasTable(db, "verification")) db.exec("DELETE FROM verification")
    if (hasTable(db, "rateLimit")) db.exec('DELETE FROM "rateLimit"')
    db.query("UPDATE wt_config SET value = ? WHERE key = 'auth-secret'").run(
      randomBytes(32).toString("base64url")
    )
  })()
}

function validateTeamDatabase(db: Database, worktableId: string): void {
  if (
    ![1, 2, 3].includes(
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version ?? 0
    )
  )
    throw new Error("Unsupported team backup version")
  if (
    db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
      ?.integrity_check !== "ok"
  )
    throw new Error("Team backup integrity failed")
  const worktables = db
    .query<
      { id: string; organization_id: string },
      []
    >("SELECT id, organization_id FROM wt_worktables")
    .all()
  if (worktables.length !== 1 || worktables[0]!.id !== worktableId)
    throw new Error("Team backup belongs to another Worktable")
  const owners = db
    .query<
      { count: number },
      [string]
    >("SELECT COUNT(*) AS count FROM member m JOIN wt_enrollments e ON e.id = m.id WHERE m.organizationId = ? AND m.role = 'owner' AND e.active = 1")
    .get(worktables[0]!.organization_id)
  if (!owners?.count) throw new Error("Team backup has no active owner")
}

/** App-private operator state stays outside the portable workspace tree. */
export async function captureTeamBackupState(
  snapshotRoot: string
): Promise<TeamBackupState | undefined> {
  const worktable = currentTeamWorktable()
  if (!worktable) return undefined
  const directory = join(snapshotRoot, "team")
  await mkdir(directory, { mode: 0o700 })
  const path = join(directory, "auth.sqlite")
  // VACUUM INTO produces a consistent standalone database, including committed
  // WAL pages. It never copies an in-progress journal or a live database file.
  requireTeamDatabase().query("VACUUM INTO ?").run(path)
  await chmod(path, 0o600)
  const snapshot = new Database(path, { strict: true })
  try {
    validateTeamDatabase(snapshot, worktable.id)
    snapshot.exec("PRAGMA journal_mode = DELETE;")
    invalidateConnections(snapshot)
  } finally {
    snapshot.close()
  }
  const bytes = await readBoundedRegularFileBytes(path, MAX_TEAM_STATE_BYTES)
  const result: TeamBackupState = {
    version: 1,
    worktableId: worktable.id,
    authentication: {
      size: Buffer.byteLength(bytes),
      sha256: sha(Buffer.from(bytes)),
    },
  }
  const participantsPath = join(
    getAppDir(),
    "participants",
    `${workspaceCacheKey()}.json`
  )
  try {
    const participants = await readBoundedRegularFileBytes(
      participantsPath,
      MAX_TEAM_STATE_BYTES
    )
    await writeFile(join(directory, "participants.json"), participants, {
      mode: 0o600,
      flag: "wx",
    })
    result.participants = {
      size: Buffer.byteLength(participants),
      sha256: sha(Buffer.from(participants)),
    }
  } catch (error) {
    if (!(error instanceof BoundedFileReadError && error.reason === "missing"))
      throw error
  }
  return result
}

export async function inspectTeamBackupState(
  snapshotRoot: string,
  state: TeamBackupState
): Promise<void> {
  TeamBackupStateSchema.parse(state)
  const path = join(snapshotRoot, "team", "auth.sqlite")
  const bytes = Buffer.from(
    await readBoundedRegularFileBytes(path, MAX_TEAM_STATE_BYTES)
  )
  if (
    bytes.length !== state.authentication.size ||
    sha(bytes) !== state.authentication.sha256
  )
    throw new Error("Team backup authentication state changed")
  const db = new Database(path, { readonly: true, strict: true })
  try {
    validateTeamDatabase(db, state.worktableId)
  } finally {
    db.close()
  }
  if (state.participants) {
    const bytes = Buffer.from(
      await readBoundedRegularFileBytes(
        join(snapshotRoot, "team", "participants.json"),
        MAX_TEAM_STATE_BYTES
      )
    )
    if (
      bytes.length !== state.participants.size ||
      sha(bytes) !== state.participants.sha256
    )
      throw new Error("Team backup participant state changed")
  }
}

/** Operator restore renews authority at the destination instead of restoring live credentials. */
export async function restoreTeamBackupState(
  snapshotRoot: string,
  state: TeamBackupState
): Promise<void> {
  await inspectTeamBackupState(snapshotRoot, state)
  if (state.worktableId !== currentWorktableId())
    throw new Error("Team backup does not match the restored Worktable")
  const target = teamDatabasePath()
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.restore-${randomBytes(8).toString("hex")}`
  try {
    const source = Buffer.from(
      await readBoundedRegularFileBytes(
        join(snapshotRoot, "team", "auth.sqlite"),
        MAX_TEAM_STATE_BYTES
      )
    )
    await writeFile(temporary, source, { mode: 0o600, flag: "wx" })
    const restored = new Database(temporary, { strict: true })
    try {
      invalidateConnections(restored)
      restored
        .query("UPDATE wt_worktables SET root_key = ? WHERE id = ?")
        .run(workspaceCacheKey(), state.worktableId)
      restored
        .query(
          "UPDATE wt_worktables SET policy_revision = policy_revision + 1 WHERE id = ?"
        )
        .run(state.worktableId)
    } finally {
      restored.close()
    }
    clearTeamAuthInstances()
    closeTeamDatabases()
    await rm(`${target}-wal`, { force: true })
    await rm(`${target}-shm`, { force: true })
    await rename(temporary, target)
    const participantsTarget = join(
      getAppDir(),
      "participants",
      `${workspaceCacheKey()}.json`
    )
    if (!state.participants) await rm(participantsTarget, { force: true })
    if (state.participants) {
      await mkdir(dirname(participantsTarget), { recursive: true, mode: 0o700 })
      // Publish whole: a reader must never see a partially written binding file.
      const staged = `${participantsTarget}.restore-${randomBytes(8).toString("hex")}`
      try {
        await writeFile(
          staged,
          await readBoundedRegularFileBytes(
            join(snapshotRoot, "team", "participants.json"),
            MAX_TEAM_STATE_BYTES
          ),
          { mode: 0o600, flag: "wx" }
        )
        await rename(staged, participantsTarget)
      } finally {
        await rm(staged, { force: true })
      }
    }
    writeTeamMarker(state.worktableId)
    for (const token of await listTokens())
      if (!token.revokedAt && token.workspace === getWorkspaceRoot())
        await revokeToken(token.id)
  } finally {
    await rm(temporary, { force: true })
  }
}
