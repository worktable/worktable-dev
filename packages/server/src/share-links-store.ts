import {
  SHARE_PASSWORD_HASH_GLOB,
  supportedSharePasswordHash,
} from "./share-link-credentials.ts"
import { Database } from "bun:sqlite"
import {
  defaultSharingPolicy,
  SharingPolicySchema,
  LinkGrantSchema,
  type LinkGrant,
  type ShareLinkCommentSettings,
  type ShareLinkKind,
  type SharingPolicy,
} from "@worktable/types"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { chmod, link, mkdir, open, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getAppDir } from "./app-storage.ts"
import { sharingPreviewEnabled } from "./sharing-preview.ts"
import { workspaceCacheKey } from "./workspace.ts"

// ============================================================
// Share links (v2)
// ============================================================
//
// Links live in <appDir>/sharing/<workspace>/sharing.sqlite, outside the
// workspace and outside backups; only the owner policy beside them is copied
// into operator backups. A link is keyed by its document's durable
// id, so renames and moves keep it. Only a SHA-256 of each token is stored:
// the URL exists once, in the response that created it.
//
// Older binaries never open this file. Within it, a binary serves a link only
// if it understands every column the link sets (see `servable`); new kinds of
// link fail closed on binaries that predate them. A schema version this
// binary does not know closes the whole store.

const SCHEMA_VERSION = 1
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MINUTE_MS = 60_000
/** A stored last use is only rewritten when it is older than this. */
const LAST_USED_RESOLUTION_MS = 10 * MINUTE_MS
/** Longest a pending last use waits before it is written. */
const LAST_USED_FLUSH_MS = 5 * MINUTE_MS

export class ShareLinksStoreError extends Error {
  readonly code = "SHARE_LINKS_UNAVAILABLE"
  constructor(message = "Share links are unavailable") {
    super(message)
    this.name = "ShareLinksStoreError"
  }
}

export type ShareLinkRevocationReason =
  | "revoked"
  | "document-archived"
  | "document-removed"
  | "space-archived"
  | "space-removed"
  | "workspace-reset"
  | "link-disconnected"

export interface StoredShareLink {
  id: string
  tokenHint: string
  workspaceEpoch: string
  spaceId: string
  documentId: string
  /** Doc or HTML Doc, unless a later binary added a kind (not servable). */
  kind: string
  label: string
  /** A level of ShareLinkLevel, unless a later binary added one. */
  level: string
  createdById: string
  createdByName: string
  createdAt: number
  expiresAt: number | null
  hasPassword: boolean
  passwordHash: string | null
  passwordRevision: number
  grant: LinkGrant | null
  grantRevision: string
  linkKey: Uint8Array
  comments: ShareLinkCommentSettings
  revokedAt: number | null
  revokedReason: string | null
  lastUsedAt: number | null
  migratedFrom: string | null
  /**
   * Whether this binary understands everything the link sets, and so may
   * serve it. It serves static view links without a password.
   */
  servable: boolean
}

interface LinkRow {
  id: string
  token_hash: Uint8Array
  link_key: Uint8Array
  token_hint: string
  workspace_epoch: string
  space_id: string
  document_id: string
  kind: string
  label: string
  level: string
  created_by_id: string
  created_by_name: string
  created_at: number
  expires_at: number | null
  password_hash: string | null
  password_rev: number
  grant_json: string | null
  pinned_version: string | null
  accept_comments: number
  anonymous_allowed: number
  visitors_see: string
  show_sharer_name: number
  revoked_at: number | null
  revoked_reason: string | null
  last_used_at: number | null
  migrated_from: string | null
}

const LINK_COLUMN_NAMES = [
  "id",
  "token_hash",
  "link_key",
  "token_hint",
  "workspace_epoch",
  "space_id",
  "document_id",
  "kind",
  "label",
  "level",
  "created_by_id",
  "created_by_name",
  "created_at",
  "expires_at",
  "password_hash",
  "password_rev",
  "grant_json",
  "pinned_version",
  "accept_comments",
  "anonymous_allowed",
  "visitors_see",
  "show_sharer_name",
  "revoked_at",
  "revoked_reason",
  "last_used_at",
  "migrated_from",
] as const satisfies readonly (keyof LinkRow)[]
const LINK_COLUMNS = LINK_COLUMN_NAMES.join(", ")
/** The same columns, from `share_links l` in a join. */
const JOINED_LINK_COLUMNS = LINK_COLUMN_NAMES.map((name) => `l.${name}`).join(
  ", "
)

const flag = (value: number): boolean | null =>
  value === 0 ? false : value === 1 ? true : null

/**
 * Passwords are supported only in preview, with the known hash encoding.
 * Grants, pinned versions and levels above view come with later binaries. Comment
 * settings apply only from the comment level, but must still be ones this
 * binary knows.
 */
// Parsed grants are immutable stored inputs, bounded by entries and bytes.
// A future or malformed grant never makes a link executable.
const storedGrants = new Map<string, { grant: LinkGrant | null; revision: string; bytes: number }>()
let storedGrantBytes = 0
function storedGrant(json: string | null): { grant: LinkGrant | null; revision: string } {
  if (json === null) return { grant: null, revision: "static" }
  const cached = storedGrants.get(json)
  if (cached) return cached
  let grant: LinkGrant | null = null
  if (Buffer.byteLength(json) <= 256 * 1024) {
    try {
      const parsed = LinkGrantSchema.safeParse(JSON.parse(json))
      if (parsed.success) grant = parsed.data
    } catch { /* An unreadable grant stays closed. */ }
  }
  const entry = { grant, revision: createHash("sha256").update(json).digest("base64url"), bytes: Buffer.byteLength(json) * 2 }
  if (entry.bytes > 512 * 1024) return entry
  storedGrants.set(json, entry)
  storedGrantBytes += entry.bytes
  for (const [key, old] of storedGrants) {
    if (storedGrants.size <= 256 && storedGrantBytes <= 8 * 1024 * 1024) break
    storedGrants.delete(key)
    storedGrantBytes -= old.bytes
  }
  return entry
}

