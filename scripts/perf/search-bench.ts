// Search index benchmark: today's in-memory index (MiniSearch) against an
// on-disk SQLite FTS5 prototype, on the same synthetic Worktable.
//
//   bun scripts/perf/search-bench.ts --profiles 1k,5k --files 2000 --out <dir>
//
// Each index is measured in its own fresh process, so memory figures don't
// mix. Writes <out>/search-bench.json and <out>/search-bench.md.
// Not part of CI: a one-off measurement for the search rework.

import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fixtureDir, readFixture, type ProfileName } from "./fixtures.ts"
import { parseArgs, REPO_ROOT } from "./lib.ts"

const QUERIES = [
  "ledger reconciliation",
  "incident runbook",
  "pricing experiment",
  "quarterly roadmap",
  "customer",
  "onboarding",
  "migration plan",
  "ledg",
  "runb",
  "design review notes",
  "budget",
  "release",
]
/** Misspelled queries: what fuzzy matching forgives and prefix matching doesn't. */
const TYPO_QUERIES = [
  "ledgr reconcilation",
  "incidnt runbook",
  "pricng experimnt",
  "quartely roadmap",
]
const REPEATS = 7
const TOP = 10

interface ModeResult {
  mode: "minisearch" | "fts5"
  buildMs: number
  /** For FTS5: reading and projecting sources, apart from inserting. */
  projectMs?: number
  rssMb: number
  heapMb: number
  diskMb?: number
  firstQueryAfterRestartMs: number
  catchUpMs?: number
  queryP50Ms: number
  queryP95Ms: number
  editVisibleMs: number
  counts: Record<string, number>
  top: Record<string, string[]>
  /** FTS5 only: the same queries matching any word, as MiniSearch does. */
  topAnyWord?: Record<string, string[]>
  typoHits: Record<string, number>
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ]!
}

function memory(): { rssMb: number; heapMb: number } {
  Bun.gc(true)
  const usage = process.memoryUsage()
  return { rssMb: usage.rss / 2 ** 20, heapMb: usage.heapUsed / 2 ** 20 }
}

/** Plain text files, as people and agents leave them: logs and notes. */
function addTextFiles(workspace: string, count: number): void {
  const spaces = readdirSync(join(workspace, "spaces")).filter(
    (name) => !name.startsWith(".")
  )
  const words = [
    "ledger",
    "invoice",
    "deploy",
    "timeout",
    "customer",
    "retry",
    "cache",
    "queue",
    "pricing",
    "runbook",
    "metric",
    "budget",
  ]
  for (let index = 0; index < count; index += 1) {
    const space = spaces[index % spaces.length]!
    const dir = join(workspace, "spaces", space, "docs", "logs")
    mkdirSync(dir, { recursive: true })
    const lines: string[] = []
    for (let line = 0; line < 200; line += 1) {
      const word = words[(index * 7 + line) % words.length]
      lines.push(
        `2026-11-${String((line % 28) + 1).padStart(2, "0")} INFO service-${index % 40} ${word} handled request ${line} in ${(line * 13) % 900} ms`
      )
    }
    writeFileSync(join(dir, `run-${index}.log`), `${lines.join("\n")}\n`)
  }
}

// ── MiniSearch: today's index ───────────────────────────────

