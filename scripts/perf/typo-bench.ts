// Typo tolerance for the FTS5 search index: which way of finding the word a
// misspelling meant is right most often, how fast, and at what memory or
// disk cost. Builds the benchmark's FTS5 index (Docs, threads, text files),
// then misspells words it holds and asks each method for the word.
//
//   bun scripts/perf/typo-bench.ts --profile 5k --files 2000 --samples 3000 --out <dir>
//
// Not part of CI: a one-off measurement for the search rework.

import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fixtureDir, readFixture, type ProfileName } from "./fixtures.ts"
import { parseArgs, REPO_ROOT, seededRandom } from "./lib.ts"
import { addTextFiles } from "./search-bench.ts"

interface Term {
  term: string
  docs: number
}

/** Optimal string alignment distance: edits, with a swap of neighbours as one. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)]
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(
        rows[i - 1]![j]! + 1,
        row[j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, rows[i - 2]![j - 2]! + 1)
      row.push(value)
      best = Math.min(best, value)
    }
    if (best > max) return max + 1
    rows.push(row)
  }
  return rows[a.length]![b.length]!
}

/** Edits a word may take: none when short, one, then two when long. */
function budget(word: string): number {
  return word.length < 4 ? 0 : word.length < 8 ? 1 : 2
}

/** Closest first, then the word more documents hold. */
function rank(word: string, candidates: Iterable<Term>): Term[] {
  const max = budget(word)
  const scored: Array<Term & { d: number }> = []
  for (const candidate of candidates) {
    if (candidate.term === word) continue
    const d = distance(word, candidate.term, max)
    if (d <= max) scored.push({ ...candidate, d })
  }
  return scored.sort((a, b) => a.d - b.d || b.docs - a.docs).slice(0, 3)
}

// ── BK-tree: words in memory, by distance ─────────────────────

interface BkNode {
  term: Term
  children: Map<number, BkNode>
}

function bkInsert(root: BkNode | null, term: Term): BkNode {
  const node = { term, children: new Map<number, BkNode>() }
  if (!root) return node
  let at = root
  for (;;) {
    const d = distance(term.term, at.term.term, 64)
    const next = at.children.get(d)
    if (!next) {
      at.children.set(d, node)
      return root
    }
    at = next
  }
}

function bkSearch(root: BkNode, word: string, max: number): Term[] {
  const found: Term[] = []
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()!
    const d = distance(word, node.term.term, 64)
    if (d <= max) found.push(node.term)
    for (let k = Math.max(0, d - max); k <= d + max; k += 1) {
      const child = node.children.get(k)
      if (child) stack.push(child)
    }
  }
  return found
}

// ── Misspellings, as people type them ─────────────────────────

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
function neighbours(letter: string): string {
  for (let r = 0; r < ROWS.length; r += 1) {
    const at = ROWS[r]!.indexOf(letter)
    if (at === -1) continue
    return [
      ROWS[r]![at - 1],
      ROWS[r]![at + 1],
      ROWS[r - 1]?.[at],
      ROWS[r + 1]?.[at],
    ]
      .filter(Boolean)
      .join("")
  }
  return "etaoinshr"
}

function misspell(word: string, random: () => number, edits: number): string {
  let out = word
  for (let n = 0; n < edits; n += 1) {
    const at = Math.floor(random() * out.length)
    const op = Math.floor(random() * 4)
    const letter = out[at] ?? "e"
    const near = neighbours(letter)
    const other = near[Math.floor(random() * near.length)] ?? "e"
    if (op === 0 && out.length > 3) out = out.slice(0, at) + out.slice(at + 1)
    else if (op === 1) out = out.slice(0, at) + other + out.slice(at)
    else if (op === 2) out = out.slice(0, at) + other + out.slice(at + 1)
    else if (at < out.length - 1)
      out = out.slice(0, at) + out[at + 1] + out[at] + out.slice(at + 2)
  }
  return out
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ]!
}

function heapMb(): number {
  Bun.gc(true)
  return process.memoryUsage().heapUsed / 2 ** 20
}