function servable(row: LinkRow): boolean {
  return (
    (row.kind === "doc" || row.kind === "html") &&
    row.level === "view" &&
    (row.password_hash === null ||
      (sharingPreviewEnabled() &&
        supportedSharePasswordHash(row.password_hash))) &&
    Number.isSafeInteger(row.password_rev) &&
    row.password_rev >= 0 &&
    (row.grant_json === null || (sharingPreviewEnabled() && row.kind === "html" && storedGrant(row.grant_json).grant !== null)) &&
    row.link_key instanceof Uint8Array && row.link_key.byteLength === 32 &&
    row.pinned_version === null &&
    flag(row.accept_comments) !== null &&
    flag(row.anonymous_allowed) !== null &&
    flag(row.show_sharer_name) !== null &&
    (row.visitors_see === "own" || row.visitors_see === "all")
  )
}

function storedLink(row: LinkRow): StoredShareLink {
  return {
    id: row.id,
    tokenHint: row.token_hint,
    workspaceEpoch: row.workspace_epoch,
    spaceId: row.space_id,
    documentId: row.document_id,
    kind: row.kind,
    label: row.label,
    level: row.level,
    createdById: row.created_by_id,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    hasPassword: row.password_hash !== null,
    passwordHash: row.password_hash,
    passwordRevision: row.password_rev,
    grant: storedGrant(row.grant_json).grant,
    grantRevision: storedGrant(row.grant_json).revision,
    linkKey: row.link_key,
    comments: {
      acceptComments: row.accept_comments === 1,
      anonymousAllowed: row.anonymous_allowed === 1,
      showSharerName: row.show_sharer_name === 1,
      visitorsSee: row.visitors_see === "all" ? "all" : "own",
    },
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    lastUsedAt: row.last_used_at,
    migratedFrom: row.migrated_from,
    servable: servable(row),
  }
}

// ── Opening ──────────────────────────────────────────────────

const databases = new Map<string, Database>()

export function shareLinksDatabasePath(): string {
  return join(getAppDir(), "sharing", workspaceCacheKey(), "sharing.sqlite")
}

