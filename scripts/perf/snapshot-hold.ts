#!/usr/bin/env bun
/**
 * Live snapshot write hold on a Worktable with large, hot version history.
 *
 *   bun scripts/perf/snapshot-hold.ts --fixture <dir> [--build]
 *     [--hot 3] [--hot-versions 19000] [--documents 1000]
 *     [--checkout <dir> --label <name>]... [--rounds 2]
 *     [--quiet 10] [--loaded 5] [--out <file>]
 *
 * --build writes the fixture: ordinary Markdown documents through the managed
 * write path, plus hot documents whose history is written one generation per
 * save without coalescing, as the version store did before it coalesced.
 * Each round restores the fixture for every checkout in turn, boots its
 * server, takes --quiet operator snapshots with no load, then --loaded
 * snapshots while a writer saves a hot document every 200 ms and a reader
 * lists documents every 300 ms. Records captureBarrierMs and failures.
 */
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { DocumentId } from "@worktable/types"
import { setAppDirOverride } from "../../packages/server/src/app-storage.ts"
import { FixtureBuilder } from "../../packages/server/src/fixtures/harness.ts"
import { writeManagedFixtureDoc } from "../../packages/server/src/fixtures/managed-content.ts"
import {
  readDocumentGenerationV2,
  writeDocumentGenerationV2,
} from "../../packages/server/src/document-version-store-v2.ts"
import { mintVersionId } from "../../packages/server/src/version-store.ts"
import {
  clearedWorkspaceManifest,
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  writeWorkspaceManifest,
} from "../../packages/server/src/workspace.ts"
import {
  REPO_ROOT,
  median,
  numberArg,
  restoreFixture,
  startServer,
} from "./lib.ts"

const SPACE = "notes"

/** A short rich Doc whose text changes with each save. */
function blocks(title: string, save: number): unknown[] {
  const props = {
    textColor: "default",
    backgroundColor: "default",
    textAlignment: "left",
  }
  return [
    {
      id: "title",
      type: "heading",
      props: { ...props, level: 1 },
      content: [{ type: "text", text: title, styles: {} }],
      children: [],
    },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `p${index}`,
      type: "paragraph",
      props,
      content: [
        { type: "text", text: `Save ${save}, paragraph ${index}. ${"Notes ".repeat(30)}`, styles: {} },
      ],
      children: [],
    })),
  ]
}

function parse(argv: string[]) {
  const values = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!
    if (!name.startsWith("--")) continue
    const next = argv[index + 1]
    const value = next && !next.startsWith("--") ? next : "true"
    if (value !== "true") index += 1
    values.set(name.slice(2), [...(values.get(name.slice(2)) ?? []), value])
  }
  return values
}

