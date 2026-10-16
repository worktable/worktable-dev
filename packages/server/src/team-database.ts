import { Database } from "bun:sqlite"
import { AsyncLocalStorage } from "node:async_hooks"
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
  getWorkspaceRoot,
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
const SCHEMA_VERSION = 3

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
  invalidateTeamState()
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
  // Each request's state check (resolveTeamBase) verifies this file's
  // identity, so a replaced database is caught there without a stat here.
  if (cached) return cached.db
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
    if (version !== 0 && version !== 1 && version !== 2 && version !== SCHEMA_VERSION) {
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
        worktable_threads TEXT NOT NULL DEFAULT 'none' CHECK (worktable_threads IN ('none', 'read', 'edit')),
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
    if (!agentColumns.has("worktable_threads")) db.exec("ALTER TABLE wt_agents ADD COLUMN worktable_threads TEXT NOT NULL DEFAULT 'none' CHECK (worktable_threads IN ('none', 'read', 'edit'))")
    const credentialColumns = new Set(db.query<{name: string}, []>("PRAGMA table_info(wt_agent_credentials)").all().map(column => column.name))
    if (!credentialColumns.has("minimum_issued_at")) db.exec("ALTER TABLE wt_agent_credentials ADD COLUMN minimum_issued_at INTEGER NOT NULL DEFAULT 0")
    // Every change to who may access what advances policy_revision, whichever
    // connection or process makes it, so a revision read is a complete check.
    for (const table of [
      "wt_space_policy",
      "wt_space_grants",
      "wt_enrollments",
      "wt_agents",
      "wt_agent_credentials",
      "wt_operators",
      "wt_identity_bindings",
    ])
      for (const event of ["INSERT", "UPDATE", "DELETE"])
        db.exec(
          `CREATE TRIGGER IF NOT EXISTS wt_revision_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE wt_worktables SET policy_revision = policy_revision + 1; END`
        )
    ensureAccountRevisionTriggers(db)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }).immediate()
    const file = statSync(path)
    databases.set(path, { db, dev: file.dev, ino: file.ino })
    invalidateTeamState()
    return db
  } catch (error) {
    if (error instanceof TeamStateError) throw error
    throw new TeamStateError()
  }
}

/**
 * Better Auth's member and user tables appear after its migrations; their
 * role, name and email changes advance the policy revision too.
 */
