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
  type ShareLinkLevel,
  type SharingPolicy,
} from "@worktable/types"
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
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
// id, so renames and moves keep it. A link is found by a SHA-256 of its
// token. The token itself is kept only sealed with a key derived from the
// store's secret (see `sealToken`), so people who manage a link can copy its
// URL again.
//
// Older binaries never open this file. Within it, a binary serves a link only
// if it understands every column the link sets (see `servable`); new kinds of
// link fail closed on binaries that predate them. A schema version this
// binary does not know closes the whole store. Tables added since version 1,
// such as sealed tokens, are created on first write and leave the version as
// it is, so binaries that predate them still open the store.

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
    (row.level === "view" || (sharingPreviewEnabled() && row.level === "comment")) &&
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
    // The visitor columns are constants (see `normalizeVisitorSettings`).
    comments: { acceptComments: row.accept_comments === 1 },
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

/**
 * Visitors see only their own comments and give a name. Links saved when
 * a link could show every comment, allow anonymous comments or sign replies
 * with the sharer's name are set back, once per open and idempotently, so
 * an older binary run on this store later can't bring those back. The
 * columns stay: older binaries read them. Only values this binary knew are
 * changed; a later binary's values keep the link unservable here.
 */
function normalizeVisitorSettings(db: Database): void {
  const legacy = `visitors_see IN ('own', 'all') AND anonymous_allowed IN (0, 1)
    AND show_sharer_name IN (0, 1)
    AND (visitors_see = 'all' OR anonymous_allowed = 1 OR show_sharer_name = 1)`
  // Read first, so an open that finds nothing to change never takes the write lock.
  if (db.query(`SELECT 1 FROM share_links WHERE ${legacy} LIMIT 1`).get())
    db.query(
      `UPDATE share_links SET visitors_see = 'own', anonymous_allowed = 0,
         show_sharer_name = 0 WHERE ${legacy}`
    ).run()
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
    normalizeVisitorSettings(db)
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
  policyCache = null
}

/** Whether this Worktable has a links store yet, without making one. */
export function shareLinksStoreExists(): boolean {
  const path = shareLinksDatabasePath()
  return databases.has(path) || existsSync(path)
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

// ── Sealed tokens ────────────────────────────────────────────
//
// Each link's token is kept sealed with AES-256-GCM, so people who manage the
// link can copy its URL again. The key comes from HKDF-SHA256 over the
// store's unlock secret, which a workspace reset replaces after revoking
// every link. Each seal has its own random 96-bit nonce and authenticates the
// link's id, so a sealed token can't be moved onto another link, and an
// opened token must hash to its link's digest. A revoked link's seal is
// deleted. Links made before tokens were kept have none and show no URL. The
// table is made on first write, as the grant index is, so the store's version
// stays the same.

const SEALED_TOKEN_INFO = "worktable-share-link-token-v1"
const NO_TOKEN_TABLE = "no such table: share_link_tokens"

function tokenKey(secret: Uint8Array): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret, new Uint8Array(0), SEALED_TOKEN_INFO, 32)
  )
}

function tokenAad(linkId: string): Buffer {
  return Buffer.from(`${SEALED_TOKEN_INFO}\0${linkId}`)
}

/** Seal a link's token, inside the transaction that stores the link. */
function sealToken(db: Database, linkId: string, token: string): void {
  const secret = decodeUnlockSecret(
    db
      .query<
        { value: string },
        []
      >("SELECT value FROM share_meta WHERE key = 'unlock_secret'")
      .get()?.value
  )
  if (!secret) throw new ShareLinksStoreError()
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", tokenKey(secret), nonce)
  cipher.setAAD(tokenAad(linkId))
  const sealed = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  db.exec(`CREATE TABLE IF NOT EXISTS share_link_tokens (
    link_id TEXT PRIMARY KEY, nonce BLOB NOT NULL, sealed BLOB NOT NULL
  )`)
  db.query(
    "INSERT OR REPLACE INTO share_link_tokens (link_id, nonce, sealed) VALUES (?, ?, ?)"
  ).run(linkId, nonce, sealed)
}

function openToken(
  key: Buffer,
  row: { id: string; token_hash: Uint8Array; nonce: Uint8Array; sealed: Uint8Array }
): string | null {
  const sealed = Buffer.from(row.sealed)
  if (row.nonce.byteLength !== 12 || sealed.length <= 16) return null
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, row.nonce)
    decipher.setAAD(tokenAad(row.id))
    decipher.setAuthTag(sealed.subarray(-16))
    const token = Buffer.concat([
      decipher.update(sealed.subarray(0, -16)),
      decipher.final(),
    ]).toString("utf8")
    const digest = tokenDigest(token)
    const stored = Buffer.from(row.token_hash)
    return TOKEN_PATTERN.test(token) &&
      stored.length === digest.length &&
      timingSafeEqual(stored, digest)
      ? token
      : null
  } catch {
    return null
  }
}