// ── Run ───────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2))
const profile = (args.get("profile") ?? "1k") as ProfileName
const fileCount = Number(args.get("files") ?? "2000")
const samples = Number(args.get("samples") ?? "3000")
const out = args.get("out") ?? join(REPO_ROOT, "test-results")
mkdirSync(out, { recursive: true })

// A Worktable of real words (--workspace and --app, a copy kept on this
// machine), or a synthetic fixture with text files added.
const given = args.get("workspace")
const work = mkdtempSync(join(tmpdir(), "typo-bench-"))
if (given) {
  cpSync(given, join(work, "workspace"), { recursive: true })
  cpSync(args.get("app")!, join(work, "app"), { recursive: true })
} else {
  const dir = fixtureDir(profile, 1)
  if (!readFixture(dir)) {
    const generated = spawnSync(
      "bun",
      ["scripts/perf/fixtures.ts", "--profile", profile, "--seed", "1"],
      { cwd: REPO_ROOT, stdio: "inherit" }
    )
    if (generated.status !== 0) throw new Error("fixture failed")
  }
  cpSync(join(dir, "workspace"), join(work, "workspace"), { recursive: true })
  cpSync(join(dir, "app"), join(work, "app"), { recursive: true })
  addTextFiles(join(work, "workspace"), fileCount)
}
mkdirSync(join(work, "db"))
const built = spawnSync(
  "bun",
  [
    "scripts/perf/search-bench.ts",
    "--mode",
    "fts5-all",
    "--workspace",
    join(work, "workspace"),
    "--app",
    join(work, "app"),
    "--db",
    join(work, "db"),
  ],
  { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 2 ** 20 }
)
if (!built.stdout.includes("RESULT "))
  throw new Error(`index build failed:\n${built.stderr.slice(-3000)}`)
const db = new Database(join(work, "db", "search.sqlite"))
db.exec(
  "CREATE VIRTUAL TABLE IF NOT EXISTS vocab USING fts5vocab(pieces, 'row')"
)

// The word list, and what share of it is words people type.
const vocabStarted = performance.now()
const vocabulary = db
  .query("SELECT term, doc AS docs FROM vocab")
  .all() as Term[]
const vocabLoadMs = performance.now() - vocabStarted
const letters = vocabulary.filter((t) => /^\p{L}+$/u.test(t.term))
const report: Record<string, unknown> = {
  profile,
  vocabulary: vocabulary.length,
  wordsOfLetters: letters.length,
  vocabLoadMs,
}

// Targets: words of four or more letters that two or more items hold.
const random = seededRandom(7)
const eligible = letters.filter((t) => t.term.length >= 4 && t.docs >= 2)
const known = new Set(vocabulary.map((t) => t.term))
const cases: Array<{
  target: string
  typo: string
  edits: number
  firstLetter: boolean
}> = []
let realWord = 0
while (cases.length < samples && eligible.length > 0) {
  const target = eligible[Math.floor(random() * eligible.length)]!.term
  const edits = target.length >= 8 && random() < 0.2 ? 2 : 1
  const typo = misspell(target, random, edits)
  if (typo === target) continue
  if (known.has(typo)) {
    // A typo that is itself a word the index holds is never corrected.
    realWord += 1
    continue
  }
  cases.push({ target, typo, edits, firstLetter: typo[0] !== target[0] })
}
report["cases"] = cases.length
report["realWordTyposSkipped"] = realWord

type Method = (word: string) => Term[]
const methods: Record<
  string,
  { find: Method; setupMs: number; memoryMb?: number; diskMb?: number }
> = {}

// 1. The whole word list, scanned in JS.
methods["Scan all words"] = {
  find: (word) => rank(word, vocabulary),
  setupMs: vocabLoadMs,
}

// 2. Only words with the same first letter, read from the index by range.
const range = db.query(
  "SELECT term, doc AS docs FROM vocab WHERE term >= ? AND term < ?"
)
methods["Same first letter, read per search"] = {
  find: (word) =>
    rank(
      word,
      range.all(
        word[0]!,
        String.fromCodePoint(word.codePointAt(0)! + 1)
      ) as Term[]
    ),
  setupMs: 0,
}

