// ============================================================
// Where the search index keeps its entries
// ============================================================
//
// SQLite FTS5, in a file of the workspace's derived output (derived-store.ts),
// so a start or a Cloud wake opens the index instead of building it again:
// a search then re-reads only what changed while the server was down. An
// entry's row keeps the revision it was read at, which is how a sync knows.
// Outside the server (tests, the CLI) the index is in memory.
//
// Each document access mode keeps its own entries (search-index.ts). A
// search matches every word, each as the start of a word, ranked by BM25
// with titles weighted. A word that matches nothing is searched as its
// nearest words instead (search-words.ts), from the index's word list,
// which is read only when a search needs it.
//
// MiniSearch, the index before this one, stays for one release behind
// WORKTABLE_SEARCH_INDEX=minisearch, and serves when SQLite's FTS5 fails
// its self-test.

import { Database } from "bun:sqlite"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import MiniSearch from "minisearch"
import {
  searchResultKind,
  type DocumentHealth,
  type SearchKind,
} from "@worktable/types"
import { derivedStoreDir } from "./derived-store.ts"
import { logError } from "./debug-log.ts"
import { VERSION } from "./release-info.ts"
import { noteStorageChange } from "./storage-usage.ts"
import {
  correctable,
  foldWord,
  indexQuery,
  nearestWords,
  searchWords,
  type IndexedWord,
  type QueryWord,
} from "./search-words.ts"

export interface DocEntry {
  id: string
  spaceId: string
  path: string
  type: "doc"
  title: string
  body: string
  documentKind?: "document" | "conflict"
  documentView?: "doc" | "html"
  formatId?: string
  sourceVersion?: number
  health?: DocumentHealth
  archiveOn?: string
  /** The searches that see this entry, when not every one does. */
  view?: "live" | "archived"
  /** The document itself is archived. */
  archived?: true
}

export interface RecordEntry {
  id: string
  spaceId: string
  path: string
  type: "record"
  collectionId: string
  recordId: string
  title: string
  body: string
}

export type IndexEntry = DocEntry | RecordEntry

export function entryKind(entry: IndexEntry): SearchKind {
  return searchResultKind(
    entry.type === "doc" && entry.formatId
      ? { type: "doc", format: { id: entry.formatId } }
      : { type: entry.type }
  )
}

/** An entry as stored: its Space, and for a document the revision it was read at. */
export interface StoredEntry {
  id: string
  spaceId: string
  /** A document's key in its Space's catalog; null for a record. */
  key: string | null
  revision: string
  readAt: number
}

export interface IndexHit {
  /** The entry, without its indexed body. */
  entry: IndexEntry
  score: number
  /** Words to find in the text for its excerpt. */
  terms: string[]
}

export interface IndexSearchOptions {
  spaceId?: string
  accept: (entry: IndexEntry) => boolean
  /**
   * Archived hits after the rest. An entry is archived when it is itself,
   * or when its Space is one of these.
   */
  archivedLast?: { spaces: ReadonlySet<string> }
  /** Hits each part (current, then archived) takes at most. */
  limit: number
}

export interface IndexSearch {
  hits: IndexHit[]
  /** Words searched for in place of ones that matched nothing. */
  corrected: string[]
}

/** One document access mode's entries. */
export interface VariantIndex {
  /** False once its store closed or another store serves search. */
  current(): boolean
  /** Entries kept from before this process, to sync from. */
  stored(): StoredEntry[]
  put(entry: IndexEntry, displayBody: string, stored?: Omit<StoredEntry, "id" | "spaceId">): void
  drop(id: string): void
  /** Runs writes as one, so a slice of a sync lands at once. */
  batch(write: () => void): void
  search(query: string, options: IndexSearchOptions): IndexSearch
  /** The text each hit's excerpt comes from, as it is now, read at once. */
  displayBodies(hits: readonly IndexHit[]): string[]
  /** Stops writing: another index took its place. */
  retire(): void
}

const isArchivedIn = (entry: IndexEntry, spaces: ReadonlySet<string>) =>
  (entry.type === "doc" && entry.archived === true) || spaces.has(entry.spaceId)