function migrate(db: Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS share_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS share_policy (
        id INTEGER PRIMARY KEY CHECK (id = 1), policy TEXT NOT NULL,
        revision INTEGER NOT NULL, updated_by TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS share_links (
        id TEXT PRIMARY KEY,
        token_hash BLOB NOT NULL UNIQUE,
        token_hint TEXT NOT NULL,
        link_key BLOB NOT NULL,
        workspace_epoch TEXT NOT NULL,
        space_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        level TEXT NOT NULL DEFAULT 'view',
        created_by_id TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        password_hash TEXT,
        password_rev INTEGER NOT NULL DEFAULT 0,
        grant_json TEXT,
        pinned_version TEXT,
        accept_comments INTEGER NOT NULL DEFAULT 1,
        anonymous_allowed INTEGER NOT NULL DEFAULT 0,
        visitors_see TEXT NOT NULL DEFAULT 'own',
        show_sharer_name INTEGER NOT NULL DEFAULT 0,
        revoked_at INTEGER,
        revoked_by TEXT,
        revoked_reason TEXT,
        last_used_at INTEGER,
        migrated_from TEXT
      );
      CREATE INDEX IF NOT EXISTS share_links_by_document
        ON share_links (space_id, document_id) WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS share_links_by_space
        ON share_links (space_id, created_at);
    `)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })()
}

function openDatabase(create: boolean): Database | null {
  const path = shareLinksDatabasePath()
  const cached = databases.get(path)
  if (cached) return cached
  if (!create && !existsSync(path)) return null
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let db: Database
  try {
    db = new Database(path, { create, strict: true })
  } catch (error) {
    throw new ShareLinksStoreError(
      error instanceof Error ? error.message : undefined
    )
  }
  try {
    chmodSync(path, 0o600)
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;")
    const version =
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version ?? 0
    if (version === 0) migrate(db)
    else if (version !== SCHEMA_VERSION) {
      throw new ShareLinksStoreError("Share links use an unsupported version")
    }
  } catch (error) {
    db.close()
    if (error instanceof ShareLinksStoreError) throw error
    throw new ShareLinksStoreError(
      error instanceof Error ? error.message : undefined
    )
  }
  databases.set(path, db)
  return db
}

/** Close every open store; the next use opens its file again. */
export function closeShareLinkStores(): void {
  flushShareLinkUse()
  for (const db of databases.values()) db.close()
  databases.clear()
  drained = null
  policyCache = null
}

// ── Whether links v2 is on ───────────────────────────────────

let drained: {
  key: string
  value: boolean
  /** Read from the store, so a true value holds for good. */
  settled: boolean
  checkedAt: number
} | null = null
const DRAINED_RECHECK_MS = MINUTE_MS

/**
 * Whether this Worktable serves and manages links from this store. The
 * sharing preview turns it on; once v1 links have been moved here it stays on
 * whatever the preview says. Otherwise today's links behave as they always
 * have.
 */
export function sharingV2Active(): boolean {
  return sharingPreviewEnabled() || v1AlreadyDrained()
}

function v1AlreadyDrained(): boolean {
  const key = workspaceCacheKey()
  const now = Date.now()
  if (
    drained?.key === key &&
    ((drained.value && drained.settled) ||
      now - drained.checkedAt < DRAINED_RECHECK_MS)
  ) {
    return drained.value
  }
  let value = false
  let settled = true
  try {
    value =
      openDatabase(false)
        ?.query<
          { value: string },
          [string]
        >("SELECT value FROM share_meta WHERE key = ?")
        .get("v1_drained_at") != null
  } catch {
    // A store this version can't read keeps today's routes retired, so no
    // link is made outside its owner policy; it serves nothing itself.
    value = true
    settled = false
  }
  drained = { key, value, settled, checkedAt: now }
  return value
}

/** Created only on a mutation or boot migration, never by a visitor GET. */
export function ensureShareUnlockSecret(): void {
  openDatabase(true)!
    .query(
      "INSERT OR IGNORE INTO share_meta (key, value) VALUES ('unlock_secret', ?)"
    )
    .run(randomBytes(32).toString("base64url"))
}

function decodeUnlockSecret(
  value: string | null | undefined
): Uint8Array | null {
  return value && /^[A-Za-z0-9_-]{43}$/.test(value)
    ? Buffer.from(value, "base64url")
    : null
}

export function shareUnlockSecret(): Uint8Array | null {
  const value = openDatabase(false)
    ?.query<
      { value: string },
      []
    >("SELECT value FROM share_meta WHERE key = 'unlock_secret'")
    .get()?.value
  return decodeUnlockSecret(value)
}

// ── Tokens ───────────────────────────────────────────────────

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest()
}

function newLinkId(): string {
  return `lnk_${randomBytes(16).toString("base64url")}`
}

// An additive proof index lets the member summary count supported live
// grants in SQL. Only explicit saves populate it, never a GET. Matching the
// exact JSON prevents an unknown or damaged grant from counting as open.
const GRANT_READER_VERSION = 1
function noteSupportedGrant(db: Database, id: string, grant: LinkGrant | null): void {
  db.exec(`CREATE TABLE IF NOT EXISTS share_link_grants (
    link_id TEXT PRIMARY KEY, grant_json TEXT NOT NULL, reader_version INTEGER NOT NULL
  )`)
  if (grant) {
    const json = JSON.stringify(LinkGrantSchema.parse(grant))
    db.query("INSERT OR REPLACE INTO share_link_grants (link_id, grant_json, reader_version) VALUES (?, ?, ?)").run(id, json, GRANT_READER_VERSION)
  } else db.query("DELETE FROM share_link_grants WHERE link_id = ?").run(id)
}

// ── Writes ───────────────────────────────────────────────────

export interface NewShareLink {
  workspaceEpoch: string
  spaceId: string
  documentId: string
  kind: ShareLinkKind
  label: string
  level: "view"
  createdBy: { id: string; name: string }
  expiresAt: number | null
  comments: ShareLinkCommentSettings
  passwordHash?: string
  grant?: LinkGrant | null
  now?: number
}

/** Store a new link. The token is returned here and never again. */
export function createShareLink(input: NewShareLink): {
  link: StoredShareLink
  token: string
} {
  const db = openDatabase(true)!
  ensureShareUnlockSecret()
  const token = randomBytes(32).toString("base64url")
  const id = newLinkId()
  const grant = input.grant ? LinkGrantSchema.parse(input.grant) : null
  db.transaction(() => {
  if (grant) noteSupportedGrant(db, id, grant)
  db.query(
    `INSERT INTO share_links (id, token_hash, token_hint, link_key,
      workspace_epoch, space_id, document_id, kind, label, level,
      created_by_id, created_by_name, created_at, expires_at,
      accept_comments, anonymous_allowed, show_sharer_name, visitors_see, password_hash, password_rev, grant_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    tokenDigest(token),
    token.slice(-4),
    randomBytes(32),
    input.workspaceEpoch,
    input.spaceId,
    input.documentId,
    input.kind,
    input.label,
    input.level,
    input.createdBy.id,
    input.createdBy.name,
    input.now ?? Date.now(),
    input.expiresAt,
    input.comments.acceptComments ? 1 : 0,
    input.comments.anonymousAllowed ? 1 : 0,
    input.comments.showSharerName ? 1 : 0,
    input.comments.visitorsSee,
    input.passwordHash ?? null,
    input.passwordHash ? 1 : 0,
    grant ? JSON.stringify(grant) : null
  )
  })()
  return { link: getShareLink(id)!, token }
}

/** A link copied from the earlier version's file, which still holds it. */
const V1_MOVING = "v1-moving"

/**
 * Store a link made by an earlier version, under its existing token, so its
 * URL keeps working. It counts as moving until `settleV1ShareLinks` sees
 * the old file without it. A token already here is left alone, revoked or
 * not. Returns whether a link was added.
 */
export function importV1ShareLink(input: {
  token: string
  workspaceEpoch: string
  spaceId: string
  documentId: string
  kind: ShareLinkKind
  createdAt: number
}): boolean {
  const db = openDatabase(true)!
  const inserted = db
    .query(
      `INSERT INTO share_links (id, token_hash, token_hint, link_key,
        workspace_epoch, space_id, document_id, kind, label, level,
        created_by_id, created_by_name, created_at, migrated_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'view', '', '', ?, ?)
       ON CONFLICT (token_hash) DO NOTHING`
    )
    .run(
      newLinkId(),
      tokenDigest(input.token),
      input.token.slice(-4),
      randomBytes(32),
      input.workspaceEpoch,
      input.spaceId,
      input.documentId,
      input.kind,
      input.createdAt,
      V1_MOVING
    )
  return inserted.changes > 0
}

