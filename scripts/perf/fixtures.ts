#!/usr/bin/env bun
/**
 * Seeded perf fixtures (Plan 15, W0-03).
 *
 *   bun scripts/perf/fixtures.ts --profile 1k [--seed 1] [--out <dir>] [--force]
 *
 * Writes <out>/<profile>-seed<seed>/{workspace,app,fixture.json}. Documents go
 * through the managed write paths that REST and MCP use, so identity,
 * provenance, version history and activity are real. Spaces, records and
 * threads use the canonical fixture builders. Content is deterministic for a
 * seed; ids and save times assigned by the store are not.
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type {
  ActivityAction,
  ActivityActor,
  WidgetFile,
} from "@worktable/types"
import {
  recordActivity,
  drainActivity,
} from "../../packages/server/src/activity-log.ts"
import { setAppDirOverride } from "../../packages/server/src/app-storage.ts"
import {
  blockDoc,
  type BlockItem,
} from "../../packages/server/src/fixtures/blocks.ts"
import { FixtureBuilder } from "../../packages/server/src/fixtures/harness.ts"
import {
  writeManagedFixtureDoc,
  writeManagedFixtureHtml,
} from "../../packages/server/src/fixtures/managed-content.ts"
import { fixtureThread } from "../../packages/server/src/fixtures/threads.ts"
import {
  clearedWorkspaceManifest,
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  writeWorkspaceManifest,
} from "../../packages/server/src/workspace.ts"
import { PERF_ROOT, numberArg, parseArgs, seededRandom } from "./lib.ts"

export const PROFILES = {
  "100": {
    docs: 100,
    htmlSpaceDocs: 20,
    activity: 2_000,
    threads: 20,
    messages: 50,
    collections: 2,
    records: 200,
  },
  "1k": {
    docs: 1_000,
    htmlSpaceDocs: 200,
    activity: 50_000,
    threads: 500,
    messages: 50,
    collections: 20,
    records: 2_000,
  },
  "5k": {
    docs: 5_000,
    htmlSpaceDocs: 200,
    activity: 50_000,
    threads: 500,
    messages: 50,
    collections: 20,
    records: 2_000,
  },
} as const
export type ProfileName = keyof typeof PROFILES

export interface DocRef {
  spaceId: string
  path: string
}

/** Written last; its presence marks a complete fixture. */
export interface FixtureManifest {
  generator: string
  profile: ProfileName
  seed: number
  generatedAt: string
  durationsMs: Record<string, number>
  counts: Record<string, number>
  spaces: string[]
  htmlSpace: string
  probes: { rich2000: DocRef; rich5000: DocRef; markdown: DocRef; html: DocRef }
  searchTerms: string[]
}

/** Changes to this file invalidate cached fixtures. */
export const GENERATOR_VERSION = createHash("sha256")
  .update(readFileSync(import.meta.filename))
  .digest("hex")
  .slice(0, 12)

export function fixtureDir(
  profile: ProfileName,
  seed: number,
  out = join(PERF_ROOT, "fixtures")
): string {
  return join(out, `${profile}-seed${seed}`)
}

/** The manifest of a complete fixture built by this generator, or null. */
export function readFixture(dir: string): FixtureManifest | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dir, "fixture.json"), "utf8")
    ) as FixtureManifest
    return manifest.generator === GENERATOR_VERSION ? manifest : null
  } catch {
    return null
  }
}

