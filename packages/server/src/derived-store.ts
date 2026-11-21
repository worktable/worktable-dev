// ============================================================
// What Worktable derives from files, kept outside the workspace
// ============================================================
//
// Contents (text in located parts, with facts and what is missing) and
// pictures made from one version of an item, by one version of a reader or
// picture maker. Kept in app data, one SQLite file per workspace, so it is
// never backed up or exported, is never the only copy of anything, and is
// made again from the files when lost. It is counted as derived output,
// which falls under the Worktable's total storage limit, not the limit on
// people's files (storage-limit.ts).
//
// Rows are keyed by the item's identity, the version they were made from
// (the content hash of a file's bytes), what they are, their variant (a
// picture's size and page), and their maker and its version, so output from
// another version or an older maker never answers. A failure is kept too,
// so a file that can't be read isn't tried again on every read.
//
// The store has no address of its own and checks no access: every read
// starts from an item its caller resolved with its access check, by the
// identity and version that gives. A deleted item can't be resolved, so its
// output can't be read from that moment; the sweep then removes it, for a
// Space as its documents change and for every Space after start.

import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { getAppDir } from "./app-storage.ts"
import type { ContentsGap, ContentsOutput, ContentsRefusal } from "./contents-protocol.ts"
import { CONTENTS_DEFAULT_LINES, CONTENTS_PAGE_MAX_BYTES } from "./file-contents-limits.ts"
import { noteStorageChange } from "./storage-usage.ts"
import { workspaceCacheKey } from "./workspace.ts"

/** Where a workspace's derived output is kept. */
export function derivedStoreDir(appDir = getAppDir(), key = workspaceCacheKey()): string {
  return join(appDir, "derived", key)
}

/** Contents, a picture, or a rendition: a file drawn as another, a Word file as a PDF. */
export type DerivedKind = "contents" | "picture" | "rendition"

/** Everything that shaped one output. */
export interface DerivedKey {
  spaceId: string
  documentId: string
  /** The version it was made from: a file's content hash. */
  version: string
  kind: DerivedKind
  /** Options that change it, such as a picture's width and page; "" for none. */
  variant: string
  maker: string
  makerVersion: number
}

/** How making an output ended. */
export type DerivedState =
  | { state: "ready" }
  | { state: "refused"; reason: ContentsRefusal; message: string }
  | { state: "failed"; message: string }

export type StoredContents = DerivedState & {
  facts: ContentsOutput["facts"]
  missing: ContentsGap[]
  totalLines: number
  /** Each part's label and the line its mark is on. */
  outline: { label: string; line: number }[]
}

export type StoredPicture = DerivedState & {
  mimeType?: string
  bytes?: Uint8Array
  /** The bytes' SHA-256, hex, for the response that serves them. */
  sha256?: string
}

export interface ContentsLines {
  text: string
  startLine: number
  endLine: number
  totalLines: number
  nextOffset?: number
  /** A line longer than a page, cut at the page's limit. */
  cutLine?: number
}

/** A change to the store, for those that keep their own view of it. */
export interface DerivedChange {
  spaceId: string
  documentId: string
  version?: string
  kind?: DerivedKind
  change: "stored" | "removed"
}

const listeners = new Set<(change: DerivedChange) => void>()

/** Hears every output stored or removed. Returns how to stop. */
export function onDerivedChange(listener: (change: DerivedChange) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function announce(change: DerivedChange): void {
  for (const listener of listeners) {
    try {
      listener(change)
    } catch {
      // One listener's failure never stops the others or the write.
    }
  }
}

const SCHEMA_VERSION = 1

/**
 * A part as the page shows it: a line marking where it starts, then its
 * text. The mark is a Markdown comment, so a file's own headings, which a
 * reader keeps as Markdown, stay as they are.
 */
function partLines(label: string, text: string): string[] {
  const lines = text.length === 0 ? [] : text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return [`<!-- ${label.replaceAll("--", "- -")} -->`, ...lines]
}

/** At most `maxBytes` of a line, ending on a whole character. */
function cutLine(line: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(line)
  if (bytes.byteLength <= maxBytes) return line
  return new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�+$/u, "")
}

export class DerivedStore {
  readonly path: string
  #db: Database | null = null

  constructor(dir = derivedStoreDir()) {
    this.path = join(dir, "derived.sqlite")
  }