/**
 * Reconcile links still moving with the earlier version's file as it is now,
 * while the caller holds its lock. A moving link whose share has left the
 * file was stopped there meanwhile, by an older binary, and is revoked here
 * too. Those in `moved`, which the caller has durably removed from the file,
 * have moved for good.
 */
export function settleV1ShareLinks(
  present: readonly string[],
  moved: readonly string[],
  recoveredDigests: readonly string[] = []
): void {
  const db = openDatabase(false)
  if (!db) return
  const inFile = new Set([
    ...present.map((token) => tokenDigest(token).toString("hex")),
    ...recoveredDigests,
  ])
  const stopped = db
    .query<{ id: string; token_hash: Uint8Array }, [string]>(
      "SELECT id, token_hash FROM share_links WHERE migrated_from = ?"
    )
    .all(V1_MOVING)
    .filter((row) => !inFile.has(Buffer.from(row.token_hash).toString("hex")))
    .map((row) => row.id)
  const now = Date.now()
  db.transaction(() => {
    const revoke = db.query(
      `UPDATE share_links SET migrated_from = 'v1',
        revoked_at = COALESCE(revoked_at, ?),
        revoked_by = COALESCE(revoked_by, 'system'),
        revoked_reason = COALESCE(revoked_reason, 'revoked')
       WHERE id = ?`
    )
    for (const id of stopped) revoke.run(now, id)
    const settle = db.query(
      "UPDATE share_links SET migrated_from = 'v1' WHERE token_hash = ? AND migrated_from = ?"
    )
    for (const token of moved) settle.run(tokenDigest(token), V1_MOVING)
    for (const digest of recoveredDigests)
      settle.run(Buffer.from(digest, "hex"), V1_MOVING)
  })()
  if (stopped.length > 0) notifyChanged(stopped)
}

/**
 * Note that links of the earlier version were moved here. From then on this
 * store serves links whatever the sharing preview says.
 */
export function markV1SharesDrained(now = Date.now()): void {
  ensureShareUnlockSecret()
  openDatabase(true)!
    .query(
      "INSERT OR IGNORE INTO share_meta (key, value) VALUES ('v1_drained_at', ?)"
    )
    .run(String(now))
  drained = {
    key: workspaceCacheKey(),
    value: true,
    settled: true,
    checkedAt: now,
  }
}

export interface ShareLinkChange {
  /** undefined leaves the password unchanged; null removes it. */
  passwordHash?: string | null
  grant?: LinkGrant | null
  label?: string
  expiresAt?: number | null
  comments?: Partial<ShareLinkCommentSettings>
}

