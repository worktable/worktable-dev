import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import type { VisitorCommentsCheckpoint } from "@worktable/hosted-contract"
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { nanoid } from "nanoid"
import type { VisitorCommentStatus } from "@worktable/types"
import { getAppDir } from "./app-storage.ts"
import { getWorkspaceRoot, workspaceCacheKey } from "./workspace.ts"

// Visitor text never enters the portable workspace, ordinary activity, search
// or annotations. Readers are reached only through the person boundary or
// authenticated, capability-scoped visitor routes.
const HOUR = 3_600_000
const DAY = 24 * HOUR
interface StoreConnections {
  reader: Database | null
  writer: Database | null
  retry: number
}
const stores = new Map<string, StoreConnections>()
let writesHeld = 0
let visitorGeneration = 0
export function visitorCommentGeneration(): number {
  return visitorGeneration
}
const changeListeners = new Set<() => void>()

/** Private backup notifications carry no visitor content or document events. */
export function onVisitorCommentStoreChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}
function notifyStoreChange(): void {
  visitorGeneration += 1
  for (const listener of changeListeners) {
    try {
      listener()
    } catch {
      /* The deferred backup audit recovers missed reports. */
    }
  }
}

export class VisitorCommentsUnavailable extends Error {}
export class VisitorCommentRefused extends Error {
  readonly status: 409 | 429
  readonly code: "COMMENTS_PAUSED" | "COMMENTS_LIMIT"
  readonly retryAfter: number
  constructor(paused: boolean, retryAfter = 60) {
    super(paused ? "Comments are paused for this link." : "Try again later.")
    this.status = paused ? 409 : 429
    this.code = paused ? "COMMENTS_PAUSED" : "COMMENTS_LIMIT"
    this.retryAfter = retryAfter
  }
}

/** Resolve existing parents too, so a not-yet-created app directory or a
 * symlinked parent cannot put this private store inside the workspace. */
function physicalPath(path: string): string {
  let parent = resolve(path)
  const tail: string[] = []
  while (true) {
    try {
      // lstat sees a dangling symlink too: never mistake it for a safe new file.
      lstatSync(parent)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new VisitorCommentsUnavailable()
    }
    const next = dirname(parent)
    if (next === parent) throw new VisitorCommentsUnavailable()
    tail.unshift(relative(next, parent))
    parent = next
  }
  try {
    return join(realpathSync(parent), ...tail)
  } catch {
    throw new VisitorCommentsUnavailable()
  }
}