async function runMiniSearch(
  workspace: string,
  app: string
): Promise<ModeResult> {
  const { setWorkspaceRootOverride } =
    await import("../../packages/server/src/workspace.ts")
  const { setAppDirOverride } =
    await import("../../packages/server/src/app-storage.ts")
  setWorkspaceRootOverride(workspace)
  setAppDirOverride(app)
  const search = await import("../../packages/server/src/search-index.ts")
  const { listSpaces } = await import("../../packages/server/src/store.ts")
  search.setSearchWaitForTests(600_000)
  const before = memory()
  const started = performance.now()
  // A search after start waits for the build; that is today's restart cost.
  await search.searchWithStatus("warmup", {
    documentAccess: "common",
    maxResults: 50,
  })
  const buildMs = performance.now() - started
  const after = memory()

  const latencies: number[] = []
  const top: Record<string, string[]> = {}
  for (const query of QUERIES) {
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const t = performance.now()
      const { results } = await search.searchWithStatus(query, {
        documentAccess: "common",
        maxResults: 50,
      })
      latencies.push(performance.now() - t)
      if (repeat === 0)
        top[query] = results
          .filter((r) => r.type === "doc")
          .slice(0, TOP)
          .map((r) => `${r.spaceId}/${r.path}`)
    }
  }
  const typoHits: Record<string, number> = {}
  for (const query of TYPO_QUERIES) {
    typoHits[query] = (
      await search.searchWithStatus(query, {
        documentAccess: "common",
        maxResults: 50,
      })
    ).results.length
  }

  // An edit: a word only one Doc now holds, then the next search finds it.
  const space = (await listSpaces())[0]!
  const docsDir = join(workspace, "spaces", space.id, "docs")
  const target = readdirSync(docsDir).find((name) => name.endsWith(".md"))!
  const path = target.replace(/\.md$/, "")
  writeFileSync(
    join(docsDir, target),
    `${readFileSync(join(docsDir, target), "utf8")}\n\nzanzibarqux appears here.\n`
  )
  search.invalidateSearchIndex({ spaceId: space.id, path })
  const editStarted = performance.now()
  const found = await search.searchWithStatus("zanzibarqux", {
    documentAccess: "common",
    maxResults: 5,
  })
  const editVisibleMs = performance.now() - editStarted
  if (found.results.length === 0) throw new Error("MiniSearch missed the edit")

  return {
    mode: "minisearch",
    buildMs,
    rssMb: after.rssMb - before.rssMb,
    heapMb: after.heapMb - before.heapMb,
    firstQueryAfterRestartMs: buildMs,
    queryP50Ms: percentile(latencies, 50),
    queryP95Ms: percentile(latencies, 95),
    editVisibleMs,
    counts: {},
    top,
    typoHits,
  }
}

// ── FTS5 prototype ──────────────────────────────────────────

const SCHEMA = `
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  space_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  revision TEXT NOT NULL
);
CREATE VIRTUAL TABLE pieces USING fts5(
  title, body,
  item_id UNINDEXED, location UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
`

function ftsQuery(query: string, anyWord = false): string {
  return query
    .trim()
    .split(/\s+/)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(anyWord ? " OR " : " ")
}