/** Change a link that has not been revoked. Its token stays the same. */
export function updateShareLink(
  id: string,
  change: ShareLinkChange
): StoredShareLink | null {
  const db = openDatabase(false)
  if (!db) return null
  const sets: string[] = []
  const values: Array<string | number | null> = []
  const set = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`)
    values.push(value)
  }
  const bit = (value: boolean) => (value ? 1 : 0)
  const comments = change.comments ?? {}
  if (change.passwordHash !== undefined) {
    set("password_hash", change.passwordHash)
    sets.push("password_rev = password_rev + 1")
  }
  if (change.grant !== undefined) {
    set("grant_json", change.grant === null ? null : JSON.stringify(LinkGrantSchema.parse(change.grant)))
    // The credential revision is monotonic, so A → B → A cannot revive an
    // unlock or frame ticket made before the access edit.
    if (change.passwordHash === undefined) sets.push("password_rev = password_rev + 1")
  }
  if (change.label !== undefined) set("label", change.label)
  if (change.expiresAt !== undefined) set("expires_at", change.expiresAt)
  if (comments.acceptComments !== undefined) {
    set("accept_comments", bit(comments.acceptComments))
  }
  if (comments.anonymousAllowed !== undefined) {
    set("anonymous_allowed", bit(comments.anonymousAllowed))
  }
  if (comments.showSharerName !== undefined) {
    set("show_sharer_name", bit(comments.showSharerName))
  }
  if (comments.visitorsSee !== undefined) {
    set("visitors_see", comments.visitorsSee)
  }
  if (sets.length > 0) {
    db.transaction(() => {
    if (change.grant !== undefined) noteSupportedGrant(db, id, change.grant)
    db.query(
      `UPDATE share_links SET ${sets.join(", ")}
       WHERE id = ? AND revoked_at IS NULL`
    ).run(...values, id)
    })()
    notifyChanged([id])
  }
  return getShareLink(id)
}

/** Revoke one link. Revoking is permanent. */
export function revokeShareLink(
  id: string,
  revokedBy: string,
  reason: ShareLinkRevocationReason = "revoked"
): StoredShareLink | null {
  const db = openDatabase(false)
  if (!db) return null
  db.query(
    `UPDATE share_links SET revoked_at = ?, revoked_by = ?,
      revoked_reason = ? WHERE id = ? AND revoked_at IS NULL`
  ).run(Date.now(), revokedBy, reason, id)
  notifyChanged([id])
  return getShareLink(id)
}

function revokeWhere(
  where: string,
  params: string[],
  reason: ShareLinkRevocationReason
): number {
  const db = openDatabase(false)
  if (!db) return 0
  const revoked = db
    .query<{ id: string }, Array<string | number>>(
      `UPDATE share_links SET revoked_at = ?, revoked_by = 'system',
        revoked_reason = ? WHERE revoked_at IS NULL AND ${where} RETURNING id`
    )
    .all(Date.now(), reason, ...params)
  if (revoked.length > 0) notifyChanged(revoked.map((row) => row.id))
  return revoked.length
}

/** Revoke the links to these documents of a Space. */
export function revokeDocumentShareLinks(
  spaceId: string,
  documentIds: readonly string[],
  reason: ShareLinkRevocationReason
): number {
  let revoked = 0
  // SQLite caps bound parameters; documents are revoked in slices.
  for (let index = 0; index < documentIds.length; index += 500) {
    const slice = documentIds.slice(index, index + 500)
    revoked += revokeWhere(
      `space_id = ? AND document_id IN (${slice.map(() => "?").join(", ")})`,
      [spaceId, ...slice],
      reason
    )
  }
  return revoked
}

/** Revoke every link into a Space. */
export function revokeSpaceShareLinks(
  spaceId: string,
  reason: ShareLinkRevocationReason
): number {
  return revokeWhere("space_id = ?", [spaceId], reason)
}

/**
 * Revoke every link of this Worktable. A workspace reset also replaces the
 * secret that signs unlock tickets, so none outlives the content it unlocked.
 */
export function revokeAllShareLinks(reason: ShareLinkRevocationReason): number {
  const revoked = revokeWhere("1 = 1", [], reason)
  if (reason === "workspace-reset") {
    openDatabase(false)
      ?.query(
        "INSERT OR REPLACE INTO share_meta (key, value) VALUES ('unlock_secret', ?)"
      )
      .run(randomBytes(32).toString("base64url"))
  }
  return revoked
}

// ── Reads ────────────────────────────────────────────────────

/**
 * The link a token opens and the owner policy as it stands: one indexed
 * SELECT, no lock and no file read. The policy is parsed again only when its
 * revision moved. The caller checks revocation, epoch, expiry and policy.
 */
export function findShareLinkForView(token: string): {
  link: StoredShareLink
  policy: SharingPolicy
  policyRevision: number
  unlockSecret: Uint8Array | null
} | null {
  if (!TOKEN_PATTERN.test(token)) return null
  const db = openDatabase(false)
  if (!db) return null
  const digest = tokenDigest(token)
  const row = db
    .query<
      LinkRow & {
        policy_revision: number | null
        unlock_secret: string | null
      },
      [Buffer]
    >(
      `SELECT ${JOINED_LINK_COLUMNS}, p.revision AS policy_revision, m.value AS unlock_secret
       FROM share_links l LEFT JOIN share_policy p ON p.id = 1
       LEFT JOIN share_meta m ON m.key = 'unlock_secret'
       WHERE l.token_hash = ?`
    )
    .get(digest)
  if (!row) return null
  const stored = Buffer.from(row.token_hash)
  if (stored.length !== digest.length || !timingSafeEqual(stored, digest)) {
    return null
  }
  return {
    link: storedLink(row),
    policy: policyAt(db, row.policy_revision ?? 0),
    policyRevision: row.policy_revision ?? 0,
    unlockSecret: decodeUnlockSecret(row.unlock_secret),
  }
}

/** A link by id and the owner policy as it stands, to check a view again. */
export function findShareLinkWithPolicy(id: string): {
  link: StoredShareLink
  policy: SharingPolicy
  policyRevision: number
  unlockSecret: Uint8Array | null
} | null {
  const db = openDatabase(false)
  if (!db) return null
  const row = db
    .query<
      LinkRow & {
        policy_revision: number | null
        unlock_secret: string | null
      },
      [string]
    >(
      `SELECT ${JOINED_LINK_COLUMNS}, p.revision AS policy_revision, m.value AS unlock_secret
       FROM share_links l LEFT JOIN share_policy p ON p.id = 1
       LEFT JOIN share_meta m ON m.key = 'unlock_secret'
       WHERE l.id = ?`
    )
    .get(id)
  return row
    ? {
        link: storedLink(row),
        policy: policyAt(db, row.policy_revision ?? 0),
    policyRevision: row.policy_revision ?? 0,
        unlockSecret: decodeUnlockSecret(row.unlock_secret),
      }
    : null
}

/** The link a token opens, whatever the policy says. */
export function findShareLinkByToken(token: string): StoredShareLink | null {
  return findShareLinkForView(token)?.link ?? null
}

export function getShareLink(id: string): StoredShareLink | null {
  const row = openDatabase(false)
    ?.query<
      LinkRow,
      [string]
    >(`SELECT ${LINK_COLUMNS} FROM share_links WHERE id = ?`)
    .get(id)
  return row ? storedLink(row) : null
}

/** The links to one document that have not been revoked, newest first. */
export function listDocumentShareLinks(
  spaceId: string,
  documentId: string
): StoredShareLink[] {
  return (
    openDatabase(false)
      ?.query<LinkRow, [string, string]>(
        `SELECT ${LINK_COLUMNS} FROM share_links
         WHERE space_id = ? AND document_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC, id DESC`
      )
      .all(spaceId, documentId)
      .map(storedLink) ?? []
  )
}

/** Count and next expiry only; never materialize a document's link history. */
export function documentShareLinkSummary(
  spaceId: string,
  documentId: string,
  now = Date.now(),
  maxExpiryDays: number | null = null,
  creatorAllowed: (id: string) => boolean = () => true,
  requirePassword = false,
  allowLive = false
): { activeLinks: number; nextExpiry: number | null } {
  const cap = maxExpiryDays === null ? null : maxExpiryDays * 86_400_000
  const readGroups = (live: boolean) =>
    openDatabase(false)
      ?.query<
        { createdById: string; activeLinks: number; nextExpiry: number | null },
        [
          number | null,
          number | null,
          number | null,
          string,
          string,
          number,
          string,
          number,
          number,
        ]
      >(
        `
    WITH eligible AS (
      SELECT created_by_id, CASE WHEN ? IS NULL THEN expires_at
        WHEN expires_at IS NULL THEN created_at + ?
        ELSE min(expires_at, created_at + ?) END AS expiry
      FROM share_links
      WHERE space_id = ? AND document_id = ? AND revoked_at IS NULL
        AND kind IN ('doc', 'html') AND level = 'view'
        AND (password_hash IS NULL OR (? = 1 AND password_hash GLOB ?))
        AND (? = 0 OR password_hash IS NOT NULL)
        AND typeof(password_rev) = 'integer' AND password_rev BETWEEN 0 AND 9007199254740991
        AND (grant_json IS NULL ${live ? `OR (kind = 'html' AND EXISTS (
          SELECT 1 FROM share_link_grants g WHERE g.link_id = share_links.id
            AND g.grant_json = share_links.grant_json AND g.reader_version = ${GRANT_READER_VERSION}
        ))` : ""}) AND pinned_version IS NULL
        AND typeof(link_key) = 'blob' AND length(link_key) = 32
        AND accept_comments IN (0, 1) AND anonymous_allowed IN (0, 1)
        AND show_sharer_name IN (0, 1) AND visitors_see IN ('own', 'all')
    ) SELECT created_by_id AS createdById, COUNT(*) AS activeLinks, MIN(expiry) AS nextExpiry
      FROM eligible WHERE expiry IS NULL OR expiry > ? GROUP BY created_by_id
  `
      )
      .all(
        cap,
        cap,
        cap,
        spaceId,
        documentId,
        sharingPreviewEnabled() ? 1 : 0,
        SHARE_PASSWORD_HASH_GLOB,
        requirePassword ? 1 : 0,
        now
      ) ?? []
  let groups: ReturnType<typeof readGroups>
  try { groups = readGroups(allowLive && sharingPreviewEnabled()) }
  catch (error) {
    // Existing v2 stores have no live proof index until their first grant
    // is saved. Keep their static aggregate available without a read-side DDL.
    if (!(error instanceof Error) || error.message !== "no such table: share_link_grants") throw error
    groups = readGroups(false)
  }
  return groups.reduce<{ activeLinks: number; nextExpiry: number | null }>(
    (summary, group) => {
      if (!creatorAllowed(group.createdById)) return summary
      summary.activeLinks += group.activeLinks
      if (group.nextExpiry !== null)
        summary.nextExpiry =
          summary.nextExpiry === null
            ? group.nextExpiry
            : Math.min(summary.nextExpiry, group.nextExpiry)
      return summary
    },
    { activeLinks: 0, nextExpiry: null }
  )
}

/** Unrevoked links into a Space, by link id and document. */
export function activeSpaceShareLinks(
  spaceId: string
): Array<{ id: string; documentId: string }> {
  return (
    openDatabase(false)
      ?.query<{ id: string; document_id: string }, [string]>(
        `SELECT id, document_id FROM share_links
         WHERE space_id = ? AND revoked_at IS NULL`
      )
      .all(spaceId)
      .map((row) => ({ id: row.id, documentId: row.document_id })) ?? []
  )
}

export interface ShareLinkPage {
  links: StoredShareLink[]
  nextCursor: string | null
}

/** Revoked links stay listed this long. */
const REVOKED_LISTED_MS = 90 * 24 * 60 * MINUTE_MS

export type ShareLinkListStatus = "active" | "expired" | "revoked"

/**
 * Links across Spaces, newest first, a page at a time. `spaceIds` limits the
 * Spaces; null lists every Space. Without a status, links that still exist
 * are listed: active and expired.
 */
export function listShareLinks(options: {
  spaceIds: readonly string[] | null
  status?: ShareLinkListStatus
  cursor?: string | null
  limit: number
  now?: number
}): ShareLinkPage {
  const db = openDatabase(false)
  if (!db || options.spaceIds?.length === 0) {
    return { links: [], nextCursor: null }
  }
  const now = options.now ?? Date.now()
  const where: string[] = []
  const params: Array<string | number> = []
  if (options.status === "revoked") {
    where.push("revoked_at > ?")
    params.push(now - REVOKED_LISTED_MS)
  } else {
    where.push("revoked_at IS NULL")
    if (options.status === "active") {
      where.push("(expires_at IS NULL OR expires_at > ?)")
      params.push(now)
    } else if (options.status === "expired") {
      where.push("expires_at <= ?")
      params.push(now)
    }
  }
  if (options.spaceIds) {
    where.push(`space_id IN (${options.spaceIds.map(() => "?").join(", ")})`)
    params.push(...options.spaceIds)
  }
  const after = decodeCursor(options.cursor)
  if (after) {
    where.push("(created_at < ? OR (created_at = ? AND id < ?))")
    params.push(after.createdAt, after.createdAt, after.id)
  }
  const rows = db
    .query<LinkRow, Array<string | number>>(
      `SELECT ${LINK_COLUMNS} FROM share_links WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(...params, options.limit + 1)
  const links = rows.slice(0, options.limit).map(storedLink)
  const last = links.at(-1)
  return {
    links,
    nextCursor:
      rows.length > options.limit && last
        ? Buffer.from(`${last.createdAt}:${last.id}`).toString("base64url")
        : null,
  }
}