function storePath(): string {
  const app = physicalPath(getAppDir())
  const root = physicalPath(getWorkspaceRoot())
  const path = physicalPath(
    join(app, "visitor-comments", workspaceCacheKey(), "comments.sqlite")
  )
  const within = relative(root, path)
  if (
    !within ||
    (!isAbsolute(within) &&
      within !== ".." &&
      !within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  )
    throw new VisitorCommentsUnavailable(
      "Visitor comments need storage outside the workspace"
    )
  return path
}

function rememberStore(key: string, entry: StoreConnections): void {
  stores.delete(key)
  stores.set(key, entry)
  while (stores.size > 8) {
    const oldest = stores.keys().next().value!
    stores.get(oldest)?.reader?.close()
    stores.get(oldest)?.writer?.close()
    stores.delete(oldest)
  }
}

/** A WAL connection may create sidecars even when the main DB is read-only.
 * The private store uses rollback journaling; cold reads refuse legacy WAL
 * until boot or an explicit writer finishes recovery outside the read path. */
function requireReadOnlyFile(path: string): void {
  const header = Buffer.alloc(20)
  const file = openSync(path, "r")
  try {
    if (
      readSync(file, header, 0, 20, 0) !== 20 ||
      header.toString("ascii", 0, 16) !== "SQLite format 3\0" ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      throw new VisitorCommentsUnavailable()
  } finally {
    closeSync(file)
  }
}

function database(create = false): Database | null {
  if (create && writesHeld) throw new VisitorCommentsUnavailable()
  const key = `${getAppDir()}\0${getWorkspaceRoot()}\0${workspaceCacheKey()}`
  const cached = stores.get(key)
  if (create && cached?.writer) return cached.writer
  if (
    !create &&
    (cached?.reader || (cached && !cached.writer && cached.retry > Date.now()))
  )
    return cached.reader
  const path = storePath()
  if (!create && !existsSync(path)) {
    rememberStore(key, {
      reader: null,
      writer: null,
      retry: Date.now() + 60_000,
    })
    return null
  }
  let db: Database | undefined
  try {
    if (!create) requireReadOnlyFile(path)
    else {
      cached?.reader?.close()
      if (cached) cached.reader = null
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    }
    db = create
      ? new Database(path, { create: true })
      : new Database(path, { readonly: true, create: false })
    const version = (
      db.query("PRAGMA user_version").get() as { user_version: number }
    ).user_version
    if (version !== 1 && version !== 2 && !(create && version === 0))
      throw new VisitorCommentsUnavailable()
    if (create) {
      chmodSync(path, 0o600)
      const previous = (
        db.query("PRAGMA journal_mode").get() as { journal_mode: string }
      ).journal_mode
      db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY"
      )
      if (
        (
          db.query("PRAGMA journal_mode=DELETE").get() as {
            journal_mode: string
          }
        ).journal_mode !== "delete"
      )
        throw new VisitorCommentsUnavailable()
      initializeVisitorCommentDatabase(db, version)
      // Forget free pages and historical WAL text from the preview's old format.
      if (previous === "wal") db.exec("VACUUM")
    } else
      db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA query_only=ON; PRAGMA temp_store=MEMORY"
      )
    rememberStore(key, {
      reader: create ? null : db,
      writer: create ? db : (cached?.writer ?? null),
      retry: Infinity,
    })
    return db
  } catch (error) {
    db?.close()
    if (error instanceof VisitorCommentsUnavailable) throw error
    throw new VisitorCommentsUnavailable("Visitor comments are unavailable")
  }
}

/** One schema owner for live stores and scoped operator snapshots. */
export function initializeVisitorCommentDatabase(
  db: Database,
  version: number
): void {
  if (version === 0)
    db.transaction(() => {
      db!.exec(`CREATE TABLE visitor_comments (
      id TEXT PRIMARY KEY, worktableId TEXT NOT NULL, link_id TEXT NOT NULL,
      link_label TEXT NOT NULL, link_creator TEXT NOT NULL, document_id TEXT NOT NULL,
      space_at_receipt TEXT NOT NULL, kind TEXT NOT NULL, visitor_name TEXT,
      visitor_key TEXT NOT NULL, client_key TEXT, body TEXT, received_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('new','done','passed','deleted')),
      passed_by TEXT, passed_name TEXT, passed_at INTEGER, annotation_id TEXT,
      deleted_by TEXT, deleted_at INTEGER, request_id TEXT NOT NULL,
      UNIQUE(worktableId, link_id, visitor_key, request_id));
      CREATE INDEX comments_document ON visitor_comments(worktableId, document_id, received_at DESC, id);
      CREATE INDEX comments_link ON visitor_comments(worktableId, link_id, received_at DESC, id);
      CREATE INDEX comments_day ON visitor_comments(worktableId, received_at);
      CREATE INDEX comments_pending ON visitor_comments(worktableId, link_id, status);
      CREATE TABLE visitor_replies(id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES visitor_comments(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX replies_comment ON visitor_replies(comment_id, created_at);
      CREATE TABLE visitor_link_state(worktableId TEXT NOT NULL, link_id TEXT NOT NULL, paused TEXT, PRIMARY KEY(worktableId,link_id));
      CREATE TABLE visitor_cap_hits(worktableId TEXT NOT NULL, link_id TEXT NOT NULL, client_key TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY(worktableId,link_id,client_key));
      PRAGMA user_version=1;`)
    }).immediate()

  if (version < 2)
    db.transaction(() => {
      db!.exec(
        "CREATE TABLE visitor_meta(id INTEGER PRIMARY KEY CHECK(id=1),incarnation TEXT NOT NULL,revision INTEGER NOT NULL)"
      )
      db!
        .query("INSERT INTO visitor_meta VALUES(1,?,0)")
        .run(randomBytes(16).toString("hex"))
      for (const table of [
        "visitor_comments",
        "visitor_replies",
        "visitor_link_state",
        "visitor_cap_hits",
      ])
        for (const operation of ["INSERT", "UPDATE", "DELETE"])
          db!.exec(
            `CREATE TRIGGER ${table}_${operation.toLowerCase()}_revision AFTER ${operation} ON ${table} BEGIN UPDATE visitor_meta SET revision=revision+1 WHERE id=1; END`
          )
      db!.exec("PRAGMA user_version=2")
    }).immediate()
}