// 3. A BK-tree in memory.
{
  const before = heapMb()
  const t = performance.now()
  let root: BkNode | null = null
  for (const term of vocabulary) root = bkInsert(root, term)
  const setupMs = performance.now() - t
  const memoryMb = heapMb() - before
  methods["BK-tree in memory"] = {
    find: (word) => rank(word, bkSearch(root!, word, budget(word))),
    setupMs,
    memoryMb,
  }
}

// 4. A trigram index of the words, on disk: candidates share a trigram.
{
  const t = performance.now()
  db.exec(
    "CREATE VIRTUAL TABLE grams USING fts5(term, docs UNINDEXED, tokenize = 'trigram')"
  )
  db.transaction(() => {
    const insert = db.query("INSERT INTO grams (term, docs) VALUES (?, ?)")
    for (const term of vocabulary) insert.run(term.term, term.docs)
  })()
  const setupMs = performance.now() - t
  const size = statSync(join(work, "db", "search.sqlite")).size
  const lookup = db.query(
    "SELECT term, docs FROM grams WHERE grams MATCH ? LIMIT 2000"
  )
  methods["Trigram index of words"] = {
    find: (word) => {
      const grams = new Set<string>()
      for (let i = 0; i + 3 <= word.length; i += 1)
        grams.add(`"${word.slice(i, i + 3).replaceAll('"', '""')}"`)
      if (grams.size === 0) return []
      return rank(word, lookup.all([...grams].join(" OR ")) as Term[])
    },
    setupMs,
    diskMb: size / 2 ** 20,
  }
}

const results: Record<string, unknown> = {}
const lines = [
  given
    ? "# Typo tolerance, a real Worktable"
    : `# Typo tolerance, ${profile} Docs plus threads and ${fileCount} text files`,
  "",
  `Word list: ${vocabulary.length} terms, ${letters.length} of them letters only. ${cases.length} misspellings of words two or more items hold (${cases.filter((c) => c.edits === 2).length} with two edits, ${cases.filter((c) => c.firstLetter).length} with the first letter wrong); ${realWord} more formed other real words and were left out.`,
  "",
  "| Method | Right word first | In top 3 | First-letter typos right | Lookup median / p95 | Setup | Extra memory / disk |",
  "|---|---|---|---|---|---|---|",
]
for (const [name, method] of Object.entries(methods)) {
  let first = 0
  let top3 = 0
  let firstLetterRight = 0
  const times: number[] = []
  for (const c of cases) {
    const t = performance.now()
    const found = method.find(c.typo)
    times.push(performance.now() - t)
    if (found[0]?.term === c.target) {
      first += 1
      if (c.firstLetter) firstLetterRight += 1
    }
    if (found.some((f) => f.term === c.target)) top3 += 1
  }
  const firstLetterCases = cases.filter((c) => c.firstLetter).length
  const pct = (n: number, of: number) =>
    `${of === 0 ? 0 : ((n / of) * 100).toFixed(0)}%`
  results[name] = {
    first,
    top3,
    firstLetterRight,
    medianMs: percentile(times, 50),
    p95Ms: percentile(times, 95),
    ...method,
  }
  lines.push(
    `| ${name} | ${pct(first, cases.length)} | ${pct(top3, cases.length)} | ${pct(firstLetterRight, firstLetterCases)} | ${percentile(times, 50).toFixed(2)} / ${percentile(times, 95).toFixed(2)} ms | ${method.setupMs.toFixed(0)} ms | ${method.memoryMb !== undefined ? `${method.memoryMb.toFixed(0)} MB memory` : method.diskMb !== undefined ? `index file now ${method.diskMb.toFixed(0)} MB` : "none"} |`
  )
}
lines.push(
  "",
  `Machine: ${navigator.hardwareConcurrency} CPUs, Bun ${Bun.version}.`,
  ""
)
db.close()
rmSync(work, { recursive: true, force: true })
report["methods"] = results
writeFileSync(
  join(out, `typo-bench-${given ? "real" : profile}.json`),
  JSON.stringify(
    report,
    (key, value) => (typeof value === "function" ? undefined : value),
    2
  )
)
writeFileSync(
  join(out, `typo-bench-${given ? "real" : profile}.md`),
  lines.join("\n")
)
console.log(lines.join("\n"))