// ── SQLite FTS5 ──────────────────────────────────────────────

/** Bump to rebuild the tables from nothing. */
const SCHEMA_VERSION = 1
/**
 * Bump when entries are made differently (search-index.ts), so every
 * document is read again, while the old entries answer meanwhile. A new
 * release does the same, as its readers may have changed.
 */
const ENTRY_FORMAT = 1

/**
 * Items whose title holds every word come first. Each is ranked by its
 * title's relevance among titles, three times over, plus its whole text's,
 * where title words also weigh three times body words; the rest by their
 * whole text's. Measured on a real Worktable, a document's whole length
 * otherwise outweighs a short title that names what was searched for
 * (research/2026-11-20-search-rework-claude).
 */
const RANK = "(t.score IS NULL), 3 * coalesce(t.score, 0) + bm25(pieces, 3.0, 1.0)"

/** How an entry's excerpt text is kept: as its body, its body after the first line, or apart. */
const DISPLAY_BODY = 0
const DISPLAY_AFTER_FIRST_LINE = 1
const DISPLAY_STORED = 2

export class FtsUnavailableError extends Error {}

class Fts5Store {
  readonly path: string
  #db: Database | null
  #vocabulary: IndexedWord[] | null = null
  #vocabularyStale = false
  #vocabularyRefresh: ReturnType<typeof setTimeout> | null = null

  constructor(path: string) {
    this.path = path
    this.#db = Fts5Store.#open(path)
  }