/** Existing private state is recovered at boot; this never creates a store. */
export function prepareVisitorCommentStore(): void {
  if (existsSync(storePath())) database(true)
}

export function visitorCommentStoreFile(): string {
  return storePath()
}

function checkpoint(db: Database): VisitorCommentsCheckpoint {
  const value = db
    .query("SELECT incarnation,revision FROM visitor_meta WHERE id=1")
    .get() as VisitorCommentsCheckpoint | null
  if (
    !value ||
    !/^[a-f0-9]{32}$/.test(value.incarnation) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new VisitorCommentsUnavailable()
  return value
}

/** A logical fence survives restarts and covers replies, pauses and erasure. */
export function visitorCommentsCheckpoint(): VisitorCommentsCheckpoint | null {
  const db = database()
  return db ? checkpoint(db) : null
}

/** Replacement holds this across its last fence and private-state publication. */
export function holdVisitorCommentWrites(): () => void {
  writesHeld += 1
  try {
    closeVisitorCommentStores()
  } catch (error) {
    writesHeld -= 1
    throw error
  }
  let released = false
  return () => {
    if (!released) {
      released = true
      writesHeld -= 1
    }
  }
}

// The portable Worktable ID is retained by operator restore.
// The service separately fences requests with the machine collaboration epoch.
export interface StoredVisitorComment {
  id: string
  worktableId: string
  link_id: string
  link_label: string
  link_creator: string
  document_id: string
  space_at_receipt: string
  kind: string
  visitor_name: string | null
  visitor_key: string
  client_key: string | null
  body: string | null
  received_at: number
  status: VisitorCommentStatus
  passed_by: string | null
  passed_name: string | null
  passed_at: number | null
  annotation_id: string | null
  deleted_by: string | null
  deleted_at: number | null
  request_id: string
}
export interface StoredVisitorReply {
  id: string
  comment_id: string
  author_id: string
  author_name: string
  body: string
  created_at: number
}
export function cleanVisitorText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, (char) =>
      char === "\n" ? char : ""
    )
    .trim()
}
export function commentPause(
  worktableId: string,
  linkId: string
): string | null {
  return (
    (
      database()
        ?.query(
          "SELECT paused FROM visitor_link_state WHERE worktableId=? AND link_id=?"
        )
        .get(worktableId, linkId) as { paused: string | null } | null
    )?.paused ?? null
  )
}
export function pauseVisitorComments(
  worktableId: string,
  linkId: string,
  paused: boolean
): void {
  database(true)!
    .query(
      "INSERT INTO visitor_link_state(worktableId,link_id,paused) VALUES(?,?,?) ON CONFLICT(worktableId,link_id) DO UPDATE SET paused=excluded.paused"
    )
    .run(worktableId, linkId, paused ? "sharer" : null)
  notifyStoreChange()
}