const WORDS = (
  "account adoption agent alert analysis approval archive audit backlog baseline billing budget cache " +
  "campaign capacity checkout churn client cluster cohort compliance contract cost customer dashboard " +
  "dataset deadline decision deploy design discount draft escalation estimate experiment export feature " +
  "feedback forecast funnel goal hiring incident index insight integration invoice issue latency launch " +
  "ledger lifecycle limit margin market metric migration milestone model onboarding outage owner partner " +
  "payment pipeline plan platform policy pricing priority project proposal quarter queue quota rebate " +
  "reconciliation refund region release report request research retention review revenue risk roadmap " +
  "rollout runbook schema search segment service signal sprint stakeholder status storage strategy " +
  "subscription summary supplier support survey sync target task team template tenant ticket timeline " +
  "tracking transfer trial update usage vendor webhook workflow"
).split(" ")
const SPACE_NAMES = [
  "Engineering",
  "Product",
  "Operations",
  "Finance",
  "Design",
  "Research",
  "Support",
  "Marketing",
  "Sales",
  "Legal",
  "People",
  "Data",
  "Platform",
  "Security",
  "Partnerships",
  "Infrastructure",
  "Growth",
  "Customer Success",
  "Strategy",
  "Analytics",
]
const FOLDERS = [
  "notes",
  "meetings",
  "specs",
  "plans",
  "reviews",
  "projects",
  "runbooks",
  "decisions",
]
const SEARCH_TERMS = [
  "ledger reconciliation",
  "incident runbook",
  "pricing experiment",
  "quarterly roadmap",
  "webhook latency",
  "vendor contract",
]
const HUMAN = { updatedBy: "user", source: "rest-api" }
const AGENT = { updatedBy: "agent:claude", source: "mcp" }
const ACTORS: ActivityActor[] = [
  { kind: "person", id: "local:owner" },
  { kind: "agent", id: "claude", name: "Claude" },
  { kind: "agent", id: "codex", name: "Codex" },
]

class Text {
  readonly random: () => number
  constructor(random: () => number) {
    this.random = random
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1))
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)]!
  }
  words(count: number): string {
    return Array.from({ length: count }, () => this.pick(WORDS)).join(" ")
  }
  title(): string {
    const text = this.words(this.int(2, 5))
    return text[0]!.toUpperCase() + text.slice(1)
  }
  paragraph(min = 30, max = 110): string {
    const text = this.words(this.int(min, max))
    return `${text[0]!.toUpperCase()}${text.slice(1)}.`
  }
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function markdownDoc(
  text: Text,
  title: string,
  links: DocRef[],
  minBytes = 0
): string {
  const parts = [`# ${title}`, "", text.paragraph()]
  const sections = text.int(1, 8)
  for (
    let section = 0;
    section < sections || parts.join("\n").length < minBytes;
    section += 1
  ) {
    parts.push("", `## ${text.title()}`, "", text.paragraph())
    if (text.random() < 0.4)
      parts.push(
        "",
        ...Array.from(
          { length: text.int(2, 6) },
          () => `- ${text.words(text.int(3, 12))}`
        )
      )
    if (text.random() < 0.15)
      parts.push(
        "",
        "```ts",
        `export const ${slug(text.words(2)).replace(/-/g, "_")} = ${text.int(1, 999)}`,
        "```"
      )
    if (links.length > 0 && text.random() < 0.5) {
      const target = text.pick(links)
      parts.push("", `See [${target.path.split("/").at(-1)}](/${target.path}).`)
    }
    if (text.random() < 0.5) parts.push("", text.paragraph())
  }
  return `${parts.join("\n")}\n`
}

function richBlocks(
  text: Text,
  title: string,
  count: number,
  prefix: string,
  mermaid: boolean
): unknown[] {
  const items: BlockItem[] = [
    { id: `${prefix}-0`, type: "heading", text: title, level: 1 },
  ]
  for (let index = 1; index < count; index += 1) {
    const id = `${prefix}-${index}`
    if (mermaid && index === 2) {
      items.push({
        id,
        type: "mermaid",
        text: "graph TD\n  A[Request] --> B[Review]\n  B --> C[Ship]",
        title: "Flow",
      })
    } else if (index % 12 === 0)
      items.push({ id, type: "heading", text: text.title(), level: 2 })
    else if (text.random() < 0.03)
      items.push({
        id,
        type: "codeBlock",
        text: `${text.words(6)}\n${text.words(8)}`,
        language: "text",
      })
    else items.push({ id, type: "paragraph", text: text.paragraph(10, 60) })
  }
  return blockDoc(...items)
}