  static #open(path: string): Database {
    const onDisk = path !== ":memory:"
    if (onDisk) mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
    const db = new Database(path, { create: true })
    try {
      if (!ftsWorks(db)) throw new FtsUnavailableError("SQLite FTS5 failed its self-test")
      if (onDisk) {
        db.run("PRAGMA journal_mode = WAL")
        // A cache made again from the files: commits stay atomic without
        // waiting on the disk for each.
        db.run("PRAGMA synchronous = NORMAL")
        db.run("PRAGMA busy_timeout = 5000")
      }
      const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
      if (version !== SCHEMA_VERSION) {
        db.run("DROP TABLE IF EXISTS vocabulary")
        db.run("DROP TABLE IF EXISTS titles")
        db.run("DROP TABLE IF EXISTS pieces")
        db.run("DROP TABLE IF EXISTS items")
        db.run("DROP TABLE IF EXISTS meta")
      }
      db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
      db.run(
        "CREATE TABLE IF NOT EXISTS items (" +
          "id INTEGER PRIMARY KEY, variant TEXT NOT NULL, entry_id TEXT NOT NULL, " +
          "space_id TEXT NOT NULL, doc_key TEXT, revision TEXT NOT NULL DEFAULT '', " +
          "read_at INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, " +
          "meta TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, " +
          "display_mode INTEGER NOT NULL, display TEXT, " +
          "UNIQUE (variant, entry_id))"
      )
      db.run("CREATE INDEX IF NOT EXISTS items_space ON items (variant, space_id)")
      // The text is kept once, in items; the index reads it from there.
      db.run(
        "CREATE VIRTUAL TABLE IF NOT EXISTS pieces USING fts5(" +
          "title, body, content = 'items', content_rowid = 'id', " +
          "tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')"
      )
      // Titles again, on their own: a title's relevance measured against
      // titles, not diluted by its document's length.
      db.run(
        "CREATE VIRTUAL TABLE IF NOT EXISTS titles USING fts5(" +
          "title, content = 'items', content_rowid = 'id', " +
          "tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')"
      )
      db.run(
        "CREATE TRIGGER IF NOT EXISTS items_insert AFTER INSERT ON items BEGIN " +
          "INSERT INTO pieces (rowid, title, body) VALUES (new.id, new.title, new.body); " +
          "INSERT INTO titles (rowid, title) VALUES (new.id, new.title); END"
      )
      db.run(
        "CREATE TRIGGER IF NOT EXISTS items_delete AFTER DELETE ON items BEGIN " +
          "INSERT INTO pieces (pieces, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); " +
          "INSERT INTO titles (titles, rowid, title) VALUES ('delete', old.id, old.title); END"
      )
      db.run(
        "CREATE TRIGGER IF NOT EXISTS items_update AFTER UPDATE OF title, body ON items " +
          "WHEN old.title IS NOT new.title OR old.body IS NOT new.body BEGIN " +
          "INSERT INTO pieces (pieces, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); " +
          "INSERT INTO pieces (rowid, title, body) VALUES (new.id, new.title, new.body); " +
          "INSERT INTO titles (titles, rowid, title) VALUES ('delete', old.id, old.title); " +
          "INSERT INTO titles (rowid, title) VALUES (new.id, new.title); END"
      )
      db.run("CREATE VIRTUAL TABLE IF NOT EXISTS vocabulary USING fts5vocab(pieces, 'row')")
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      const format = `${ENTRY_FORMAT}:${VERSION}`
      const stored = db.query("SELECT value FROM meta WHERE key = 'format'").get() as { value: string } | null
      if (stored?.value !== format) {
        // Entries stay and answer until each document is read again.
        db.run("UPDATE items SET revision = ''")
        db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('format', ?)").run(format)
      }
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  get open(): boolean {
    return this.#db !== null
  }

  db(): Database {
    if (!this.#db) throw new Error("The search index is closed")
    return this.#db
  }

  noteWrite(): void {
    this.#vocabularyStale = true
    if (this.path !== ":memory:") {
      noteStorageChange(this.path)
      noteStorageChange(`${this.path}-wal`)
    }
  }

  /** Whether any word the index holds starts with `start` (folded). */
  holdsWordStarting(start: string): boolean {
    return (
      this.db()
        .query("SELECT 1 FROM vocabulary WHERE term >= ? AND term < ? LIMIT 1")
        .get(start, `${start}\u{10FFFF}`) !== null
    )
  }

  /**
   * The index's words of letters only, with how many items hold each. Read
   * when a search first needs it, and again after the index changed, after
   * that search: a search never waits for a fresh list.
   */
  vocabulary(): readonly IndexedWord[] {
    if (!this.#vocabulary) {
      this.#vocabulary = this.#readVocabulary()
      this.#vocabularyStale = false
    } else if (this.#vocabularyStale && !this.#vocabularyRefresh) {
      this.#vocabularyRefresh = setTimeout(() => {
        this.#vocabularyRefresh = null
        if (!this.#db) return
        this.#vocabularyStale = false
        try {
          this.#vocabulary = this.#readVocabulary()
        } catch (error) {
          console.warn("[search] word list refresh failed:", logError(error))
        }
      }, 0)
      this.#vocabularyRefresh.unref?.()
    }
    return this.#vocabulary
  }

  #readVocabulary(): IndexedWord[] {
    const words: IndexedWord[] = []
    for (const row of this.db().query("SELECT term, doc FROM vocabulary").iterate() as IterableIterator<{
      term: string
      doc: number
    }>) {
      if (/^\p{L}+$/u.test(row.term)) words.push({ term: row.term, docs: row.doc })
    }
    return words
  }

  close(): void {
    if (this.#vocabularyRefresh) clearTimeout(this.#vocabularyRefresh)
    this.#vocabularyRefresh = null
    this.#vocabulary = null
    this.#db?.close()
    this.#db = null
  }
}

/** Exercise insert, update, delete and match once before trusting FTS5. */
function ftsWorks(db: Database): boolean {
  try {
    db.run("DROP TABLE IF EXISTS temp.fts_probe")
    db.run("CREATE VIRTUAL TABLE temp.fts_probe USING fts5(t)")
    db.run("INSERT INTO temp.fts_probe (rowid, t) VALUES (1, 'hello world')")
    db.run("UPDATE temp.fts_probe SET t = 'hello there' WHERE rowid = 1")
    const hit = db.query("SELECT rowid FROM temp.fts_probe WHERE fts_probe MATCH 'hello'").all()
    db.run("DELETE FROM temp.fts_probe WHERE rowid = 1")
    db.run("DROP TABLE temp.fts_probe")
    return hit.length === 1
  } catch {
    return false
  }
}

type Row = {
  id: number
  entry_id: string
  space_id: string
  meta: string
  title: string
  archived: number
  score: number
}

class Fts5VariantIndex implements VariantIndex {
  readonly #store: Fts5Store
  readonly #variant: string
  #retired = false