  #open(): Database {
    if (this.#db) return this.#db
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const db = new Database(this.path, { create: true })
    // Space freed by removed output goes back to the disk (reclaim): the
    // store counts toward the Worktable's storage. The mode is set before
    // any table exists, or on an older file with one rewrite.
    const vacuum = (db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum
    if (vacuum !== 2) {
      db.run("PRAGMA auto_vacuum = INCREMENTAL")
      db.run("VACUUM")
    }
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA foreign_keys = ON")
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    if (version !== SCHEMA_VERSION) {
      // Derived output is made again from the files: an older layout goes.
      db.run("DROP TABLE IF EXISTS parts")
      db.run("DROP TABLE IF EXISTS blobs")
      db.run("DROP TABLE IF EXISTS outputs")
    }
    db.run(
      "CREATE TABLE IF NOT EXISTS outputs (" +
        "id INTEGER PRIMARY KEY, space_id TEXT NOT NULL, document_id TEXT NOT NULL, " +
        "version TEXT NOT NULL, kind TEXT NOT NULL, variant TEXT NOT NULL, " +
        "maker TEXT NOT NULL, maker_version INTEGER NOT NULL, state TEXT NOT NULL, " +
        "reason TEXT, message TEXT, facts TEXT NOT NULL DEFAULT '{}', " +
        "missing TEXT NOT NULL DEFAULT '[]', total_lines INTEGER NOT NULL DEFAULT 0, " +
        "made_at INTEGER NOT NULL, " +
        "UNIQUE (document_id, version, kind, variant, maker, maker_version))"
    )
    db.run("CREATE INDEX IF NOT EXISTS outputs_space ON outputs (space_id, document_id)")
    db.run(
      "CREATE TABLE IF NOT EXISTS parts (" +
        "output_id INTEGER NOT NULL REFERENCES outputs (id) ON DELETE CASCADE, " +
        "seq INTEGER NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL, " +
        "line_start INTEGER NOT NULL, line_count INTEGER NOT NULL, " +
        "PRIMARY KEY (output_id, seq))"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS blobs (" +
        "output_id INTEGER PRIMARY KEY REFERENCES outputs (id) ON DELETE CASCADE, " +
        "mime_type TEXT NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL)"
    )
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    this.#db = db
    return db
  }

  #noteWrite(): void {
    noteStorageChange(this.path)
    noteStorageChange(`${this.path}-wal`)
  }

  /** Gives the pages removed output held back to the disk. */
  #reclaim(): void {
    const db = this.#open()
    db.run("PRAGMA incremental_vacuum")
    db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  }