/**
 * Forget links revoked longer ago than they stay listed. Background work:
 * the daily retention pass runs it, never a request.
 */
export function sweepRevokedShareLinks(now = Date.now()): number {
  try {
    const db = openDatabase(false)
    if (!db) return 0
    return db.transaction(() => {
      const removed = db.query("DELETE FROM share_links WHERE revoked_at IS NOT NULL AND revoked_at <= ?").run(now - REVOKED_LISTED_MS).changes
      if (removed) {
        try { db.exec("DELETE FROM share_link_grants WHERE link_id NOT IN (SELECT id FROM share_links)") }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "no such table: share_link_grants") throw error
        }
      }
      return removed
    })()
  } catch (error) {
    // A later version's store keeps its own rows.
    if (error instanceof ShareLinksStoreError) return 0
    throw error
  }
}

function decodeCursor(
  cursor: string | null | undefined
): { createdAt: number; id: string } | null {
  if (!cursor) return null
  const [createdAt, id] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split(":", 2)
  const at = Number(createdAt)
  return Number.isSafeInteger(at) && id ? { createdAt: at, id } : null
}

// ── Owner policy ─────────────────────────────────────────────
//
// One row, saved whole, whose revision moves with every save. Each view
// reads the revision with its link, so a change made by any process applies
// at the next view; the policy itself is parsed again only when the revision
// moved. Revision 0 is the defaults, before an owner first saves a policy.

