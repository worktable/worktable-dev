import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { ensureAppDir, getAppDir } from "./app-storage.ts"
import {
  getWorkspaceManifestPath,
  isWorkspaceManifest,
  workspaceCacheKey,
  ensureWorkspaceManifest,
  writeWorkspaceManifest,
} from "./workspace.ts"

export class TeamStateError extends Error {
  readonly code = "TEAM_STATE_UNAVAILABLE"
  constructor(message = "Team authorization state is unavailable") {
    super(message)
    this.name = "TeamStateError"
  }
}

export interface TeamWorktable {
  id: string
  organizationId: string
  rootKey: string
  policyRevision: number
}

interface WorktableRow {
  id: string
  organization_id: string
  root_key: string
  policy_revision: number
}

const databases = new Map<string, { db: Database; dev: number; ino: number }>()
const SCHEMA_VERSION = 2

export function teamDatabasePath(): string {
  return join(
    getAppDir(),
    "teams",
    "databases",
    workspaceCacheKey(),
    "auth.sqlite"
  )
}

export function currentWorktableId(): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(getWorkspaceManifestPath(), "utf8")
    )
    if (isWorkspaceManifest(manifest)) return manifest.id
  } catch {
    // Invalid content identity cannot be used to look up authorization.
  }
  throw new TeamStateError("The selected Worktable has no valid identity")
}

function markerPath(): string {
  return join(getAppDir(), "teams", "worktables", `${workspaceCacheKey()}.json`)
}

/** The marker survives database loss, so losing auth state cannot restore solo trust. */
export function writeTeamMarker(worktableId: string): void {
  const dir = join(ensureAppDir(), "teams", "worktables")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = markerPath()
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`
  writeFileSync(temporary, JSON.stringify({ version: 1, worktableId }), {
    mode: 0o600,
    flag: "wx",
  })
  renameSync(temporary, path)
  const manifest = ensureWorkspaceManifest()
  if (!manifest.teamAccessRequired)
    writeWorkspaceManifest({ ...manifest, teamAccessRequired: true })
}

function readMarker(): string | null {
  if (!existsSync(markerPath())) return null
  try {
    const value: unknown = JSON.parse(readFileSync(markerPath(), "utf8"))
    if (
      value &&
      typeof value === "object" &&
      "version" in value &&
      value.version === 1 &&
      "worktableId" in value &&
      typeof value.worktableId === "string"
    )
      return value.worktableId
  } catch {
    // A broken marker is not evidence of solo mode.
  }
  throw new TeamStateError()
}

export function openTeamDatabase(create = false): Database | null {
  const path = teamDatabasePath()
  const cached = databases.get(path)
  if (cached) {
    const file = existsSync(path) ? statSync(path) : null
    if (file && file.dev === cached.dev && file.ino === cached.ino)
      return cached.db
    cached.db.close()
    databases.delete(path)
    throw new TeamStateError(
      "Team state changed while the server was running; restart after recovery"
    )
  }
  if (!existsSync(path) && !create) return null
  if (create) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const db = new Database(path, { create, strict: true })
    chmodSync(path, 0o600)
    db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;"
    )
    const version =
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version ?? 0
    if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) {
      db.close()
      throw new TeamStateError("Team state uses an unsupported version")
    }
    db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wt_worktables (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL UNIQUE,
        root_key TEXT NOT NULL UNIQUE, policy_revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS wt_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wt_identity_bindings (
        worktable_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
        user_id TEXT NOT NULL, company_id TEXT, PRIMARY KEY (worktable_id, issuer, subject)
      );
      CREATE TABLE IF NOT EXISTS wt_actors (
        id TEXT NOT NULL, worktable_id TEXT NOT NULL, user_id TEXT NOT NULL,
        name TEXT NOT NULL, participant_key TEXT NOT NULL,
        PRIMARY KEY (worktable_id, id), UNIQUE (worktable_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS wt_enrollments (
        id TEXT PRIMARY KEY, worktable_id TEXT NOT NULL, user_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wt_space_policy (
        worktable_id TEXT NOT NULL, space_id TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('shared', 'restricted')),
        PRIMARY KEY (worktable_id, space_id)
      );
      CREATE TABLE IF NOT EXISTS wt_space_grants (
        worktable_id TEXT NOT NULL, space_id TEXT NOT NULL,
        subject_type TEXT NOT NULL CHECK (subject_type IN ('member', 'agent')),
        subject_id TEXT NOT NULL, access TEXT NOT NULL CHECK (access IN ('read', 'edit', 'manage')),
        PRIMARY KEY (worktable_id, space_id, subject_type, subject_id)
      );
      CREATE TABLE IF NOT EXISTS wt_agents (
        id TEXT PRIMARY KEY, worktable_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        participant_key TEXT NOT NULL,
        name TEXT NOT NULL, platform TEXT NOT NULL,
        ownership TEXT NOT NULL CHECK (ownership IN ('personal', 'team')),
        member_id TEXT, space_ids TEXT, scope_ceiling TEXT, icon TEXT, mode TEXT NOT NULL DEFAULT 'on-demand', active INTEGER NOT NULL DEFAULT 1,
        UNIQUE (worktable_id, actor_id)
      );
      CREATE TABLE IF NOT EXISTS wt_agent_credentials (
        credential_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
        sponsor_member_id TEXT, minimum_issued_at INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS wt_operators (
        worktable_id TEXT NOT NULL, user_id TEXT NOT NULL,
        PRIMARY KEY (worktable_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS wt_pairings (
        session_id TEXT PRIMARY KEY, worktable_id TEXT NOT NULL, agent_id TEXT NOT NULL, member_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wt_pairing_authorizations (
        session_id TEXT PRIMARY KEY, worktable_id TEXT NOT NULL, member_id TEXT NOT NULL,
        name TEXT NOT NULL, platform TEXT NOT NULL, agent_id TEXT, mode TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wt_cloud_sessions (
        worktable_id TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
        PRIMARY KEY (worktable_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS wt_invitation_recipients (
        worktable_id TEXT NOT NULL, invitation_id TEXT NOT NULL, invited_email TEXT NOT NULL, recipient_user_id TEXT NOT NULL, accepted_at INTEGER,
        PRIMARY KEY (worktable_id, invitation_id)
      );
      CREATE INDEX IF NOT EXISTS wt_enrollments_user ON wt_enrollments(worktable_id, user_id, active);
    `)
    const agentColumns = new Set(db.query<{name: string}, []>("PRAGMA table_info(wt_agents)").all().map(column => column.name))
    if (!agentColumns.has("mode")) db.exec("ALTER TABLE wt_agents ADD COLUMN mode TEXT NOT NULL DEFAULT 'on-demand'")
    const credentialColumns = new Set(db.query<{name: string}, []>("PRAGMA table_info(wt_agent_credentials)").all().map(column => column.name))
    if (!credentialColumns.has("minimum_issued_at")) db.exec("ALTER TABLE wt_agent_credentials ADD COLUMN minimum_issued_at INTEGER NOT NULL DEFAULT 0")
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }).immediate()
    const file = statSync(path)
    databases.set(path, { db, dev: file.dev, ino: file.ino })
    return db
  } catch (error) {
    if (error instanceof TeamStateError) throw error
    throw new TeamStateError()
  }
}