async function runFts5(
  workspace: string,
  app: string,
  dbDir: string,
  withExtras: boolean
): Promise<ModeResult> {
  const { setWorkspaceRootOverride } =
    await import("../../packages/server/src/workspace.ts")
  const { setAppDirOverride } =
    await import("../../packages/server/src/app-storage.ts")
  setWorkspaceRootOverride(workspace)
  setAppDirOverride(app)
  const { projectDocumentsForSearch, readDocumentCatalogSnapshot } =
    await import("../../packages/server/src/document-query.ts")
  const { listSpaces } = await import("../../packages/server/src/store.ts")
  const dbPath = join(dbDir, "search.sqlite")
  const before = memory()
  const started = performance.now()
  let db = new Database(dbPath, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA cache_size = -8000")
  db.exec(SCHEMA)
  const insertItem = db.query(
    "INSERT INTO items (key, kind, space_id, path, title, revision) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  )
  const insertPiece = db.query(
    "INSERT INTO pieces (title, body, item_id, location) VALUES (?, ?, ?, ?)"
  )
  const counts = { docs: 0, threads: 0, messages: 0, files: 0, filePieces: 0 }
  let projectMs = 0

  const spaces = await listSpaces()
  for (const space of spaces) {
    const t = performance.now()
    const pass = await projectDocumentsForSearch({
      spaceId: space.id,
      shouldProject: () => true,
    })
    projectMs += performance.now() - t
    const rows: Array<[string, string, string, string]> = []
    for (const candidate of pass.candidates) {
      const read = candidate.read
      if (!read || read.result.kind !== "document") continue
      const { document, projection } = read.result
      if (document.format.id === "worktable.file") continue
      const text = projection.kind === "text" ? projection.text : ""
      rows.push([document.path, document.title, text, candidate.revision])
    }
    db.transaction(() => {
      for (const [path, title, text, revision] of rows) {
        const { id } = insertItem.get(
          `doc:${space.id}:${path}`,
          "doc",
          space.id,
          path,
          title,
          revision
        ) as { id: number }
        insertPiece.run(title, text, id, "")
        counts.docs += 1
      }
    })()

    if (!withExtras) continue
    // Threads: one piece per message.
    const threadsDir = join(workspace, "spaces", space.id, "threads")
    if (existsSync(threadsDir)) {
      const tt = performance.now()
      const threads = readdirSync(threadsDir)
        .filter((name) => name.endsWith(".json"))
        .map(
          (name) =>
            JSON.parse(readFileSync(join(threadsDir, name), "utf8")) as {
              id: string
              title?: string
              messages: Array<{ id: string; body: string }>
            }
        )
      projectMs += performance.now() - tt
      db.transaction(() => {
        for (const thread of threads) {
          const title = thread.title ?? "Thread"
          const { id } = insertItem.get(
            `thread:${space.id}:${thread.id}`,
            "thread",
            space.id,
            thread.id,
            title,
            String(thread.messages.length)
          ) as { id: number }
          counts.threads += 1
          for (const message of thread.messages) {
            insertPiece.run(title, message.body, id, message.id)
            counts.messages += 1
          }
        }
      })()
    }
    // Text files: one piece per 200 lines, at most 1 MiB of text each.
    const logs = join(workspace, "spaces", space.id, "docs", "logs")
    if (existsSync(logs)) {
      const tf = performance.now()
      const files = readdirSync(logs).map((name) => ({
        name,
        text: readFileSync(join(logs, name), "utf8").slice(0, 2 ** 20),
      }))
      projectMs += performance.now() - tf
      db.transaction(() => {
        for (const file of files) {
          const { id } = insertItem.get(
            `file:${space.id}:logs/${file.name}`,
            "file",
            space.id,
            `logs/${file.name}`,
            file.name,
            "r"
          ) as { id: number }
          counts.files += 1
          const lines = file.text.split("\n")
          for (let at = 0; at < lines.length; at += 200) {
            insertPiece.run(
              file.name,
              lines.slice(at, at + 200).join("\n"),
              id,
              `lines ${at + 1}-${Math.min(lines.length, at + 200)}`
            )
            counts.filePieces += 1
          }
        }
      })()
    }
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  db.run("INSERT INTO pieces(pieces) VALUES ('optimize')")
  const buildMs = performance.now() - started
  const after = memory()
  const diskMb =
    (statSync(dbPath).size +
      (existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0)) /
    2 ** 20

  const spaceIds = spaces.map((space) => space.id)
  const searchSql = db.query(
    `SELECT i.space_id AS space_id, i.path AS path, i.kind AS kind,
            snippet(pieces, 1, '[', ']', '…', 12) AS excerpt
       FROM pieces JOIN items i ON i.id = pieces.item_id
      WHERE pieces MATCH ? AND i.space_id IN (${spaceIds.map(() => "?").join(",")})
      ORDER BY bm25(pieces, 3.0, 1.0) LIMIT 50`
  )
  const run = (query: string, anyWord = false) =>
    searchSql.all(ftsQuery(query, anyWord), ...spaceIds) as Array<{
      space_id: string
      path: string
      kind: string
    }>
  const docsOf = (
    rows: Array<{ space_id: string; path: string; kind: string }>
  ) =>
    [
      ...new Set(
        rows
          .filter((r) => r.kind === "doc")
          .map((r) => `${r.space_id}/${r.path}`)
      ),
    ].slice(0, TOP)

  const latencies: number[] = []
  const top: Record<string, string[]> = {}
  for (const query of QUERIES) {
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const t = performance.now()
      const rows = run(query)
      latencies.push(performance.now() - t)
      if (repeat === 0) top[query] = docsOf(rows)
    }
  }
  const topAnyWord: Record<string, string[]> = {}
  for (const query of QUERIES) topAnyWord[query] = docsOf(run(query, true))
  const typoHits: Record<string, number> = {}
  for (const query of TYPO_QUERIES) typoHits[query] = run(query).length

  // A restart: the index is on disk. What a first search waits for is
  // opening it, and seeing which documents changed since (the catalog's
  // revisions against the stored ones), not a rebuild.
  db.close()
  const restarted = performance.now()
  db = new Database(dbPath)
  db.run("PRAGMA cache_size = -8000")
  const reopenSql = db.query(
    `SELECT i.path AS path FROM pieces JOIN items i ON i.id = pieces.item_id WHERE pieces MATCH ? ORDER BY bm25(pieces, 3.0, 1.0) LIMIT 50`
  )
  reopenSql.all(ftsQuery(QUERIES[0]!))
  const firstQueryAfterRestartMs = performance.now() - restarted
  const catchUpStarted = performance.now()
  const stored = new Map(
    (
      db
        .query("SELECT key, revision FROM items WHERE kind = 'doc'")
        .all() as Array<{ key: string; revision: string }>
    ).map((row) => [row.key, row.revision])
  )
  let changed = 0
  for (const space of spaces) {
    const catalog = await readDocumentCatalogSnapshot(space.id)
    for (const entry of catalog.entries) {
      if (entry.kind !== "document") continue
      if (!stored.has(`doc:${space.id}:${entry.descriptor.path}`)) changed += 1
    }
  }
  const catchUpMs = performance.now() - catchUpStarted

  // An edit: replace one item's pieces in a transaction, then search.
  const editStarted = performance.now()
  const item = db
    .query("SELECT id, title FROM items WHERE kind = 'doc' LIMIT 1")
    .get() as { id: number; title: string }
  db.transaction(() => {
    db.query("DELETE FROM pieces WHERE item_id = ?").run(item.id)
    db.query(
      "INSERT INTO pieces (title, body, item_id, location) VALUES (?, ?, ?, '')"
    ).run(item.title, "zanzibarqux appears here.", item.id)
  })()
  const hit = db
    .query("SELECT item_id FROM pieces WHERE pieces MATCH ? LIMIT 1")
    .get(ftsQuery("zanzibarqux"))
  const editVisibleMs = performance.now() - editStarted
  if (!hit) throw new Error("FTS5 missed the edit")
  db.close()

  return {
    mode: "fts5",
    buildMs,
    projectMs,
    rssMb: after.rssMb - before.rssMb,
    heapMb: after.heapMb - before.heapMb,
    diskMb,
    firstQueryAfterRestartMs,
    catchUpMs,
    queryP50Ms: percentile(latencies, 50),
    queryP95Ms: percentile(latencies, 95),
    editVisibleMs,
    counts: { ...counts, notInCatalog: changed },
    top,
    topAnyWord,
    typoHits,
  }
}

// ── Driver ──────────────────────────────────────────────────

function overlap(
  left: Record<string, string[]>,
  right: Record<string, string[]>
): number {
  const shares = QUERIES.map((query) => {
    const a = new Set(left[query] ?? [])
    const b = right[query] ?? []
    const size = Math.max(a.size, b.length)
    return size === 0 ? 1 : b.filter((item) => a.has(item)).length / size
  })
  return shares.reduce((sum, share) => sum + share, 0) / shares.length
}

const args = parseArgs(process.argv.slice(2))
const mode = args.get("mode")

if (mode) {
  // A child: one index, one fresh process.
  const workspace = args.get("workspace")!
  const app = args.get("app")!
  const result =
    mode === "minisearch"
      ? await runMiniSearch(workspace, app)
      : await runFts5(workspace, app, args.get("db")!, mode === "fts5-all")
  console.log(`RESULT ${JSON.stringify(result)}`)
  process.exit(0)
}

const profiles = (args.get("profiles") ?? "1k").split(",") as ProfileName[]
const fileCount = Number(args.get("files") ?? "2000")
const out = args.get("out") ?? join(REPO_ROOT, "test-results")
mkdirSync(out, { recursive: true })
const report: Record<string, unknown> = {
  node: process.version,
  bun: Bun.version,
  cpus: navigator.hardwareConcurrency,
}
const lines: string[] = ["# Search index benchmark", ""]

for (const profile of profiles) {
  const seed = 1
  const dir = fixtureDir(profile, seed)
  if (!readFixture(dir)) {
    const generated = spawnSync(
      "bun",
      [
        "scripts/perf/fixtures.ts",
        "--profile",
        profile,
        "--seed",
        String(seed),
      ],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
      }
    )
    if (generated.status !== 0) throw new Error(`fixture ${profile} failed`)
  }
  // A copy with text files added, the same for every run.
  const work = mkdtempSync(join(tmpdir(), `search-bench-${profile}-`))
  cpSync(join(dir, "workspace"), join(work, "workspace"), { recursive: true })
  addTextFiles(join(work, "workspace"), fileCount)

  const child = (childMode: string) => {
    const app = join(work, `app-${childMode}`)
    cpSync(join(dir, "app"), app, { recursive: true })
    const db = join(work, `db-${childMode}`)
    mkdirSync(db, { recursive: true })
    const run = spawnSync(
      "bun",
      [
        "scripts/perf/search-bench.ts",
        "--mode",
        childMode,
        "--workspace",
        join(work, "workspace"),
        "--app",
        app,
        "--db",
        db,
      ],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 2 ** 20 }
    )
    const line = run.stdout
      .split("\n")
      .find((entry) => entry.startsWith("RESULT "))
    if (!line)
      throw new Error(
        `${childMode} on ${profile} failed:\n${run.stdout.slice(-2000)}\n${run.stderr.slice(-4000)}`
      )
    return JSON.parse(line.slice("RESULT ".length)) as ModeResult
  }
  const mini = child("minisearch")
  const ftsDocs = child("fts5-docs")
  const ftsAll = child("fts5-all")
  rmSync(work, { recursive: true, force: true })

  report[profile] = {
    minisearch: mini,
    fts5Docs: ftsDocs,
    fts5All: ftsAll,
    top10Overlap: overlap(mini.top, ftsDocs.top),
    top10OverlapAnyWord: overlap(mini.top, ftsDocs.topAnyWord ?? {}),
  }
  const ms = (value: number | undefined) =>
    value === undefined ? "n/a" : `${value.toFixed(value < 10 ? 2 : 0)} ms`
  const mb = (value: number | undefined) =>
    value === undefined ? "n/a" : `${value.toFixed(1)} MB`
  lines.push(
    `## ${profile} Docs (${ftsAll.counts["docs"]} documents, ${ftsAll.counts["messages"]} thread messages in ${ftsAll.counts["threads"]} threads, ${ftsAll.counts["files"]} text files)`,
    "",
    "| Measure | MiniSearch today | FTS5, same Docs | FTS5, Docs + threads + files |",
    "|---|---|---|---|",
    `| Build from nothing | ${ms(mini.buildMs)} | ${ms(ftsDocs.buildMs)} (projection ${ms(ftsDocs.projectMs)}) | ${ms(ftsAll.buildMs)} (reading ${ms(ftsAll.projectMs)}) |`,
    `| Memory held (RSS growth) | ${mb(mini.rssMb)} | ${mb(ftsDocs.rssMb)} | ${mb(ftsAll.rssMb)} |`,
    `| JS heap growth | ${mb(mini.heapMb)} | ${mb(ftsDocs.heapMb)} | ${mb(ftsAll.heapMb)} |`,
    `| On disk | none | ${mb(ftsDocs.diskMb)} | ${mb(ftsAll.diskMb)} |`,
    `| First search after a restart | ${ms(mini.firstQueryAfterRestartMs)} (full rebuild) | ${ms(ftsDocs.firstQueryAfterRestartMs)} + catch-up check ${ms(ftsDocs.catchUpMs)} | ${ms(ftsAll.firstQueryAfterRestartMs)} + ${ms(ftsAll.catchUpMs)} |`,
    `| Search, p50 / p95 | ${ms(mini.queryP50Ms)} / ${ms(mini.queryP95Ms)} | ${ms(ftsDocs.queryP50Ms)} / ${ms(ftsDocs.queryP95Ms)} | ${ms(ftsAll.queryP50Ms)} / ${ms(ftsAll.queryP95Ms)} |`,
    `| An edit, until searchable | ${ms(mini.editVisibleMs)} | ${ms(ftsDocs.editVisibleMs)} | ${ms(ftsAll.editVisibleMs)} |`,
    `| Top-10 overlap with today's Doc ranking | 100% | ${(overlap(mini.top, ftsDocs.top) * 100).toFixed(0)}% all words; ${(overlap(mini.top, ftsDocs.topAnyWord ?? {}) * 100).toFixed(0)}% any word | |`,
    `| Misspelled queries with any hit | ${Object.values(mini.typoHits).filter((n) => n > 0).length} of ${TYPO_QUERIES.length} | ${Object.values(ftsDocs.typoHits).filter((n) => n > 0).length} of ${TYPO_QUERIES.length} | |`,
    ""
  )
}
lines.push(
  `Machine: ${navigator.hardwareConcurrency} CPUs, Bun ${Bun.version}.`,
  ""
)
writeFileSync(join(out, "search-bench.json"), JSON.stringify(report, null, 2))
writeFileSync(join(out, "search-bench.md"), lines.join("\n"))
console.log(lines.join("\n"))