function richBlockCount(text: Text): number {
  const roll = text.random()
  if (roll < 0.85) return text.int(5, 120)
  if (roll < 0.97) return text.int(120, 1_000)
  return text.int(1_000, 5_000)
}

function htmlDoc(text: Text, title: string): string {
  const rows = Array.from(
    { length: text.int(10, 80) },
    () =>
      `<tr><td>${text.title()}</td><td>${text.pick(WORDS)}</td><td>${text.int(1, 9_999)}</td><td>${text.int(1, 100)}%</td></tr>`
  ).join("\n")
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 24px; color: #1f2328; }
table { border-collapse: collapse; width: 100%; }
td, th { border-bottom: 1px solid #d0d7de; padding: 6px 8px; text-align: left; }
.summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
</style>
</head>
<body>
<h1>${title}</h1>
<p>${text.paragraph()}</p>
<div class="summary"><div>${text.int(1, 999)} open</div><div>${text.int(1, 999)} closed</div><div>${text.int(1, 99)}% on time</div></div>
<table><thead><tr><th>Item</th><th>Area</th><th>Count</th><th>Share</th></tr></thead>
<tbody>
${rows}
</tbody></table>
<script>document.querySelectorAll("td").forEach((cell) => cell.addEventListener("click", () => cell.classList.toggle("selected")))</script>
</body>
</html>
`
}

function widgetFile(id: string, name: string, createdBy: string): WidgetFile {
  return {
    version: 1,
    kind: "worktable.widget",
    id,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy,
    metadata: {},
    runtime: { type: "html", entry: "index.html" },
    permissions: {
      network: false,
      records: {},
      state: { read: true, write: true },
    },
  } as WidgetFile
}

type Kind = "md" | "rich" | "html"
interface PlannedDoc extends DocRef {
  kind: Kind
  title: string
  blocks?: number
}

/** Exact 70/25/5 split, shuffled; the four probe documents count toward it. */
function planDocs(text: Text, total: number, spaces: string[]): PlannedDoc[] {
  const md = Math.round(total * 0.7) - 1
  const html = Math.round(total * 0.05) - 1
  const rich = total - md - html - 4
  const kinds: Kind[] = [
    ...Array(md).fill("md"),
    ...Array(rich).fill("rich"),
    ...Array(html).fill("html"),
  ]
  for (let index = kinds.length - 1; index > 0; index -= 1) {
    const other = Math.floor(text.random() * (index + 1))
    ;[kinds[index], kinds[other]] = [kinds[other]!, kinds[index]!]
  }
  // Mildly uneven spaces: the first holds the most documents.
  const weights = spaces.map((_, index) => 1 / Math.sqrt(index + 1))
  const sum = weights.reduce((left, right) => left + right, 0)
  const sizes = weights.map((weight) =>
    Math.floor(((total - 4) * weight) / sum)
  )
  sizes[0]! += total - 4 - sizes.reduce((left, right) => left + right, 0)
  const docs: PlannedDoc[] = [
    {
      spaceId: spaces[0]!,
      path: "perf/rich-2000",
      kind: "rich",
      title: "Rich 2000",
      blocks: 2_000,
    },
    {
      spaceId: spaces[0]!,
      path: "perf/rich-5000",
      kind: "rich",
      title: "Rich 5000",
      blocks: 5_000,
    },
    {
      spaceId: spaces[0]!,
      path: "perf/markdown",
      kind: "md",
      title: "Markdown probe",
    },
    {
      spaceId: spaces[0]!,
      path: "perf/html",
      kind: "html",
      title: "HTML probe",
    },
  ]
  let next = 0
  spaces.forEach((spaceId, space) => {
    for (let index = 0; index < sizes[space]!; index += 1) {
      const kind = kinds[next]!
      const title = text.title()
      const depth = text.random()
      const folder =
        depth < 0.3
          ? ""
          : depth < 0.8
            ? `${text.pick(FOLDERS)}/`
            : `${text.pick(FOLDERS)}/${slug(text.words(1))}/`
      docs.push({
        spaceId,
        path: `${folder}${slug(title)}-${next}`,
        kind,
        title,
        ...(kind === "rich" ? { blocks: richBlockCount(text) } : {}),
      })
      next += 1
    }
  })
  return docs
}

async function writeDocument(
  text: Text,
  doc: PlannedDoc,
  index: number,
  siblings: DocRef[]
): Promise<void> {
  const attribution = index % 5 < 3 ? HUMAN : AGENT
  if (doc.kind === "html") {
    const written = await writeManagedFixtureHtml(
      doc.spaceId,
      widgetFile(doc.path, doc.title, attribution.updatedBy),
      htmlDoc(text, doc.title)
    )
    written.release?.()
    if (written.error)
      throw new Error(`${doc.spaceId}/${doc.path}: ${written.error}`)
    return
  }
  const content =
    doc.kind === "md"
      ? markdownDoc(
          text,
          doc.title,
          siblings,
          doc.path === "perf/markdown" ? 12_000 : 0
        )
      : richBlocks(text, doc.title, doc.blocks!, `b${index}`, index % 40 === 7)
  const result = await writeManagedFixtureDoc(
    doc.spaceId,
    doc.path,
    content,
    attribution
  )
  if (!result.ok) throw new Error(`${doc.spaceId}/${doc.path}: ${result.error}`)
}

interface ThreadRef {
  id: string
  spaceId: string | null
}

/** Owner and agent take turns; every tenth thread ends waiting on the owner. */
function writeThreads(
  text: Text,
  count: number,
  messages: number,
  spaces: string[]
): ThreadRef[] {
  const owner = {
    id: "ptc_perf_owner0001",
    kind: "human" as const,
    name: "Owner",
  }
  const threads: ThreadRef[] = []
  for (let index = 0; index < count; index += 1) {
    const agent = {
      id: `ptc_perf_agent${String(index % 3).padStart(4, "0")}`,
      kind: "agent" as const,
      name: ["Claude", "Codex", "Atlas"][index % 3]!,
    }
    const id = `thr_perf_${String(index).padStart(8, "0")}`
    const spaceId = index % 10 < 3 ? null : spaces[index % spaces.length]!
    const start = Date.parse("2026-06-01T00:00:00.000Z") + index * 3_600_000
    fixtureThread({
      id,
      title: text.title(),
      location:
        spaceId === null ? { kind: "worktable" } : { kind: "space", spaceId },
      participants: [owner, agent],
      messages: Array.from({ length: messages }, (_, message) => {
        const fromOwner = message % 2 === 0
        const waitsOnOwner =
          !fromOwner && message === messages - 1 && index % 10 === 9
        return {
          id: `msg_perf_${String(index).padStart(6, "0")}_${String(message).padStart(3, "0")}`,
          authorId: fromOwner ? owner.id : agent.id,
          recipientIds: [fromOwner ? agent.id : owner.id],
          body: Array.from({ length: text.int(1, 4) }, () =>
            text.paragraph(20, 90)
          ).join("\n\n"),
          ...(message > 0
            ? {
                inReplyTo: `msg_perf_${String(index).padStart(6, "0")}_${String(message - 1).padStart(3, "0")}`,
              }
            : {}),
          expectsReply: fromOwner || waitsOnOwner,
          idempotencyKey: `perf-${index}-${message}`,
          createdAt: new Date(start + message * 60_000).toISOString(),
        }
      }),
    })
    threads.push({ id, spaceId })
  }
  return threads
}

async function writeRecords(
  builder: FixtureBuilder,
  text: Text,
  collections: number,
  records: number,
  spaces: string[]
): Promise<{ spaceId: string; id: string }[]> {
  const written: { spaceId: string; id: string }[] = []
  for (let index = 0; index < collections; index += 1) {
    const spaceId = spaces[index % spaces.length]!
    const id = `${slug(text.pick(WORDS))}-${index}`
    await builder.recordCollection(spaceId, {
      id,
      name: text.title(),
      fields: {
        title: { type: "string", required: true },
        status: {
          type: "enum",
          values: ["open", "active", "blocked", "done"],
          required: true,
        },
        owner: { type: "string" },
        amount: { type: "number" },
        due: { type: "date" },
      },
    })
    for (let record = 0; record < records; record += 1) {
      await builder.record(spaceId, id, {
        id: `r-${String(record).padStart(5, "0")}`,
        data: {
          title: text.title(),
          status: text.pick(["open", "active", "blocked", "done"]),
          owner: text.pick(["ana", "ben", "chen", "dara", "eli"]),
          amount: text.int(1, 100_000),
          due: `2026-${String(text.int(1, 12)).padStart(2, "0")}-${String(text.int(1, 28)).padStart(2, "0")}`,
        },
      })
    }
    written.push({ spaceId, id })
  }
  return written
}

/** Synthetic history over the 90 days before a fixed date, oldest first. */
async function writeActivity(
  text: Text,
  count: number,
  docs: DocRef[],
  threads: ThreadRef[],
  collections: { spaceId: string; id: string }[]
): Promise<void> {
  const end = Date.parse("2026-10-01T00:00:00.000Z")
  const step = Math.floor((90 * 86_400_000) / count)
  for (let index = 0; index < count; index += 1) {
    const at = new Date(end - (count - index) * step).toISOString()
    const actor = ACTORS[index % ACTORS.length]!
    const roll = text.random()
    if (roll < 0.1 && threads.length > 0) {
      const thread = text.pick(threads)
      recordActivity({
        spaceId: thread.spaceId,
        action: "thread.replied",
        actor,
        at,
        target: { kind: "thread", threadId: thread.id },
      })
    } else if (roll < 0.2 && collections.length > 0) {
      const collection = text.pick(collections)
      recordActivity({
        spaceId: collection.spaceId,
        action: "records.updated",
        actor,
        at,
        count: text.int(1, 20),
        target: { kind: "collection", collectionId: collection.id },
      })
    } else {
      // Step through documents so one actor never edits the same one twice in
      // a 15-minute session, which recordActivity would merge.
      const doc = docs[(index * 7919) % docs.length]!
      const action: ActivityAction =
        roll < 0.3 ? "comment.created" : "doc.edited"
      recordActivity({
        spaceId: doc.spaceId,
        action,
        actor,
        at,
        target: { kind: "doc", path: doc.path },
        ...(action === "comment.created"
          ? { quote: text.paragraph(5, 25), category: "comment" as const }
          : {}),
      })
    }
  }
  await drainActivity()
}

async function generate(
  profile: ProfileName,
  seed: number,
  dir: string
): Promise<FixtureManifest> {
  const shape = PROFILES[profile]
  const text = new Text(seededRandom(seed))
  rmSync(dir, { recursive: true, force: true })
  const workspace = join(dir, "workspace")
  const app = join(dir, "app")
  mkdirSync(app, { recursive: true })
  setAppDirOverride(app)
  const builder = new FixtureBuilder(workspace)
  setWorkspaceRootOverride(workspace)
  const manifest = ensureWorkspaceManifest()
  writeWorkspaceManifest(
    clearedWorkspaceManifest({ ...manifest, name: `Perf ${profile}` })
  )

  const durationsMs: Record<string, number> = {}
  let lap = performance.now()
  const phase = (name: string) => {
    const now = performance.now()
    durationsMs[name] = Math.round(now - lap)
    console.log(
      `[perf-fixtures] ${name}: ${(durationsMs[name]! / 1000).toFixed(1)} s`
    )
    lap = now
  }

  const spaceCount = Math.max(
    2,
    Math.min(SPACE_NAMES.length, Math.round(shape.docs / 100))
  )
  const spaces = SPACE_NAMES.slice(0, spaceCount).map(slug)
  const htmlSpace = "dashboards"
  for (const [index, id] of [...spaces, htmlSpace].entries()) {
    await builder.space({
      id,
      name: id === htmlSpace ? "Dashboards" : SPACE_NAMES[index]!,
    })
  }

  const docs = planDocs(text, shape.docs, spaces)
  const linkable = (spaceId: string) =>
    docs.filter((doc) => doc.spaceId === spaceId && doc.kind !== "html")
  const links = new Map(spaces.map((spaceId) => [spaceId, linkable(spaceId)]))
  for (const [index, doc] of docs.entries()) {
    await writeDocument(text, doc, index, links.get(doc.spaceId)!)
    if ((index + 1) % 250 === 0)
      console.log(`[perf-fixtures] documents ${index + 1}/${docs.length}`)
  }
  phase("documents")

  for (let index = 0; index < shape.htmlSpaceDocs; index += 1) {
    const title = text.title()
    const folder =
      index % 4 === 0 ? "" : `${text.pick(["weekly", "reports", "boards"])}/`
    await writeDocument(
      text,
      {
        spaceId: htmlSpace,
        path: `${folder}${slug(title)}-${index}`,
        kind: "html",
        title,
      },
      index,
      []
    )
  }
  phase("htmlSpace")

  const collections = await writeRecords(
    builder,
    text,
    shape.collections,
    shape.records,
    spaces
  )
  phase("records")
  const threads = writeThreads(text, shape.threads, shape.messages, spaces)
  phase("threads")
  await writeActivity(text, shape.activity, docs, threads, collections)
  phase("activity")
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)

  const count = (kind: Kind) => docs.filter((doc) => doc.kind === kind).length
  const probe = (path: string) => ({ spaceId: spaces[0]!, path })
  const result: FixtureManifest = {
    generator: GENERATOR_VERSION,
    profile,
    seed,
    generatedAt: new Date().toISOString(),
    durationsMs,
    counts: {
      spaces: spaces.length + 1,
      documents: docs.length,
      markdown: count("md"),
      richText: count("rich"),
      richTextBlocks: docs.reduce((sum, doc) => sum + (doc.blocks ?? 0), 0),
      html: count("html"),
      htmlSpaceDocuments: shape.htmlSpaceDocs,
      activityEvents: shape.activity,
      threads: shape.threads,
      threadMessages: shape.threads * shape.messages,
      collections: shape.collections,
      records: shape.collections * shape.records,
    },
    spaces,
    htmlSpace,
    probes: {
      rich2000: probe("perf/rich-2000"),
      rich5000: probe("perf/rich-5000"),
      markdown: probe("perf/markdown"),
      html: probe("perf/html"),
    },
    searchTerms: SEARCH_TERMS,
  }
  writeFileSync(
    join(dir, "fixture.json"),
    `${JSON.stringify(result, null, 2)}\n`
  )
  return result
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  const profile = (args.get("profile") ?? "100") as ProfileName
  if (!(profile in PROFILES))
    throw new Error(
      `--profile must be one of ${Object.keys(PROFILES).join(", ")}`
    )
  const seed = numberArg(args, "seed", 1)
  const out = args.get("out")
  const dir = fixtureDir(profile, seed, out ? resolve(out) : undefined)
  if (!args.has("force") && readFixture(dir)) {
    console.log(`[perf-fixtures] ${dir} is current`)
  } else {
    const started = performance.now()
    const manifest = await generate(profile, seed, dir)
    console.log(
      `[perf-fixtures] wrote ${dir} in ${((performance.now() - started) / 1000).toFixed(1)} s`
    )
    console.log(JSON.stringify(manifest.counts))
  }
  process.exit(0)
}