async function build(
  dir: string,
  shape: { documents: number; hot: number; hotVersions: number }
) {
  rmSync(dir, { recursive: true, force: true })
  const workspace = join(dir, "workspace")
  const app = join(dir, "app")
  mkdirSync(app, { recursive: true })
  setAppDirOverride(app)
  const builder = new FixtureBuilder(workspace)
  setWorkspaceRootOverride(workspace)
  writeWorkspaceManifest(
    clearedWorkspaceManifest({ ...ensureWorkspaceManifest(), name: "Hold" })
  )
  await builder.space({ id: SPACE, name: "Notes" })
  const actor = { updatedBy: "user", source: "rest-api" }
  for (let index = 0; index < shape.documents; index += 1) {
    const result = await writeManagedFixtureDoc(
      SPACE,
      `folder-${index % 20}/note-${index}`,
      `# Note ${index}\n\n${"Ordinary text. ".repeat(40)}\n`,
      actor
    )
    if (!result.ok) throw new Error(result.error)
  }
  console.log(`[hold] ${shape.documents} documents written`)
  const documents = join(workspace, "versions", SPACE, "documents")
  const before = new Set(readdirSync(documents))
  for (let index = 0; index < shape.hot; index += 1) {
    const result = await writeManagedFixtureDoc(
      SPACE,
      `hot/hot-${index}`,
      blocks(`Hot ${index}`, 0),
      actor
    )
    if (!result.ok) throw new Error(result.error)
  }
  const hot = readdirSync(documents).filter((name) => !before.has(name))
  if (hot.length !== shape.hot) throw new Error("hot documents not found")
  const perDocument = Math.ceil(shape.hotVersions / shape.hot)
  // Old saves, one minute apart, ending an hour ago: inside any age retention.
  const start = Date.now() - 3_600_000 - perDocument * 60_000
  for (const documentId of hot as DocumentId[]) {
    const [generation] = readdirSync(join(documents, documentId)).filter(
      (name) => !name.startsWith(".")
    )
    const latest = await readDocumentGenerationV2({
      workspaceRoot: workspace,
      spaceId: SPACE,
      documentId,
      generationId: generation!,
    })
    if (!latest) throw new Error("hot document has no version")
    const { manifest } = latest
    for (let save = 0; save < perDocument; save += 1) {
      const createdAt = new Date(start + save * 60_000).toISOString()
      await writeDocumentGenerationV2({
        workspaceRoot: workspace,
        spaceId: SPACE,
        documentId,
        generationId: mintVersionId(createdAt),
        logicalPath: manifest.logicalPath,
        format: manifest.format,
        operation: "update",
        createdAt,
        createdBy: manifest.createdBy,
        source: manifest.source,
        authoredSource: latest.authoredSource,
        companions: latest.companions,
      })
      if ((save + 1) % 2000 === 0)
        console.log(`[hold] ${documentId}: ${save + 1}/${perDocument} versions`)
    }
  }
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  const count = (path: string): { files: number; directories: number } => {
    let files = 0
    let directories = 0
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        directories += 1
        const inner = count(join(path, entry.name))
        files += inner.files
        directories += inner.directories
      } else files += 1
    }
    return { files, directories }
  }
  const counts = {
    workspace: count(workspace),
    versions: count(join(workspace, "versions")),
  }
  writeFileSync(join(dir, "fixture.json"), JSON.stringify({ shape, counts }))
  console.log(`[hold] fixture ${JSON.stringify(counts)}`)
}

interface Snapshot {
  phase: "quiet" | "loaded"
  ok: boolean
  captureBarrierMs?: number
  publicationMs?: number
  files?: number
  error?: string
}