  constructor(store: Fts5Store, variant: string, includesRecords: boolean) {
    this.#store = store
    this.#variant = variant
    if (!includesRecords) {
      // Records left this index for the record index.
      const removed = store
        .db()
        .query("DELETE FROM items WHERE variant = ? AND doc_key IS NULL")
        .run(variant)
      if (removed.changes > 0) store.noteWrite()
    }
  }

  current(): boolean {
    return !this.#retired && this.#store.open && shared?.store === this.#store && shared.path === storePath()
  }

  #writable(): boolean {
    return !this.#retired && this.#store.open
  }

  stored(): StoredEntry[] {
    return (
      this.#store
        .db()
        .query(
          "SELECT entry_id AS id, space_id AS spaceId, doc_key AS key, revision, read_at AS readAt " +
            "FROM items WHERE variant = ?"
        )
        .all(this.#variant) as StoredEntry[]
    )
  }

  put(entry: IndexEntry, displayBody: string, stored?: Omit<StoredEntry, "id" | "spaceId">): void {
    if (!this.#writable()) return
    const { body, title, ...rest } = entry
    const firstLine = body.indexOf("\n")
    const mode =
      displayBody === body
        ? DISPLAY_BODY
        : firstLine !== -1 && displayBody === body.slice(firstLine + 1)
          ? DISPLAY_AFTER_FIRST_LINE
          : DISPLAY_STORED
    this.#store
      .db()
      .query(
        "INSERT INTO items (variant, entry_id, space_id, doc_key, revision, read_at, archived, " +
          "meta, title, body, display_mode, display) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (variant, entry_id) DO UPDATE SET space_id = excluded.space_id, " +
          "doc_key = excluded.doc_key, revision = excluded.revision, read_at = excluded.read_at, " +
          "archived = excluded.archived, meta = excluded.meta, title = excluded.title, " +
          "body = excluded.body, display_mode = excluded.display_mode, display = excluded.display"
      )
      .run(
        this.#variant,
        entry.id,
        entry.spaceId,
        stored?.key ?? null,
        stored?.revision ?? "",
        stored?.readAt ?? 0,
        entry.type === "doc" && entry.archived ? 1 : 0,
        JSON.stringify(rest),
        title,
        body,
        mode,
        mode === DISPLAY_STORED ? displayBody : null
      )
    this.#store.noteWrite()
  }

  drop(id: string): void {
    if (!this.#writable()) return
    const removed = this.#store
      .db()
      .query("DELETE FROM items WHERE variant = ? AND entry_id = ?")
      .run(this.#variant, id)
    if (removed.changes > 0) this.#store.noteWrite()
  }

  batch(write: () => void): void {
    if (!this.#writable()) return
    this.#store.db().transaction(write)()
  }

  search(query: string, options: IndexSearchOptions): IndexSearch {
    if (!this.#store.open) return { hits: [], corrected: [] }
    const words = searchWords(query)
    if (words.length === 0) return { hits: [], corrected: [] }
    const typed: QueryWord[] = words.map((word) => ({ word, as: "typed" }))
    const hits = this.#matches(typed, words, options)
    // Only a word that matches nothing is corrected, and only a search that
    // found nothing has one.
    if (hits.length > 0) return { hits, corrected: [] }
    let changed = false
    const queryWords = words.map((word, at): QueryWord => {
      const folded = foldWord(word)
      if (!correctable(folded) || this.#store.holdsWordStarting(folded)) {
        return { word, as: "typed" }
      }
      // The last word may still be being typed: compare word starts too.
      const near = nearestWords(folded, this.#store.vocabulary(), at === words.length - 1)
      if (near.length === 0) return { word, as: "typed" }
      changed = true
      return { word, as: "nearest", near }
    })
    if (!changed) return { hits, corrected: [] }
    const corrected = [
      ...new Set(queryWords.flatMap((word) => (word.as === "nearest" ? word.near.map((near) => near.text) : []))),
    ]
    return { hits: this.#matches(queryWords, [...words, ...corrected], options), corrected }
  }

  #matches(queryWords: QueryWord[], terms: string[], options: IndexSearchOptions): IndexHit[] {
    const archivedSpaces = options.archivedLast?.spaces
    // Prepared for this search alone: a statement left part-read keeps its
    // read open, which holds back every checkpoint of the file.
    const statement = this.#store
      .db()
      .prepare(
        // Title scores are read once: joined as a subquery, they were read
        // again for every match, which took seconds for a one-letter search.
        "WITH t AS MATERIALIZED (SELECT rowid, bm25(titles) AS score FROM titles WHERE titles MATCH ?1) " +
          "SELECT i.id, i.entry_id, i.space_id, i.meta, i.title, i.archived, " +
          "-(3 * coalesce(t.score, 0) + bm25(pieces, 3.0, 1.0)) AS score " +
          "FROM pieces JOIN items i ON i.id = pieces.rowid " +
          "LEFT JOIN t ON t.rowid = i.id " +
          "WHERE pieces MATCH ?1 AND i.variant = ?2 AND (?3 IS NULL OR i.space_id = ?3) " +
          "ORDER BY " +
          (archivedSpaces
            ? "(i.archived OR i.space_id IN (SELECT value FROM json_each(?4))), "
            : "") +
          RANK
      )
    const hits: IndexHit[] = []
    let current = 0
    let archived = 0
    try {
      const rows = statement.iterate(
        indexQuery(queryWords),
        this.#variant,
        options.spaceId ?? null,
        ...(archivedSpaces ? [JSON.stringify([...archivedSpaces])] : [])
      ) as IterableIterator<Row>
      for (const row of rows) {
        const entry = {
          ...(JSON.parse(row.meta) as Omit<IndexEntry, "title" | "body">),
          id: row.entry_id,
          spaceId: row.space_id,
          title: row.title,
          body: "",
        } as IndexEntry
        if (!options.accept(entry)) continue
        if (archivedSpaces && isArchivedIn(entry, archivedSpaces)) {
          if (archived >= options.limit) break
          archived += 1
        } else {
          // Current hits come first: past the limit, skip to archived ones.
          if (current >= options.limit) {
            if (!archivedSpaces) break
            continue
          }
          current += 1
        }
        hits.push({ entry, score: row.score, terms })
      }
    } finally {
      statement.finalize()
    }
    return hits
  }

  displayBodies(hits: readonly IndexHit[]): string[] {
    if (!this.#store.open || hits.length === 0) return hits.map(() => "")
    const rows = this.#store
      .db()
      .query(
        "SELECT entry_id, body, display_mode, display FROM items " +
          "WHERE variant = ? AND entry_id IN (SELECT value FROM json_each(?))"
      )
      .all(this.#variant, JSON.stringify(hits.map((hit) => hit.entry.id))) as Array<{
      entry_id: string
      body: string
      display_mode: number
      display: string | null
    }>
    const byId = new Map(
      rows.map((row) => [
        row.entry_id,
        row.display_mode === DISPLAY_STORED
          ? (row.display ?? "")
          : row.display_mode === DISPLAY_AFTER_FIRST_LINE
            ? row.body.slice(row.body.indexOf("\n") + 1)
            : row.body,
      ])
    )
    return hits.map((hit) => byId.get(hit.entry.id) ?? "")
  }

  retire(): void {
    this.#retired = true
  }
}

// ── MiniSearch ───────────────────────────────────────────────

class MiniSearchVariantIndex implements VariantIndex {
  readonly #idx = new MiniSearch<IndexEntry>({
    fields: ["title", "body"],
    storeFields: [
      "spaceId",
      "path",
      "type",
      "title",
      "collectionId",
      "recordId",
      "documentKind",
      "documentView",
      "formatId",
      "sourceVersion",
      "health",
      "archiveOn",
      "view",
      "archived",
    ],
    searchOptions: { boost: { title: 3 }, fuzzy: 0.2, prefix: true },
  })
  // MiniSearch keeps no field text; excerpts read from here.
  readonly #displayBodies = new Map<string, string>()

  current(): boolean {
    return engine() === "minisearch" || ftsBroken || unopenable === storePath()
  }

  stored(): StoredEntry[] {
    return []
  }

  put(entry: IndexEntry, displayBody: string): void {
    if (this.#idx.has(entry.id)) this.#idx.replace(entry)
    else this.#idx.add(entry)
    this.#displayBodies.set(entry.id, displayBody)
  }

  drop(id: string): void {
    if (this.#idx.has(id)) this.#idx.discard(id)
    this.#displayBodies.delete(id)
  }

  batch(write: () => void): void {
    write()
  }

  search(query: string, options: IndexSearchOptions): IndexSearch {
    const found = this.#idx
      .search(query, {
        filter: (result) => {
          const entry = result as unknown as IndexEntry
          if (options.spaceId !== undefined && entry.spaceId !== options.spaceId) return false
          return options.accept(entry)
        },
      })
      .map(
        (result): IndexHit => ({
          entry: { ...(result as unknown as IndexEntry), id: String(result.id), body: "" },
          score: result.score,
          terms: result.terms,
        })
      )
    const spaces = options.archivedLast?.spaces
    const hits = spaces
      ? [
          ...found.filter((hit) => !isArchivedIn(hit.entry, spaces)).slice(0, options.limit),
          ...found.filter((hit) => isArchivedIn(hit.entry, spaces)).slice(0, options.limit),
        ]
      : found.slice(0, options.limit)
    return { hits, corrected: [] }
  }

  displayBodies(hits: readonly IndexHit[]): string[] {
    return hits.map((hit) => this.#displayBodies.get(hit.entry.id) ?? "")
  }

  retire(): void {}
}

// ── Which index serves ───────────────────────────────────────

function engine(): "fts5" | "minisearch" {
  return process.env["WORKTABLE_SEARCH_INDEX"] === "minisearch" ? "minisearch" : "fts5"
}

let onDisk = false
let ftsBroken = false
/** A store path that could not be opened: search stays in memory there. */
let unopenable: string | null = null
let shared: { path: string; store: Fts5Store } | null = null

function storePath(): string {
  return onDisk ? join(derivedStoreDir(), "search.sqlite") : ":memory:"
}

/**
 * Keep the index on disk, in the served workspace's derived output, from
 * the next index opened on. The server does this when it starts.
 */
export function keepSearchIndexOnDisk(keep: boolean): void {
  if (onDisk === keep) return
  onDisk = keep
  closeSearchStore()
}

/** Closes the index's file, so it can be removed or another opened. */
export function closeSearchStore(): void {
  shared?.store.close()
  shared = null
}

/**
 * The store at `path`. A file that can't be opened is a cache: it is
 * removed and made again from the files, once.
 */
function openStore(path: string): Fts5Store {
  try {
    return new Fts5Store(path)
  } catch (error) {
    if (path === ":memory:" || error instanceof FtsUnavailableError) throw error
    console.warn("[search] search index unreadable; building it again:", logError(error))
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true })
    return new Fts5Store(path)
  }
}

/** An index for one document access mode, from the store that serves now. */
export function openVariantIndex(variant: string, includesRecords: boolean): VariantIndex {
  const path = storePath()
  if (engine() === "fts5" && !ftsBroken && unopenable !== path) {
    try {
      if (!shared || shared.path !== path || !shared.store.open) {
        shared?.store.close()
        shared = { path, store: openStore(path) }
      }
      return new Fts5VariantIndex(shared.store, variant, includesRecords)
    } catch (error) {
      shared = null
      if (error instanceof FtsUnavailableError) ftsBroken = true
      else unopenable = path
      console.warn("[search] SQLite search index unavailable; searching in memory:", logError(error))
    }
  }
  return new MiniSearchVariantIndex()
}