export function requireTeamDatabase(): Database {
  const db = openTeamDatabase()
  if (!db) throw new TeamStateError()
  return db
}

export function teamSecret(db: Database): string {
  const existing = db
    .query<
      { value: string },
      [string]
    >("SELECT value FROM wt_config WHERE key = ?")
    .get("auth-secret")
  if (existing) return existing.value
  db.query(
    "INSERT OR IGNORE INTO wt_config(key, value) VALUES ('auth-secret', ?)"
  ).run(randomBytes(32).toString("base64url"))
  return db
    .query<
      { value: string },
      []
    >("SELECT value FROM wt_config WHERE key = 'auth-secret'")
    .get()!.value
}

export function currentTeamWorktable(): TeamWorktable | null {
  const marker = readMarker()
  let required = false
  if (existsSync(getWorkspaceManifestPath())) {
    try {
      const manifest = JSON.parse(
        readFileSync(getWorkspaceManifestPath(), "utf8")
      )
      required = manifest.teamAccessRequired === true
    } catch {
      if (marker) throw new TeamStateError()
    }
  }
  const db = openTeamDatabase()
  if (!db) {
    if (marker || required) throw new TeamStateError()
    return null
  }
  const row = db
    .query<
      WorktableRow,
      [string]
    >("SELECT * FROM wt_worktables WHERE root_key = ?")
    .get(workspaceCacheKey())
  if (!row) {
    if (marker || required) throw new TeamStateError()
    return null
  }
  if (row.id !== currentWorktableId() || (marker && marker !== row.id))
    throw new TeamStateError()
  return {
    id: row.id,
    organizationId: row.organization_id,
    rootKey: row.root_key,
    policyRevision: row.policy_revision,
  }
}

export function teamsEnabled(): boolean {
  return currentTeamWorktable() !== null
}

export function advanceTeamPolicy(worktableId: string): void {
  requireTeamDatabase()
    .query(
      "UPDATE wt_worktables SET policy_revision = policy_revision + 1 WHERE id = ?"
    )
    .run(worktableId)
}

export function closeTeamDatabases(): void {
  for (const entry of databases.values()) entry.db.close()
  databases.clear()
}