export function receiveVisitorComment(input: {
  worktableId: string
  linkId: string
  linkLabel: string
  linkCreator: string
  documentId: string
  spaceId: string
  kind: string
  visitorName: string | null
  visitorKey: string
  clientKey: string
  body: string
  requestId: string
}): { id: string; receivedAt: string } {
  const db = database(true)!
  let wrote = false
  // Refusals are values until the transaction commits: a cap can also pause
  // the link. Throwing inside would roll that abuse control back.
  const result = db
    .transaction(() => {
      const prior = db
        .query(
          "SELECT id,received_at FROM visitor_comments WHERE worktableId=? AND link_id=? AND visitor_key=? AND request_id=?"
        )
        .get(
          input.worktableId,
          input.linkId,
          input.visitorKey,
          input.requestId
        ) as {
        id: string
        received_at: number
      } | null
      if (prior)
        return {
          id: prior.id,
          receivedAt: new Date(prior.received_at).toISOString(),
        }
      if (commentPause(input.worktableId, input.linkId))
        return new VisitorCommentRefused(true)
      const now = Date.now()
      const totals = db
        .query(
          `SELECT count(*) AS workspaceDay,
      coalesce(sum(link_id=?),0) AS linkDay,
      coalesce(sum(link_id=? AND received_at>?),0) AS linkHour,
      coalesce(sum(link_id=? AND received_at>?),0) AS linkTen,
      coalesce(sum(link_id=? AND client_key=? AND received_at>?),0) AS clientTen,
      coalesce(sum(visitor_key=?),0) AS visitorDay
      FROM visitor_comments WHERE worktableId=? AND received_at>?`
        )
        .get(
          input.linkId,
          input.linkId,
          now - HOUR,
          input.linkId,
          now - 600_000,
          input.linkId,
          input.clientKey,
          now - 600_000,
          input.visitorKey,
          input.worktableId,
          now - DAY
        ) as {
        workspaceDay: number
        linkDay: number
        linkHour: number
        linkTen: number
        clientTen: number
        visitorDay: number
      }
      const pending = (
        db
          .query(
            "SELECT count(*) AS n FROM visitor_comments WHERE worktableId=? AND link_id=? AND status='new'"
          )
          .get(input.worktableId, input.linkId) as { n: number }
      ).n
      let spike = totals.linkTen >= 30
      if (totals.clientTen >= 5) {
        db.query(
          "INSERT INTO visitor_cap_hits VALUES(?,?,?,?) ON CONFLICT(worktableId,link_id,client_key) DO UPDATE SET at=excluded.at"
        ).run(input.worktableId, input.linkId, input.clientKey, now)
        wrote = true
        spike ||=
          (
            db
              .query(
                "SELECT count(*) AS n FROM visitor_cap_hits WHERE worktableId=? AND link_id=? AND at>?"
              )
              .get(input.worktableId, input.linkId, now - 600_000) as {
              n: number
            }
          ).n > 3
      }
      if (spike) {
        db.query(
          "INSERT INTO visitor_link_state VALUES(?,?,'spike') ON CONFLICT(worktableId,link_id) DO UPDATE SET paused='spike'"
        ).run(input.worktableId, input.linkId)
        wrote = true
      }
      if (
        spike ||
        totals.workspaceDay >= 500 ||
        totals.linkDay >= 200 ||
        totals.linkHour >= 30 ||
        totals.clientTen >= 5 ||
        totals.visitorDay >= 20 ||
        pending >= 500
      )
        return new VisitorCommentRefused(
          false,
          totals.clientTen >= 5 ? 600 : 3600
        )
      const id = `vc_${nanoid(22)}`
      db.query(
        `INSERT INTO visitor_comments(id,worktableId,link_id,link_label,link_creator,document_id,space_at_receipt,kind,visitor_name,visitor_key,client_key,body,received_at,status,request_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?)`
      ).run(
        id,
        input.worktableId,
        input.linkId,
        input.linkLabel,
        input.linkCreator,
        input.documentId,
        input.spaceId,
        input.kind,
        input.visitorName,
        input.visitorKey,
        input.clientKey,
        input.body,
        now,
        input.requestId
      )
      wrote = true
      return { id, receivedAt: new Date(now).toISOString() }
    })
    .immediate()
  if (wrote) notifyStoreChange()
  if (result instanceof VisitorCommentRefused) throw result
  return result
}

export function readVisitorComment(
  worktableId: string,
  id: string
): StoredVisitorComment | null {
  return (
    (database()
      ?.query("SELECT * FROM visitor_comments WHERE worktableId=? AND id=?")
      .get(worktableId, id) as StoredVisitorComment | null) ?? null
  )
}