export interface StoredSharingPolicy {
  policy: SharingPolicy
  revision: number
}

const DEFAULT_POLICY: SharingPolicy = defaultSharingPolicy()

let policyCache: (StoredSharingPolicy & { path: string }) | null = null

/**
 * A saved policy this binary can't read, such as one a later version saved
 * with settings it doesn't know, stops every link until an owner saves the
 * policy again here.
 */
function parsePolicy(text: string): SharingPolicy {
  try {
    return SharingPolicySchema.parse(JSON.parse(text))
  } catch {
    return { ...DEFAULT_POLICY, paused: true }
  }
}

function policyAt(db: Database, revision: number): SharingPolicy {
  const path = shareLinksDatabasePath()
  if (policyCache?.path === path && policyCache.revision === revision) {
    return policyCache.policy
  }
  const row = db
    .query<
      { policy: string; revision: number },
      []
    >("SELECT policy, revision FROM share_policy WHERE id = 1")
    .get()
  const policy = row ? parsePolicy(row.policy) : DEFAULT_POLICY
  policyCache = { path, revision: row?.revision ?? 0, policy }
  return policy
}

/** The owner policy as saved, with its revision. */
export function readSharingPolicy(): StoredSharingPolicy {
  const db = openDatabase(false)
  if (!db) return { policy: DEFAULT_POLICY, revision: 0 }
  const revision =
    db
      .query<
        { revision: number },
        []
      >("SELECT revision FROM share_policy WHERE id = 1")
      .get()?.revision ?? 0
  return { policy: policyAt(db, revision), revision }
}

/** Save a whole owner policy; it applies from every link's next view. */
export function saveSharingPolicy(
  policy: SharingPolicy,
  updatedBy: string,
  /**
   * The revision the change was made from, 0 before any save. A save from
   * another revision changes nothing and returns null. Omitted, it applies.
   */
  expectedRevision?: number
): StoredSharingPolicy | null {
  const db = openDatabase(true)!
  const values = [JSON.stringify(policy), updatedBy, Date.now()] as const
  // One statement each way, so a save made from an older copy, in any
  // process, changes nothing.
  const saved =
    expectedRevision === undefined
      ? db
          .query<{ revision: number }, [string, string, number]>(
            `INSERT INTO share_policy (id, policy, revision, updated_by, updated_at)
             VALUES (1, ?, 1, ?, ?)
             ON CONFLICT (id) DO UPDATE SET policy = excluded.policy,
               revision = share_policy.revision + 1,
               updated_by = excluded.updated_by, updated_at = excluded.updated_at
             RETURNING revision`
          )
          .get(...values)
      : expectedRevision === 0
        ? db
            .query<{ revision: number }, [string, string, number]>(
              `INSERT INTO share_policy (id, policy, revision, updated_by, updated_at)
               VALUES (1, ?, 1, ?, ?) ON CONFLICT (id) DO NOTHING
               RETURNING revision`
            )
            .get(...values)
        : db
            .query<{ revision: number }, [string, string, number, number]>(
              `UPDATE share_policy SET policy = ?, updated_by = ?,
                 updated_at = ?, revision = revision + 1
               WHERE id = 1 AND revision = ? RETURNING revision`
            )
            .get(...values, expectedRevision)
  if (!saved) return null
  policyCache = {
    path: shareLinksDatabasePath(),
    revision: saved.revision,
    policy,
  }
  return { policy, revision: saved.revision }
}

