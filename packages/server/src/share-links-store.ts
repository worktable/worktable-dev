import { Database } from "bun:sqlite"
import type { ShareLinkCommentSettings, ShareLinkKind } from "@worktable/types"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { getAppDir } from "./app-storage.ts"
import { sharingPreviewEnabled } from "./sharing-preview.ts"
import { workspaceCacheKey } from "./workspace.ts"

// ============================================================
// Share links (v2)
// ============================================================
//
// Links live in <appDir>/sharing/<workspace>/sharing.sqlite, outside the
// workspace and outside backups. A link is keyed by its document's durable
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

const LINK_COLUMNS = `id, token_hash, token_hint, workspace_epoch, space_id,
  document_id, kind, label, level, created_by_id, created_by_name, created_at,
  expires_at, password_hash, grant_json, pinned_version, accept_comments,
  anonymous_allowed, visitors_see, show_sharer_name, revoked_at,
  revoked_reason, last_used_at, migrated_from`

const flag = (value: number): boolean | null =>
  value === 0 ? false : value === 1 ? true : null

/**
 * Passwords, grants, pinned versions and levels above view come with later
 * binaries; a link that sets any of them is never served here. Comment
 * settings apply only from the comment level, but must still be ones this
 * binary knows.
 */
function servable(row: LinkRow): boolean {
  return (
    (row.kind === "doc" || row.kind === "html") &&
    row.level === "view" &&
    row.password_hash === null &&
    row.grant_json === null &&
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
}

// ── Whether links v2 is on ───────────────────────────────────

let drained: { key: string; value: boolean; checkedAt: number } | null = null
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
    (drained.value || now - drained.checkedAt < DRAINED_RECHECK_MS)
  ) {
    return drained.value
  }
  let value = false
  try {
    value =
      openDatabase(false)
        ?.query<
          { value: string },
          [string]
        >("SELECT value FROM share_meta WHERE key = ?")
        .get("v1_drained_at") != null
  } catch {
    // An unreadable store serves nothing either way.
  }
  drained = { key, value, checkedAt: now }
  return value
}

// ── Tokens ───────────────────────────────────────────────────

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest()
}

function newLinkId(): string {
  return `lnk_${randomBytes(16).toString("base64url")}`
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
  now?: number
}

/** Store a new link. The token is returned here and never again. */
export function createShareLink(input: NewShareLink): {
  link: StoredShareLink
  token: string
} {
  const db = openDatabase(true)!
  const token = randomBytes(32).toString("base64url")
  const id = newLinkId()
  db.query(
    `INSERT INTO share_links (id, token_hash, token_hint, link_key,
      workspace_epoch, space_id, document_id, kind, label, level,
      created_by_id, created_by_name, created_at, expires_at,
      accept_comments, anonymous_allowed, show_sharer_name, visitors_see)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    input.comments.visitorsSee
  )
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
 * too. Those in `moved`, which the caller is about to remove from the file,
 * have moved for good.
 */
export function settleV1ShareLinks(
  present: readonly string[],
  moved: readonly string[]
): void {
  const db = openDatabase(false)
  if (!db) return
  const inFile = new Set(
    present.map((token) => tokenDigest(token).toString("hex"))
  )
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
  })()
  if (stopped.length > 0) notifyChanged(stopped)
}

/**
 * Note that links of the earlier version were moved here. From then on this
 * store serves links whatever the sharing preview says.
 */
export function markV1SharesDrained(now = Date.now()): void {
  openDatabase(true)!
    .query(
      "INSERT OR IGNORE INTO share_meta (key, value) VALUES ('v1_drained_at', ?)"
    )
    .run(String(now))
  drained = { key: workspaceCacheKey(), value: true, checkedAt: now }
}

export interface ShareLinkChange {
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
    db.query(
      `UPDATE share_links SET ${sets.join(", ")}
       WHERE id = ? AND revoked_at IS NULL`
    ).run(...values, id)
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
 * The link a token opens: one indexed SELECT, no lock and no file read. The
 * caller checks revocation, epoch and expiry.
 */
export function findShareLinkByToken(token: string): StoredShareLink | null {
  if (!TOKEN_PATTERN.test(token)) return null
  const db = openDatabase(false)
  if (!db) return null
  const digest = tokenDigest(token)
  const row = db
    .query<
      LinkRow,
      [Buffer]
    >(`SELECT ${LINK_COLUMNS} FROM share_links WHERE token_hash = ?`)
    .get(digest)
  if (!row) return null
  const stored = Buffer.from(row.token_hash)
  if (stored.length !== digest.length || !timingSafeEqual(stored, digest)) {
    return null
  }
  return storedLink(row)
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

/**
 * How many of a document's links still open: neither revoked nor expired.
 * One statement on the document index, and none before a link exists.
 */
export function countOpenDocumentShareLinks(
  spaceId: string,
  documentId: string,
  now = Date.now()
): number {
  return listDocumentShareLinks(spaceId, documentId).filter(
    (link) => link.servable && (link.expiresAt === null || link.expiresAt > now)
  ).length
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