/** One grouped private read for a person's Pending, never ordinary activity. */
export function pendingVisitorCommentGroups(worktableId: string): Array<{
  document_id: string
  space_at_receipt: string
  link_id: string
  link_label: string
  link_creator: string
  at: number
  count: number
  paused: "sharer" | "spike" | null
}> {
  return (database()
    ?.query(
      `WITH receipts AS (
      SELECT worktableId,document_id,link_id,link_label,link_creator,space_at_receipt,received_at,status,
        row_number() OVER (PARTITION BY document_id,link_id,link_creator ORDER BY received_at DESC,id DESC) AS position
      FROM visitor_comments WHERE worktableId=? AND status!='deleted'
    ) SELECT c.document_id,c.link_id,c.link_creator,
    max(CASE WHEN c.position=1 THEN c.link_label END) AS link_label,
    max(CASE WHEN c.position=1 THEN c.space_at_receipt END) AS space_at_receipt,
    max(c.received_at) AS at,sum(c.status='new') AS count,s.paused
    FROM receipts c LEFT JOIN visitor_link_state s ON s.worktableId=c.worktableId AND s.link_id=c.link_id
    GROUP BY c.document_id,c.link_id,c.link_creator HAVING count>0 OR s.paused IS NOT NULL
    ORDER BY at DESC LIMIT 2000`
    )
    .all(worktableId) ?? []) as ReturnType<typeof pendingVisitorCommentGroups>
}
export function visitorCommentRows(input: {
  worktableId: string
  linkId?: string
  documentId?: string
  visitorKey?: string
  before?: { receivedAt: number; id: string }
  limit?: number
}): StoredVisitorComment[] {
  const db = database()
  if (!db || (!input.linkId && !input.documentId)) return []
  const where = ["worktableId=?", "status!='deleted'", "body IS NOT NULL"]
  const args: (string | number)[] = [input.worktableId]
  for (const [column, value] of [
    ["link_id", input.linkId],
    ["document_id", input.documentId],
    ["visitor_key", input.visitorKey],
  ] as const)
    if (value !== undefined) {
      where.push(`${column}=?`)
      args.push(value)
    }
  if (input.before !== undefined) {
    where.push("(received_at,id)<(?,?)")
    args.push(input.before.receivedAt, input.before.id)
  }
  args.push(Math.min(101, Math.max(1, input.limit ?? 100)))
  return db
    .query(
      `SELECT * FROM visitor_comments WHERE ${where.join(" AND ")} ORDER BY received_at DESC,id DESC LIMIT ?`
    )
    .all(...args) as StoredVisitorComment[]
}
export function visitorReplies(ids: string[]): StoredVisitorReply[] {
  if (!ids.length || ids.length > 100) return []
  return (
    (database()
      ?.query(
        `SELECT id,comment_id,author_id,author_name,body,created_at FROM (
          SELECT *,row_number() OVER (PARTITION BY comment_id ORDER BY created_at DESC,id DESC) AS position
          FROM visitor_replies WHERE comment_id IN (${ids.map(() => "?").join(",")})
        ) WHERE position<=20 ORDER BY created_at,id`
      )
      .all(...ids) as StoredVisitorReply[]) ?? []
  )
}
export function appendVisitorReply(
  worktableId: string,
  id: string,
  author: { id: string; name: string },
  body: string
): void {
  const db = database(true)!
  db.transaction(() => {
    if (
      !readVisitorComment(worktableId, id) ||
      readVisitorComment(worktableId, id)!.status === "deleted"
    )
      throw new VisitorCommentsUnavailable()
    if (
      (
        db
          .query("SELECT count(*) AS n FROM visitor_replies WHERE comment_id=?")
          .get(id) as { n: number }
      ).n >= 100
    )
      throw new VisitorCommentRefused(false, 3600)
    db.query("INSERT INTO visitor_replies VALUES(?,?,?,?,?,?)").run(
      `vr_${nanoid(22)}`,
      id,
      author.id,
      author.name,
      body,
      Date.now()
    )
  }).immediate()
  notifyStoreChange()
}
export function finishVisitorComment(
  worktableId: string,
  id: string,
  deletedBy?: string
): void {
  const db = database(true)!
  let writes = 0
  if (deletedBy)
    db.transaction(() => {
      writes += db
        .query(
          "DELETE FROM visitor_replies WHERE comment_id IN (SELECT id FROM visitor_comments WHERE worktableId=? AND id=?)"
        )
        .run(worktableId, id).changes
      writes += db
        .query(
          "UPDATE visitor_comments SET status='deleted',body=NULL,visitor_name=NULL,deleted_by=?,deleted_at=? WHERE worktableId=? AND id=? AND status!='deleted'"
        )
        .run(deletedBy, Date.now(), worktableId, id).changes
    }).immediate()
  else
    writes += db
      .query(
        "UPDATE visitor_comments SET status='done' WHERE worktableId=? AND id=? AND status='new'"
      )
      .run(worktableId, id).changes
  if (writes) notifyStoreChange()
}