  #outputId(key: DerivedKey): number | null {
    const row = this.#open()
      .query(
        "SELECT id FROM outputs WHERE document_id = ? AND version = ? AND kind = ? " +
          "AND variant = ? AND maker = ? AND maker_version = ?"
      )
      .get(key.documentId, key.version, key.kind, key.variant, key.maker, key.makerVersion) as
      | { id: number }
      | null
    return row?.id ?? null
  }

  /** Writes one output whole, in place of any with the same key. */
  #put(key: DerivedKey, state: DerivedState, fill: (db: Database, id: number) => {
    facts?: ContentsOutput["facts"]
    missing?: ContentsGap[]
    totalLines?: number
  }): void {
    const db = this.#open()
    db.transaction(() => {
      db.query(
        "DELETE FROM outputs WHERE document_id = ? AND version = ? AND kind = ? " +
          "AND variant = ? AND maker = ? AND maker_version = ?"
      ).run(key.documentId, key.version, key.kind, key.variant, key.maker, key.makerVersion)
      const inserted = db
        .query(
          "INSERT INTO outputs (space_id, document_id, version, kind, variant, maker, " +
            "maker_version, state, reason, message, made_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
        )
        .get(
          key.spaceId,
          key.documentId,
          key.version,
          key.kind,
          key.variant,
          key.maker,
          key.makerVersion,
          state.state,
          state.state === "refused" ? state.reason : null,
          state.state === "ready" ? null : state.message,
          Date.now()
        ) as { id: number }
      const summary = fill(db, inserted.id)
      db.query("UPDATE outputs SET facts = ?, missing = ?, total_lines = ? WHERE id = ?").run(
        JSON.stringify(summary.facts ?? {}),
        JSON.stringify(summary.missing ?? []),
        summary.totalLines ?? 0,
        inserted.id
      )
    })()
    this.#noteWrite()
    announce({
      spaceId: key.spaceId,
      documentId: key.documentId,
      version: key.version,
      kind: key.kind,
      change: "stored",
    })
  }

  /** Keeps a reader's output for one version of a file, or why it has none. */
  putContents(key: DerivedKey, result: DerivedState & { output?: ContentsOutput }): void {
    this.#put({ ...key, kind: "contents" }, result, (db, id) => {
      const output = result.output
      if (!output) return {}
      const insert = db.query(
        "INSERT INTO parts (output_id, seq, label, text, line_start, line_count) VALUES (?, ?, ?, ?, ?, ?)"
      )
      let line = 1
      output.parts.forEach((part, seq) => {
        const count = partLines(part.label, part.text).length
        insert.run(id, seq, part.label, part.text, line, count)
        line += count
      })
      return { facts: output.facts, missing: output.gaps, totalLines: line - 1 }
    })
  }

  /** A file's contents as kept, without its text; null when none is kept. */
  getContents(key: DerivedKey): StoredContents | null {
    const db = this.#open()
    const row = db
      .query(
        "SELECT id, state, reason, message, facts, missing, total_lines FROM outputs " +
          "WHERE document_id = ? AND version = ? AND kind = 'contents' AND variant = ? " +
          "AND maker = ? AND maker_version = ?"
      )
      .get(key.documentId, key.version, key.variant, key.maker, key.makerVersion) as {
      id: number
      state: string
      reason: ContentsRefusal | null
      message: string | null
      facts: string
      missing: string
      total_lines: number
    } | null
    if (!row) return null
    const outline = db
      .query("SELECT label, line_start AS line FROM parts WHERE output_id = ? ORDER BY seq")
      .all(row.id) as { label: string; line: number }[]
    const base = {
      facts: JSON.parse(row.facts) as ContentsOutput["facts"],
      missing: JSON.parse(row.missing) as ContentsGap[],
      totalLines: row.total_lines,
      outline,
    }
    if (row.state === "ready") return { state: "ready", ...base }
    if (row.state === "refused")
      return { state: "refused", reason: row.reason ?? "failed", message: row.message ?? "", ...base }
    return { state: "failed", message: row.message ?? "", ...base }
  }

  /**
   * A page of a file's kept contents, by line: each part's mark, then its
   * text, at most `limit` lines and a page's bytes. Reads only the parts the
   * page covers.
   */
  readContentsLines(
    key: DerivedKey,
    offset = 1,
    limit = CONTENTS_DEFAULT_LINES,
    maxBytes = CONTENTS_PAGE_MAX_BYTES
  ): ContentsLines | null {
    const id = this.#outputId({ ...key, kind: "contents" })
    if (id === null) return null
    const db = this.#open()
    const { total_lines: totalLines } = db
      .query("SELECT total_lines FROM outputs WHERE id = ?")
      .get(id) as { total_lines: number }
    const parts = db
      .query(
        "SELECT label, text, line_start, line_count FROM parts WHERE output_id = ? " +
          "AND line_start + line_count > ? AND line_start < ? ORDER BY seq"
      )
      .all(id, offset, offset + limit) as {
      label: string
      text: string
      line_start: number
      line_count: number
    }[]
    const kept: string[] = []
    let bytes = 0
    let endLine = offset - 1
    let cut: number | undefined
    page: for (const part of parts) {
      const lines = partLines(part.label, part.text)
      for (let index = 0; index < lines.length; index += 1) {
        const line = part.line_start + index
        if (line < offset) continue
        if (line >= offset + limit) break page
        const size = new TextEncoder().encode(lines[index]!).byteLength + 1
        if (bytes + size > maxBytes) {
          if (kept.length === 0) {
            kept.push(cutLine(lines[index]!, maxBytes))
            endLine = line
            cut = line
          }
          break page
        }
        kept.push(lines[index]!)
        bytes += size
        endLine = line
      }
    }
    return {
      text: kept.map((line) => `${line}\n`).join(""),
      startLine: offset,
      endLine,
      totalLines,
      ...(endLine < totalLines ? { nextOffset: endLine + 1 } : {}),
      ...(cut !== undefined ? { cutLine: cut } : {}),
    }
  }

  /** Keeps a picture of one version of an item, or why it has none. */
  putPicture(key: DerivedKey, result: DerivedState & { mimeType?: string; bytes?: Uint8Array }): void {
    this.#putBlob({ ...key, kind: "picture" }, result)
  }

  /** A picture as kept, or why there is none; null when nothing is kept. */
  getPicture(key: DerivedKey): StoredPicture | null {
    return this.#getBlob({ ...key, kind: "picture" })
  }

  /** Keeps a file drawn as another for one version of it, or why it has none. */
  putRendition(key: DerivedKey, result: DerivedState & { mimeType?: string; bytes?: Uint8Array }): void {
    this.#putBlob({ ...key, kind: "rendition" }, result)
  }

  /** A rendition as kept, or why there is none; null when nothing is kept. */
  getRendition(key: DerivedKey): StoredPicture | null {
    return this.#getBlob({ ...key, kind: "rendition" })
  }

  #putBlob(key: DerivedKey, result: DerivedState & { mimeType?: string; bytes?: Uint8Array }): void {
    this.#put(key, result, (db, id) => {
      if (result.state === "ready" && result.bytes && result.mimeType) {
        db.query("INSERT INTO blobs (output_id, mime_type, bytes, sha256) VALUES (?, ?, ?, ?)").run(
          id,
          result.mimeType,
          result.bytes,
          createHash("sha256").update(result.bytes).digest("hex")
        )
      }
      return {}
    })
  }

  #getBlob(key: DerivedKey): StoredPicture | null {
    const row = this.#open()
      .query(
        "SELECT o.state, o.reason, o.message, b.mime_type, b.bytes, b.sha256 FROM outputs o " +
          "LEFT JOIN blobs b ON b.output_id = o.id WHERE o.document_id = ? AND o.version = ? " +
          "AND o.kind = ? AND o.variant = ? AND o.maker = ? AND o.maker_version = ?"
      )
      .get(key.documentId, key.version, key.kind, key.variant, key.maker, key.makerVersion) as {
      state: string
      reason: ContentsRefusal | null
      message: string | null
      mime_type: string | null
      bytes: Uint8Array | null
      sha256: string | null
    } | null
    if (!row) return null
    if (row.state === "ready")
      return {
        state: "ready",
        ...(row.mime_type ? { mimeType: row.mime_type } : {}),
        ...(row.bytes ? { bytes: new Uint8Array(row.bytes) } : {}),
        ...(row.sha256 ? { sha256: row.sha256 } : {}),
      }
    if (row.state === "refused")
      return { state: "refused", reason: row.reason ?? "failed", message: row.message ?? "" }
    return { state: "failed", message: row.message ?? "" }
  }

  /**
   * Of these items, the versions that have a kept output of a kind, in one
   * statement: for a list that shows a picture of each, without a read each.
   */
  versionsWith(spaceId: string, kind: DerivedKind, documentIds: readonly string[]): Map<string, string[]> {
    const found = new Map<string, string[]>()
    if (documentIds.length === 0) return found
    const rows = this.#open()
      .query(
        "SELECT document_id, version FROM outputs WHERE space_id = ? AND kind = ? AND state = 'ready' " +
          `AND document_id IN (${documentIds.map(() => "?").join(", ")})`
      )
      .all(spaceId, kind, ...documentIds) as { document_id: string; version: string }[]
    for (const row of rows) {
      found.set(row.document_id, [...(found.get(row.document_id) ?? []), row.version])
    }
    return found
  }

  /** What is kept for a Space, for catching up after a restart; no text. */
  listing(spaceId: string): Omit<DerivedKey, "spaceId">[] {
    return (
      this.#open()
        .query(
          "SELECT document_id, version, kind, variant, maker, maker_version FROM outputs " +
            "WHERE space_id = ? ORDER BY document_id, kind"
        )
        .all(spaceId) as {
        document_id: string
        version: string
        kind: DerivedKind
        variant: string
        maker: string
        maker_version: number
      }[]
    ).map((row) => ({
      documentId: row.document_id,
      version: row.version,
      kind: row.kind,
      variant: row.variant,
      maker: row.maker,
      makerVersion: row.maker_version,
    }))
  }

  /** Removes what was made from versions an item is no longer at. */
  keepOnlyVersion(spaceId: string, documentId: string, version: string): void {
    const removed = this.#open()
      .query("DELETE FROM outputs WHERE space_id = ? AND document_id = ? AND version != ?")
      .run(spaceId, documentId, version).changes
    if (removed > 0) {
      this.#reclaim()
      this.#noteWrite()
      announce({ spaceId, documentId, change: "removed" })
    }
  }

  /**
   * Removes everything kept for a Space's items that aren't in `live`: those
   * deleted, through Worktable or on disk. With no `live`, the whole Space's.
   */
  removeAllBut(spaceId: string, live?: ReadonlySet<string>): number {
    const db = this.#open()
    const kept = db
      .query("SELECT DISTINCT document_id FROM outputs WHERE space_id = ?")
      .all(spaceId) as { document_id: string }[]
    const gone = kept.map((row) => row.document_id).filter((id) => !live?.has(id))
    if (gone.length === 0) return 0
    const remove = db.query("DELETE FROM outputs WHERE space_id = ? AND document_id = ?")
    db.transaction(() => {
      for (const id of gone) remove.run(spaceId, id)
    })()
    this.#reclaim()
    this.#noteWrite()
    for (const documentId of gone) announce({ spaceId, documentId, change: "removed" })
    return gone.length
  }

  /** The Spaces that have anything kept. */
  spaces(): string[] {
    return (
      this.#open().query("SELECT DISTINCT space_id FROM outputs").all() as { space_id: string }[]
    ).map((row) => row.space_id)
  }

  close(): void {
    this.#db?.close()
    this.#db = null
  }
}

let shared: DerivedStore | null = null

/** The served workspace's store, opened on first use. */
export function derivedStore(): DerivedStore {
  const dir = derivedStoreDir()
  if (shared && dirname(shared.path) === dir) return shared
  shared?.close()
  shared = new DerivedStore(dir)
  return shared
}

/** Closes the shared store, so a test or a workspace switch opens a fresh one. */
export function closeDerivedStore(): void {
  shared?.close()
  shared = null
}
