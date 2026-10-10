#!/usr/bin/env bun
/**
 * Bundle-size gate from the Vite manifest (Plan 15, W0-05).
 *
 *   bun scripts/perf/bundle.ts [--dist apps/web/dist/client] [--update] [--json <file>]
 *
 * Measures gzip (level 6, as the server compresses) and Brotli (quality 11)
 * sizes of the entry and its static imports, the root stylesheet, and the
 * JavaScript each route needs on first load. Fails when a gzip size exceeds its
 * budget in bundle-budgets.json. `--update` rewrites the budgets 2% above the
 * current sizes; Plan 15 targets are reported, not enforced.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"
import { REPO_ROOT, markdownTable, parseArgs } from "./lib.ts"

type Chunk = {
  file: string
  name?: string
  isEntry?: boolean
  imports?: string[]
}
type Manifest = Record<string, Chunk>

/**
 * Source modules each route loads before it renders, besides the entry. The
 * sidebar loads lazily on every app route; a document route also loads the
 * space layout and its renderer.
 */
const ROUTES: Record<string, string[]> = {
  home: ["src/routes/index.tsx", "src/components/app-sidebar.tsx"],
  space: ["src/routes/spaces/$spaceId.tsx", "src/components/app-sidebar.tsx"],
  "rich document": [
    "src/routes/spaces/$spaceId.tsx",
    "src/routes/spaces/$spaceId/documents/$.tsx",
    "src/components/doc-document.tsx",
    "src/components/editor/editor.tsx",
    "src/components/app-sidebar.tsx",
  ],
  "html document": [
    "src/routes/spaces/$spaceId.tsx",
    "src/routes/spaces/$spaceId/documents/$.tsx",
    "src/components/html-document.tsx",
    "src/components/app-sidebar.tsx",
  ],
}
const ROOT_CSS = "src/styles/app.css"
const BUDGETS_FILE = join(import.meta.dirname, "bundle-budgets.json")

interface Size {
  files: number
  raw: number
  gzip: number
  brotli: number
}

interface Budgets {
  $comment?: string
  budgets: Record<string, { gzip: number }>
  targets: Record<string, { gzip: number }>
}

/**
 * The manifest key for a source module. Route components are split into
 * `?tsr-split=component` chunks, and Rollup may promote a module into a shared
 * chunk keyed `_<name>-<hash>.js`.
 */
function resolveKey(manifest: Manifest, source: string): string {
  if (manifest[source]) return source
  if (manifest[`${source}?tsr-split=component`])
    return `${source}?tsr-split=component`
  const name = source
    .split("/")
    .at(-1)!
    .replace(/\.tsx?$/, "")
  const shared = Object.keys(manifest).filter(
    (key) => key.startsWith("_") && manifest[key]!.name === name
  )
  if (shared.length === 1) return shared[0]!
  throw new Error(
    `cannot find ${source} in the Vite manifest; update ROUTES in scripts/perf/bundle.ts`
  )
}

function staticClosure(manifest: Manifest, keys: string[]): string[] {
  const files = new Set<string>()
  const seen = new Set<string>()
  const visit = (key: string) => {
    if (seen.has(key)) return
    seen.add(key)
    const chunk = manifest[key]
    if (!chunk) throw new Error(`manifest has no chunk ${key}`)
    for (const dependency of chunk.imports ?? []) visit(dependency)
    files.add(chunk.file)
  }
  keys.forEach(visit)
  return [...files]
}

const fileSizes = new Map<string, Omit<Size, "files">>()

function measure(dist: string, files: string[]): Size {
  const size: Size = { files: files.length, raw: 0, gzip: 0, brotli: 0 }
  for (const file of files) {
    let one = fileSizes.get(file)
    if (!one) {
      const bytes = readFileSync(join(dist, file))
      one = {
        raw: bytes.length,
        gzip: gzipSync(bytes, { level: 6 }).length,
        brotli: brotliCompressSync(bytes, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
        }).length,
      }
      fileSizes.set(file, one)
    }
    size.raw += one.raw
    size.gzip += one.gzip
    size.brotli += one.brotli
  }
  return size
}

export function bundleSizes(dist: string): Record<string, Size> {
  const manifest = JSON.parse(
    readFileSync(join(dist, ".vite", "manifest.json"), "utf8")
  ) as Manifest
  const entries = Object.keys(manifest).filter((key) => manifest[key]!.isEntry)
  if (entries.length !== 1)
    throw new Error(
      `expected one entry in the Vite manifest, found ${entries.length}`
    )
  // The stylesheet is imported by URL, so its key is the absolute source path.
  const css = Object.keys(manifest).filter((key) => key.endsWith(ROOT_CSS))
  if (css.length !== 1)
    throw new Error(
      `expected one ${ROOT_CSS} in the Vite manifest, found ${css.length}`
    )
  const sizes: Record<string, Size> = {
    entry: measure(dist, staticClosure(manifest, entries)),
    "root css": measure(dist, [manifest[css[0]!]!.file]),
  }
  for (const [route, sources] of Object.entries(ROUTES)) {
    const keys = [
      ...entries,
      ...sources.map((source) => resolveKey(manifest, source)),
    ]
    sizes[route] = measure(dist, staticClosure(manifest, keys))
  }
  return sizes
}

const kb = (bytes: number | undefined) =>
  bytes === undefined ? null : Math.round(bytes / 100) / 10

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  const dist = resolve(REPO_ROOT, args.get("dist") ?? "apps/web/dist/client")
  const sizes = bundleSizes(dist)
  const config = JSON.parse(readFileSync(BUDGETS_FILE, "utf8")) as Budgets

  if (args.has("update")) {
    config.budgets = Object.fromEntries(
      Object.entries(sizes).map(([name, size]) => [
        name,
        { gzip: Math.ceil((size.gzip * 1.02) / 1000) * 1000 },
      ])
    )
    // One line per bundle, as Prettier leaves it.
    const json = JSON.stringify(config, null, 2).replace(
      /\{\n\s+"gzip": (\d+)\n\s+\}/g,
      '{ "gzip": $1 }'
    )
    writeFileSync(BUDGETS_FILE, `${json}\n`)
  }
  if (args.has("json"))
    writeFileSync(
      resolve(args.get("json")!),
      `${JSON.stringify(sizes, null, 2)}\n`
    )

  const over = Object.entries(sizes).filter(([name, size]) => {
    const budget = config.budgets[name]?.gzip
    return budget === undefined || size.gzip > budget
  })
  console.log(
    markdownTable(
      [
        "Bundle",
        "Files",
        "Raw KB",
        "Gzip KB",
        "Brotli KB",
        "Budget KB (gzip)",
        "Plan 15 target KB (gzip)",
      ],
      Object.entries(sizes).map(([name, size]) => [
        name,
        size.files,
        kb(size.raw),
        kb(size.gzip),
        kb(size.brotli),
        kb(config.budgets[name]?.gzip),
        kb(config.targets[name]?.gzip),
      ])
    )
  )
  if (over.length > 0) {
    console.error(
      `\nOver budget: ${over.map(([name]) => name).join(", ")}. Reduce the bundle, or raise the budget in scripts/perf/bundle-budgets.json with the reason in the pull request.`
    )
    process.exit(1)
  }
}