export function ensureAccountRevisionTriggers(db: Database): void {
  const tables = new Set(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('member', 'user')"
      )
      .all()
      .map((row) => row.name)
  )
  if (tables.has("member"))
    for (const event of ["INSERT", "UPDATE", "DELETE"])
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS wt_revision_member_${event.toLowerCase()} AFTER ${event} ON member BEGIN UPDATE wt_worktables SET policy_revision = policy_revision + 1; END`
      )
  if (tables.has("user"))
    db.exec(
      "CREATE TRIGGER IF NOT EXISTS wt_revision_user_update AFTER UPDATE OF name, email ON user BEGIN UPDATE wt_worktables SET policy_revision = policy_revision + 1; END"
    )
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

type TeamBase =
  | { kind: "solo" }
  | { kind: "team"; id: string; organizationId: string; rootKey: string }

/** Full validation of the marker, manifest and database row. Throws when unsafe. */
function readTeamBaseSlow(): TeamBase {
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
    return { kind: "solo" }
  }
  const row = db
    .query<
      WorktableRow,
      [string]
    >("SELECT * FROM wt_worktables WHERE root_key = ?")
    .get(workspaceCacheKey())
  if (!row) {
    if (marker || required) throw new TeamStateError()
    return { kind: "solo" }
  }
  if (row.id !== currentWorktableId() || (marker && marker !== row.id))
    throw new TeamStateError()
  return {
    kind: "team",
    id: row.id,
    organizationId: row.organization_id,
    rootKey: row.root_key,
  }
}

const RACY_WINDOW_MS = 2_000

interface Fingerprint {
  key: string
  changedAtMs: number
}

/** Like existsSync: a path under a regular file simply does not exist. */
export function statIfPresent(path: string) {
  try {
    return statSync(path, { bigint: true, throwIfNoEntry: false })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined
    throw error
  }
}

function fingerprint(path: string, identityOnly = false): Fingerprint {
  const stat = statIfPresent(path)
  if (!stat) return { key: "absent", changedAtMs: 0 }
  // A database's contents are covered by policy_revision; only its identity
  // (a replaced file) matters here.
  if (identityOnly) return { key: `${stat.dev}:${stat.ino}`, changedAtMs: 0 }
  return {
    key: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
    changedAtMs: Math.max(Number(stat.mtimeMs), Number(stat.ctimeMs)),
  }
}

let generation = 0
let baseCache: {
  root: string
  key: string
  generation: number
  base: TeamBase
} | null = null

/**
 * Three stats decide whether the last full validation still holds: the team
 * marker, the manifest, and the database's identity. A file changed within
 * the racy window, or a write in this process, forces full validation.
 */
function resolveTeamBase(): TeamBase {
  const root = getWorkspaceRoot()
  const dbPath = teamDatabasePath()
  const prints = [
    fingerprint(markerPath()),
    fingerprint(getWorkspaceManifestPath()),
    fingerprint(dbPath, true),
  ]
  const cached = databases.get(dbPath)
  if (cached && prints[2]!.key !== `${cached.dev}:${cached.ino}`) {
    cached.db.close()
    databases.delete(dbPath)
    baseCache = null
    throw new TeamStateError(
      "Team state changed while the server was running; restart after recovery"
    )
  }
  const key = prints.map((print) => print.key).join("|")
  const racy = prints.some(
    (print) => print.changedAtMs > Date.now() - RACY_WINDOW_MS
  )
  const known = baseCache
  if (
    !racy &&
    known?.root === root &&
    known.key === key &&
    known.generation === generation
  )
    return known.base
  const base = readTeamBaseSlow()
  baseCache = { root, key, generation, base }
  return base
}

function resolveTeamWorktable(): TeamWorktable | null {
  const base = resolveTeamBase()
  if (base.kind === "solo") return null
  const row = requireTeamDatabase()
    .query<{ policy_revision: number }, [string]>(
      "SELECT policy_revision FROM wt_worktables WHERE id = ?"
    )
    .get(base.id)
  if (!row) throw new TeamStateError()
  return {
    id: base.id,
    organizationId: base.organizationId,
    rootKey: base.rootKey,
    policyRevision: row.policy_revision,
  }
}

interface TeamRequestScope {
  resolved?: { worktable: TeamWorktable | null; generation: number }
  memo: Map<string, unknown>
}
const requestScope = new AsyncLocalStorage<TeamRequestScope>()
let turnState: { worktable: TeamWorktable | null; generation: number } | null =
  null

/** One consistent view of team state for the whole request. */
export function runWithTeamRequestScope<T>(action: () => T): T {
  return requestScope.run({ memo: new Map() }, action)
}

let turnMemo: Map<string, unknown> | null = null

/**
 * Memo for derived checks (sessions): once per request, or once per
 * synchronous turn outside a request (socket frames).
 */
export function teamRequestMemo<T>(key: string, compute: () => T): T {
  const scope = requestScope.getStore()
  let memo = scope?.memo
  if (!memo) {
    if (!turnMemo) {
      turnMemo = new Map()
      queueMicrotask(() => {
        turnMemo = null
      })
    }
    memo = turnMemo
  }
  if (memo.has(key)) return memo.get(key) as T
  const value = compute()
  memo.set(key, value)
  return value
}

let sessionEpoch = 0
/** Advanced by in-process sign-out and password changes; sockets recheck. */
export function noteTeamSessionsChanged(): void {
  sessionEpoch += 1
}
export function teamSessionEpoch(): number {
  return sessionEpoch
}

/** Advances with every in-process write of team state. */
export function teamStateGeneration(): number {
  return generation
}

/**
 * The selected Worktable's team state. Inside a request it is resolved once
 * (three stats and one revision read) and reused; elsewhere (sockets, jobs)
 * once per synchronous turn. Errors are never cached.
 */
export function currentTeamWorktable(): TeamWorktable | null {
  const scope = requestScope.getStore()
  if (scope) {
    if (!scope.resolved || scope.resolved.generation !== generation)
      scope.resolved = { worktable: resolveTeamWorktable(), generation }
    return scope.resolved.worktable
  }
  if (!turnState || turnState.generation !== generation) {
    turnState = { worktable: resolveTeamWorktable(), generation }
    queueMicrotask(() => {
      turnState = null
    })
  }
  return turnState.worktable
}

/** For writers at commit: re-read team state so a revocation mid-request applies. */
export function refreshTeamStateForWrite(): void {
  const scope = requestScope.getStore()
  if (scope) {
    scope.resolved = undefined
    // A session ended while this request waited must not authorize it.
    scope.memo.clear()
  }
  turnState = null
  turnMemo = null
}

/** Called by every in-process writer of team state, whether or not it succeeded. */
export function invalidateTeamState(): void {
  generation += 1
  baseCache = null
  turnState = null
  turnMemo = null
  requestScope.getStore()?.memo.clear()
}

export function teamsEnabled(): boolean {
  return currentTeamWorktable() !== null
}

export function advanceTeamPolicy(worktableId: string): void {
  try {
    requireTeamDatabase()
      .query(
        "UPDATE wt_worktables SET policy_revision = policy_revision + 1 WHERE id = ?"
      )
      .run(worktableId)
  } finally {
    invalidateTeamState()
  }
}

export function closeTeamDatabases(): void {
  for (const entry of databases.values()) entry.db.close()
  databases.clear()
  invalidateTeamState()
}