async function measure(options: {
  checkout: string
  label: string
  fixture: string
  quiet: number
  loaded: number
  hot: number
}) {
  const runDir = join(options.fixture, "..", `run-${options.label}`)
  const { workspace, app } = restoreFixture(options.fixture, runDir)
  const server = await startServer({
    checkout: options.checkout,
    workspace,
    app,
    env: { WT_DEBUG_HOLD: "1" },
  })
  const snapshots: Snapshot[] = []
  const load = { writes: [] as number[], writeErrors: 0, reads: [] as number[], readErrors: 0 }
  try {
    // Boot work (indexes, watchers) settles before measuring.
    await Bun.sleep(15_000)
    const token = readFileSync(join(app, "operator-runtime", "token"), "utf8").trim()
    const snapshot = async (phase: Snapshot["phase"]) => {
      const operationId = `hold-${randomUUID().slice(0, 12)}`
      try {
        const response = await fetch(`${server.url}/internal/operator/workspace-snapshot`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-worktable-local-operator": token,
          },
          body: JSON.stringify({ operationId }),
          signal: AbortSignal.timeout(600_000),
        })
        const text = await response.text()
        if (!response.ok) {
          snapshots.push({ phase, ok: false, error: `${response.status} ${text.slice(0, 300)}` })
        } else {
          const body = JSON.parse(text)
          snapshots.push({
            phase,
            ok: true,
            captureBarrierMs: Math.round(body.captureBarrierMs),
            publicationMs: Math.round(body.publicationMs),
            files: body.files,
          })
        }
      } catch (error) {
        snapshots.push({ phase, ok: false, error: String(error).slice(0, 300) })
      }
      rmSync(join(app, "operator-snapshots", operationId), { recursive: true, force: true })
      const last = snapshots.at(-1)!
      console.log(`[hold] ${options.label} ${phase}: ${JSON.stringify(last)}`)
    }
    for (let index = 0; index < options.quiet; index += 1) await snapshot("quiet")
    let running = true
    const writer = (async () => {
      let save = 0
      while (running) {
        const at = performance.now()
        try {
          const response = await fetch(
            `${server.url}/api/spaces/${SPACE}/docs/hot/hot-${save % options.hot}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: blocks(`Hot ${save % options.hot}`, save) }),
              signal: AbortSignal.timeout(120_000),
            }
          )
          const text = await response.text()
          if (!response.ok) {
            if (load.writeErrors === 0)
              console.log(`[hold] write failed: ${response.status} ${text.slice(0, 300)}`)
            load.writeErrors += 1
          }
        } catch (error) {
          if (load.writeErrors === 0) console.log(`[hold] write failed: ${error}`)
          load.writeErrors += 1
        }
        load.writes.push(performance.now() - at)
        save += 1
        await Bun.sleep(200)
      }
    })()
    const reader = (async () => {
      while (running) {
        const at = performance.now()
        try {
          const response = await fetch(
            `${server.url}/api/spaces/${SPACE}/documents?includeArchived=false`,
            { signal: AbortSignal.timeout(120_000) }
          )
          await response.arrayBuffer()
          if (!response.ok) load.readErrors += 1
        } catch {
          load.readErrors += 1
        }
        load.reads.push(performance.now() - at)
        await Bun.sleep(300)
      }
    })()
    // Let the writer build up recent history first.
    await Bun.sleep(3_000)
    for (let index = 0; index < options.loaded; index += 1) {
      await snapshot("loaded")
      await Bun.sleep(1_000)
    }
    running = false
    await Promise.all([writer, reader])
  } finally {
    for (const line of server.output().split("\n"))
      if (line.includes("DEBUG-HOLD") || line.includes("rror")) console.log(`[server ${options.label}] ${line.slice(0, 400)}`)
    await server.stop()
    rmSync(runDir, { recursive: true, force: true })
  }
  return { label: options.label, snapshots, load }
}

function summarize(runs: Awaited<ReturnType<typeof measure>>[]) {
  const labels = [...new Set(runs.map((run) => run.label))]
  const rows: string[] = []
  for (const label of labels) {
    const mine = runs.filter((run) => run.label === label)
    for (const phase of ["quiet", "loaded"] as const) {
      const all = mine.flatMap((run) => run.snapshots.filter((s) => s.phase === phase))
      const barrier = all.filter((s) => s.ok).map((s) => s.captureBarrierMs!)
      rows.push(
        `| ${label} | ${phase} | ${all.filter((s) => s.ok).length}/${all.length} | ${median(barrier)?.toFixed(0) ?? "-"} | ${barrier.length ? Math.max(...barrier) : "-"} | ${barrier.length ? Math.min(...barrier) : "-"} |`
      )
    }
    const writes = mine.flatMap((run) => run.load.writes)
    const reads = mine.flatMap((run) => run.load.reads)
    rows.push(
      `| ${label} | load | writes ${writes.length} (errors ${mine.reduce((s, r) => s + r.load.writeErrors, 0)}, max ${Math.max(0, ...writes).toFixed(0)} ms), reads ${reads.length} (errors ${mine.reduce((s, r) => s + r.load.readErrors, 0)}, max ${Math.max(0, ...reads).toFixed(0)} ms) | | | |`
    )
  }
  return [
    "| Source | Phase | Succeeded | Median barrier ms | Max | Min |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n")
}

if (import.meta.main) {
  const args = parse(process.argv.slice(2))
  const one = (name: string) => args.get(name)?.at(-1)
  const fixture = resolve(one("fixture") ?? join(REPO_ROOT, ".local-dev", "perf", "hold-fixture"))
  const flat = new Map([...args].map(([key, value]) => [key, value.at(-1)!]))
  if (one("build") === "true") {
    await build(fixture, {
      documents: numberArg(flat, "documents", 1000),
      hot: numberArg(flat, "hot", 3),
      hotVersions: numberArg(flat, "hot-versions", 19_000),
    })
  }
  const checkouts = args.get("checkout") ?? []
  const labels = args.get("label") ?? []
  if (checkouts.length) {
    const runs: Awaited<ReturnType<typeof measure>>[] = []
    const rounds = numberArg(flat, "rounds", 1)
    for (let round = 0; round < rounds; round += 1) {
      for (const [index, checkout] of checkouts.entries()) {
        runs.push(
          await measure({
            checkout: resolve(checkout),
            label: labels[index] ?? `checkout-${index}`,
            fixture,
            quiet: numberArg(flat, "quiet", 10),
            loaded: numberArg(flat, "loaded", 5),
            hot: numberArg(flat, "hot", 3),
          })
        )
      }
    }
    const summary = summarize(runs)
    console.log(summary)
    const out = one("out")
    if (out) {
      mkdirSync(join(out, ".."), { recursive: true })
      writeFileSync(out, JSON.stringify({ runs, summary }, null, 2))
    }
  }
}