/** The saved policy, including future fields. An unreadable policy fails a backup. */
export function sharingPolicyForBackup(): Record<string, unknown> | null {
  const row = openDatabase(false)
    ?.query<
      { policy: string },
      []
    >("SELECT policy FROM share_policy WHERE id = 1")
    .get()
  if (!row) return null
  let value: unknown
  try {
    value = JSON.parse(row.policy)
  } catch {
    throw new ShareLinksStoreError("Saved sharing policy is unreadable")
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ShareLinksStoreError("Saved sharing policy is unreadable")
  return value as Record<string, unknown>
}

const PENDING_POLICY_RESTORE = "pending-policy-restore"

/** Only a store made by an unpublished recovery may take another snapshot's policy. */
function replacePendingRestoredPolicy(
  db: Database,
  policy: Record<string, unknown> | null
): boolean {
  return db.transaction(() => {
    const pending = db
      .query<
        { value: string },
        [string]
      >("SELECT value FROM share_meta WHERE key = ?")
      .get(PENDING_POLICY_RESTORE)?.value
    const saved = db
      .query<
        { revision: number; updated_by: string },
        []
      >("SELECT revision, updated_by FROM share_policy WHERE id = 1")
      .get()
    if (
      !pending ||
      !(pending === "none" || /^[1-9][0-9]*$/.test(pending)) ||
      (saved
        ? saved.updated_by !== "restore" || pending !== String(saved.revision)
        : pending !== "none")
    )
      return false
    if (db.query("SELECT 1 FROM share_links LIMIT 1").get()) return false
    if (
      saved &&
      (!Number.isSafeInteger(saved.revision) ||
        saved.revision >= Number.MAX_SAFE_INTEGER)
    )
      return false
    const revision = (saved?.revision ?? 0) + 1
    if (policy)
      db.query(
        "INSERT OR REPLACE INTO share_policy (id, policy, revision, updated_by, updated_at) VALUES (1, ?, ?, 'restore', ?)"
      ).run(JSON.stringify(policy), revision, Date.now())
    else db.query("DELETE FROM share_policy WHERE id = 1").run()
    db.query("UPDATE share_meta SET value = ? WHERE key = ?").run(
      policy ? String(revision) : "none",
      PENDING_POLICY_RESTORE
    )
    policyCache = null
    return true
  })()
}

/**
 * Install a policy before publishing a recovered workspace. The store starts
 * as a complete, durable file; its marker stays until publication succeeds.
 * A failed or interrupted recovery may therefore retry a different snapshot.
 * Any store with an owner's save or a link remains authoritative.
 */
export async function restoreSharingPolicy(
  policy: Record<string, unknown> | null
): Promise<boolean> {
  const path = shareLinksDatabasePath()
  if (databases.has(path) || existsSync(path)) {
    let db: Database | null
    try {
      db = openDatabase(false)
    } catch (error) {
      if (error instanceof ShareLinksStoreError) return false
      throw error
    }
    return db ? replacePendingRestoredPolicy(db, policy) : false
  }
  if (!policy) return false
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const staged = `${path}.restore-${randomBytes(16).toString("hex")}`
  let db: Database | null = null
  try {
    db = new Database(staged, { create: true, strict: true })
    await chmod(staged, 0o600)
    // Close a complete single-file database before its no-replace publication.
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL")
    migrate(db)
    db.transaction(() => {
      db!
        .query(
          "INSERT INTO share_policy (id, policy, revision, updated_by, updated_at) VALUES (1, ?, 1, 'restore', ?)"
        )
        .run(JSON.stringify(policy), Date.now())
      db!
        .query("INSERT INTO share_meta (key, value) VALUES (?, '1')")
        .run(PENDING_POLICY_RESTORE)
    })()
    db.close()
    db = null
    try {
      await link(staged, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
      throw error
    }
    const parent = await open(dirname(path), "r")
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
    policyCache = null
    return true
  } finally {
    db?.close()
    await rm(staged, { force: true })
    await rm(`${staged}-journal`, { force: true })
  }
}

/** Publication completed, or the restored workspace reached its first boot. */
export function finalizeRestoredSharingPolicy(): void {
  let db: Database | null
  let marker: string | undefined
  try {
    db = openDatabase(false)
    marker = db
      ?.query<
        { value: string },
        [string]
      >("SELECT value FROM share_meta WHERE key = ?")
      .get(PENDING_POLICY_RESTORE)?.value
  } catch (error) {
    // An unreadable sharing store closes sharing without blocking the app.
    if (
      error instanceof ShareLinksStoreError ||
      (error instanceof Error && error.name === "SQLiteError")
    )
      return
    throw error
  }
  if (marker === "none" || (marker && /^[1-9][0-9]*$/.test(marker)))
    db!
      .query("DELETE FROM share_meta WHERE key = ?")
      .run(PENDING_POLICY_RESTORE)
}

// ── Changes ──────────────────────────────────────────────────

const changeListeners = new Set<(ids: readonly string[]) => void>()

/** Hear about links that were revoked or edited, by id. */
export function onShareLinksChanged(
  listener: (ids: readonly string[]) => void
): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function notifyChanged(ids: readonly string[]): void {
  for (const listener of changeListeners) listener(ids)
}

// ── Last use, off the request path ───────────────────────────
//
// A view only notes the time in memory. Pending notes are written together,
// at most every five minutes and only while some are pending, so an idle
// server never wakes for them; shutdown writes what is left. Times are kept
// to the minute and rewritten only when ten minutes newer than the stored one.

const pendingUse = new Map<string, Map<string, number>>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function noteShareLinkUsed(
  link: Pick<StoredShareLink, "id" | "lastUsedAt">,
  now = Date.now()
): void {
  const minute = now - (now % MINUTE_MS)
  if (
    link.lastUsedAt !== null &&
    minute - link.lastUsedAt <= LAST_USED_RESOLUTION_MS
  ) {
    return
  }
  const path = shareLinksDatabasePath()
  const pending = pendingUse.get(path) ?? new Map<string, number>()
  pending.set(link.id, minute)
  pendingUse.set(path, pending)
  if (!flushTimer) {
    flushTimer = setTimeout(flushShareLinkUse, LAST_USED_FLUSH_MS)
    flushTimer.unref?.()
  }
}

/** Write pending last-use times now. */
export function flushShareLinkUse(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  const batches = [...pendingUse]
  pendingUse.clear()
  for (const [path, pending] of batches) {
    const db = databases.get(path)
    if (!db) continue
    try {
      const update = db.query(
        `UPDATE share_links SET last_used_at = ?1
         WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?1 - ?3)`
      )
      db.transaction(() => {
        for (const [id, at] of pending) {
          update.run(at, id, LAST_USED_RESOLUTION_MS)
        }
      })()
    } catch (error) {
      console.error(
        "[share-links] last use not saved:",
        error instanceof Error ? error.name : "error"
      )
    }
  }
}