/**
 * The tokens of these links that have not been revoked, by link id, in one
 * read. Only for people who may manage the links; a link without a sealed
 * token, or one that doesn't open, is left out.
 */
export function readShareLinkTokens(
  ids: readonly string[]
): Map<string, string> {
  const tokens = new Map<string, string>()
  const db = ids.length ? openDatabase(false) : null
  if (!db) return tokens
  let rows: Array<{
    id: string
    token_hash: Uint8Array
    nonce: Uint8Array
    sealed: Uint8Array
    secret: string | null
  }>
  try {
    rows = db
      .query<(typeof rows)[number], [string]>(
        `SELECT l.id, l.token_hash, t.nonce, t.sealed, m.value AS secret
         FROM share_link_tokens t
         JOIN share_links l ON l.id = t.link_id AND l.revoked_at IS NULL
         LEFT JOIN share_meta m ON m.key = 'unlock_secret'
         WHERE t.link_id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(ids))
  } catch (error) {
    if (error instanceof Error && error.message === NO_TOKEN_TABLE)
      return tokens
    throw error
  }
  const secret = decodeUnlockSecret(rows[0]?.secret)
  if (!secret) return tokens
  const key = tokenKey(secret)
  for (const row of rows) {
    const token = openToken(key, row)
    if (token) tokens.set(row.id, token)
  }
  return tokens
}

/** Delete the sealed tokens of links that were revoked. */
function forgetTokens(db: Database, ids: readonly string[]): void {
  if (!ids.length) return
  try {
    db.query(
      "DELETE FROM share_link_tokens WHERE link_id IN (SELECT value FROM json_each(?))"
    ).run(JSON.stringify(ids))
  } catch (error) {
    if (!(error instanceof Error) || error.message !== NO_TOKEN_TABLE)
      throw error
  }
}

// An additive proof index lets the member summary count supported live
// grants in SQL. Only explicit saves and the boot refresh below populate it,
// never a GET. Matching the exact JSON prevents an unknown or damaged grant
// from counting as open. Version 2: grants have one kind (chosen collections).
const GRANT_READER_VERSION = 2
function noteSupportedGrant(db: Database, id: string, grant: LinkGrant | null): void {
  db.exec(`CREATE TABLE IF NOT EXISTS share_link_grants (
    link_id TEXT PRIMARY KEY, grant_json TEXT NOT NULL, reader_version INTEGER NOT NULL
  )`)
  if (grant) {
    const json = JSON.stringify(LinkGrantSchema.parse(grant))
    db.query("INSERT OR REPLACE INTO share_link_grants (link_id, grant_json, reader_version) VALUES (?, ?, ?)").run(id, json, GRANT_READER_VERSION)
  } else db.query("DELETE FROM share_link_grants WHERE link_id = ?").run(id)
}

/**
 * Bring proofs written by an earlier reader up to date, once per boot. A
 * stored grant this version still reads keeps counting as open; one it can't
 * read (a removed kind, such as totals only) loses its proof, matching its
 * link, which no longer opens.
 */
export function refreshShareLinkGrantProofs(): { kept: number; dropped: number } {
  const db = openDatabase(false)
  if (!db) return { kept: 0, dropped: 0 }
  try {
    return db.transaction(() => {
      const stale = db
        .query<{ link_id: string; grant_json: string }, [number]>(
          `SELECT g.link_id, g.grant_json FROM share_link_grants g
            WHERE g.reader_version < ?`
        )
        .all(GRANT_READER_VERSION)
      let kept = 0
      let dropped = 0
      for (const row of stale) {
        let readable = false
        try {
          readable = LinkGrantSchema.safeParse(JSON.parse(row.grant_json)).success
        } catch {
          readable = false
        }
        if (readable) {
          db.query("UPDATE share_link_grants SET reader_version = ? WHERE link_id = ?").run(GRANT_READER_VERSION, row.link_id)
          kept += 1
        } else {
          db.query("DELETE FROM share_link_grants WHERE link_id = ?").run(row.link_id)
          dropped += 1
        }
      }
      return { kept, dropped }
    })()
  } catch (error) {
    if (error instanceof Error && error.message === "no such table: share_link_grants")
      return { kept: 0, dropped: 0 }
    throw error
  }
}

// ── Writes ───────────────────────────────────────────────────

export interface NewShareLink {
  workspaceEpoch: string
  spaceId: string
  documentId: string
  kind: ShareLinkKind
  label: string
  level: "view" | "comment"
  createdBy: { id: string; name: string }
  expiresAt: number | null
  comments: ShareLinkCommentSettings
  passwordHash?: string
  grant?: LinkGrant | null
  now?: number
}

/** Store a new link, its token sealed for people who manage it later. */
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
    0,
    0,
    "own",
    input.passwordHash ?? null,
    input.passwordHash ? 1 : 0,
    grant ? JSON.stringify(grant) : null
  )
  sealToken(db, id, token)
  db.query(MARK_V1_DRAINED).run(String(Date.now()))
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
  ensureShareUnlockSecret()
  const id = newLinkId()
  return db.transaction(() => {
    const inserted = db
      .query(
        `INSERT INTO share_links (id, token_hash, token_hint, link_key,
          workspace_epoch, space_id, document_id, kind, label, level,
          created_by_id, created_by_name, created_at, migrated_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'view', '', '', ?, ?)
         ON CONFLICT (token_hash) DO NOTHING`
      )
      .run(
        id,
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
    if (inserted.changes === 0) return false
    // The earlier version kept the token in the clear; sealed, its URL can
    // still be copied again.
    sealToken(db, id, input.token)
    return true
  })()
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
    forgetTokens(db, stopped)
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
 * Binaries from before links were for everyone serve this store, and stop
 * making links in the earlier version's file, only once this mark is set.
 * Every store with links has it, so running one of them again keeps links
 * opening.
 */
const MARK_V1_DRAINED =
  "INSERT OR IGNORE INTO share_meta (key, value) VALUES ('v1_drained_at', ?)"

/** Note that links of the earlier version were moved here. */
export function markV1SharesDrained(now = Date.now()): void {
  ensureShareUnlockSecret()
  openDatabase(true)!.query(MARK_V1_DRAINED).run(String(now))
}

export interface ShareLinkChange {
  level?: "view" | "comment"
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
  if (change.level !== undefined) set("level",change.level)
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
  forgetTokens(db, [id])
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
  forgetTokens(
    db,
    revoked.map((row) => row.id)
  )
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

/** Current targets for paused links, in one indexed read without link history. */
export function commentLinkTargets(
  linkIds: readonly string[]
): Map<string, { spaceId: string; documentId: string; label: string }> {
  if (!linkIds.length) return new Map()
  const rows =
    openDatabase(false)
      ?.query<
        { id: string; space_id: string; document_id: string; label: string },
        [string]
      >("SELECT id,space_id,document_id,label FROM share_links WHERE id IN (SELECT value FROM json_each(?)) AND revoked_at IS NULL AND level='comment'")
      .all(JSON.stringify(linkIds)) ?? []
  return new Map(
    rows.map((row) => [
      row.id,
      { spaceId: row.space_id, documentId: row.document_id, label: row.label },
    ])
  )
}

/** An indexed existence check for the private Visitors tab, with no link history. */
export function documentHasCommentLink(spaceId: string, documentId: string): boolean {
  return Boolean(openDatabase(false)?.query("SELECT 1 FROM share_links WHERE space_id=? AND document_id=? AND revoked_at IS NULL AND level='comment' LIMIT 1").get(spaceId, documentId))
}

/** Count and next expiry only; never materialize a document's link history. */
export function documentShareLinkSummary(
  spaceId: string,
  documentId: string,
  now = Date.now(),
  maxExpiryDays: number | null = null,
  creatorAllowed: (id: string) => boolean = () => true,
  requirePassword = false,
  allowLive = false,
  levels: readonly ShareLinkLevel[] = ["view"]
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
          number,
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
        AND kind IN ('doc', 'html') AND ((level = 'view' AND ?=1) OR (level = 'comment' AND ?=1))
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
        levels.includes("view") ? 1 : 0,
        sharingPreviewEnabled() && levels.includes("comment") ? 1 : 0,
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
      // Older binaries revoke without deleting seals; none outlives its link.
      try { db.exec("DELETE FROM share_link_tokens WHERE link_id NOT IN (SELECT id FROM share_links WHERE revoked_at IS NULL)") }
      catch (error) {
        if (!(error instanceof Error) || error.message !== NO_TOKEN_TABLE) throw error
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
 * Record access earlier versions saved and this one no longer has: links
 * that showed only totals, or only saved reads. A policy that allowed no more
 * than those allows no live Records now. Links themselves keep opening.
 */
const REMOVED_RECORD_ACCESS = new Set<unknown>(["summaries", "fixed"])

/**
 * Settings earlier versions saved and this one dropped: whether sharers could
 * let visitors see every comment on a link. Visitors now see only their own,
 * so the setting is ignored rather than read as a later version's.
 */
const REMOVED_POLICY_KEYS = ["allowVisitorsSeeAll"] as const

/**
 * A saved policy this binary can't read, such as one a later version saved
 * with settings it doesn't know, stops every link until an owner saves the
 * policy again here.
 */
function parsePolicy(text: string): SharingPolicy {
  try {
    const saved: unknown = JSON.parse(text)
    if (saved !== null && typeof saved === "object" && !Array.isArray(saved)) {
      const fields = saved as Record<string, unknown>
      if (REMOVED_RECORD_ACCESS.has(fields.records)) fields.records = "none"
      for (const key of REMOVED_POLICY_KEYS) delete fields[key]
    }
    return SharingPolicySchema.parse(saved)
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