/** The ordinary annotation is durable before this private receipt changes. */
export function markVisitorCommentPassed(
  worktableId: string,
  id: string,
  passed: {
    annotationId: string
    by: { id: string; name: string }
    at: string
  }
): void {
  const changed = database(true)!
    .query(
      "UPDATE visitor_comments SET status='passed',annotation_id=?,passed_by=?,passed_name=?,passed_at=? WHERE worktableId=? AND id=? AND status!='deleted'"
    )
    .run(
      passed.annotationId,
      passed.by.id,
      passed.by.name,
      Date.parse(passed.at),
      worktableId,
      id
    )
  if (!changed.changes) throw new VisitorCommentsUnavailable()
  notifyStoreChange()
}

export interface VisitorCommentRetentionChange {
  worktableId: string
  spaceId: string
  documentId: string
  linkId: string
}

/** Called only at boot and daily, never by a view or a comment request. */
export function sweepVisitorComments(
  now = Date.now()
): VisitorCommentRetentionChange[] {
  if (writesHeld || !database()) return []
  const db = database(true)!
  let writes = 0
  let changed: VisitorCommentRetentionChange[] = []
  db.transaction(() => {
    changed = db
      .query<VisitorCommentRetentionChange, [number, number]>(
        `SELECT DISTINCT worktableId,space_at_receipt AS spaceId,document_id AS documentId,link_id AS linkId
       FROM visitor_comments WHERE
       (status IN ('new','done') AND received_at<?) OR
       (status='passed' AND (body IS NOT NULL OR visitor_name IS NOT NULL) AND passed_at<?)`
      )
      .all(now - 180 * DAY, now - 30 * DAY)
    writes += db
      .query(
        "UPDATE visitor_comments SET client_key=NULL WHERE client_key IS NOT NULL AND received_at<?"
      )
      .run(now - 7 * DAY).changes
    writes += db
      .query(
        "UPDATE visitor_comments SET body=NULL,visitor_name=NULL WHERE status='passed' AND (body IS NOT NULL OR visitor_name IS NOT NULL) AND passed_at<?"
      )
      .run(now - 30 * DAY).changes
    writes += db
      .query(
        "DELETE FROM visitor_replies WHERE comment_id IN (SELECT id FROM visitor_comments WHERE status='passed' AND passed_at<?)"
      )
      .run(now - 30 * DAY).changes
    writes += db
      .query(
        "DELETE FROM visitor_comments WHERE (status IN ('new','done') AND received_at<?) OR (status='deleted' AND deleted_at<?)"
      )
      .run(now - 180 * DAY, now - 30 * DAY).changes
    writes += db
      .query("DELETE FROM visitor_cap_hits WHERE at<?")
      .run(now - 600_000).changes
  }).immediate()
  if (writes) notifyStoreChange()
  return changed
}
export function closeVisitorCommentStores(): void {
  for (const entry of stores.values()) {
    entry.reader?.close()
    entry.writer?.close()
  }
  stores.clear()
}
