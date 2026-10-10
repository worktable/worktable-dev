import { readFileSync } from "node:fs"
import { join } from "node:path"

export type DocumentPreloads = Record<
  "rich-text" | "markdown" | "html",
  string[]
>
type Chunk = {
  file: string
  name?: string
  isEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
}
type Manifest = Record<string, Chunk>

function readManifest(staticDir: string): Manifest | null {
  try {
    return JSON.parse(
      readFileSync(join(staticDir, ".vite/manifest.json"), "utf8")
    ) as Manifest
  } catch {
    // Older release assets and development builds have no manifest.
    return null
  }
}

// Route modules are split by TanStack Router. Rollup can also promote a
// dynamically imported module into a shared chunk; Vite then keys it by
// output name ("_name-hash.js") instead of source. Chunk names are file names,
// so they collide across directories: only a unique shared chunk qualifies.
function manifestKey(
  manifest: Manifest,
  source: string,
  candidates: readonly string[] = Object.keys(manifest)
): string | null {
  for (const key of [`${source}?tsr-split=component`, source])
    if (manifest[key]) return key
  const name = source
    .split("/")
    .at(-1)!
    .replace(/\.tsx$/, "")
  const shared = [
    ...new Set(
      candidates.filter(
        (key) => key.startsWith("_") && manifest[key]?.name === name
      )
    ),
  ]
  return shared.length === 1 ? shared[0]! : null
}

// Vite's build manifest is the only source of hashed asset names. Follow static
// imports, not optional dynamic features such as Mermaid or the source editor.
function staticImports(manifest: Manifest, keys: string[]): string[] {
  const files = new Set<string>()
  const seen = new Set<string>()
  const visit = (key: string) => {
    if (seen.has(key)) return
    seen.add(key)
    const chunk = manifest[key]
    if (!chunk) return
    for (const dependency of chunk.imports ?? []) visit(dependency)
    if (/^assets\/[\w./-]+\.js$/.test(chunk.file) && !chunk.file.includes(".."))
      files.add(`/${chunk.file}`)
  }
  keys.forEach(visit)
  return [...files]
}

function sourcesClosure(manifest: Manifest, sources: readonly string[]) {
  return staticImports(
    manifest,
    sources.flatMap((source) => manifestKey(manifest, source) ?? [])
  )
}

export function readDocumentPreloads(staticDir: string): DocumentPreloads {
  const manifest = readManifest(staticDir)
  if (!manifest) return { "rich-text": [], markdown: [], html: [] }
  const renderer = manifestKey(manifest, "src/components/doc-document.tsx")
  // The rich-text editor is the renderer's own dynamic import. Settings has an
  // "editor" chunk too, so never resolve it by name across the whole build.
  const editor =
    renderer &&
    manifestKey(
      manifest,
      "src/components/editor/editor.tsx",
      manifest[renderer]?.dynamicImports
    )
  return {
    "rich-text": staticImports(
      manifest,
      [renderer, editor].filter((key): key is string => Boolean(key))
    ),
    markdown: renderer ? staticImports(manifest, [renderer]) : [],
    html: sourcesClosure(manifest, ["src/components/html-document.tsx"]),
  }
}

const SPACE = "src/routes/spaces/$spaceId.tsx"
const SIDEBAR = "src/components/app-sidebar.tsx"
// The first match wins. Every page except sign-in renders the sidebar.
const APP_ROUTES: ReadonlyArray<readonly [string, RegExp, readonly string[]]> =
  [
    ["login", /^\/login\/?$/, ["src/routes/login.tsx"]],
    ["home", /^\/$/, ["src/routes/index.tsx", SIDEBAR]],
    ["activity", /^\/activity\/?$/, ["src/routes/activity.tsx", SIDEBAR]],
    ["connect", /^\/connect\/?$/, ["src/routes/connect.tsx", SIDEBAR]],
    ["threads", /^\/threads(?:\/|$)/, ["src/routes/threads/$.tsx", SIDEBAR]],
    [
      "document",
      /^\/spaces\/[^/]+\/documents\/./,
      [SPACE, "src/routes/spaces/$spaceId/documents/$.tsx", SIDEBAR],
    ],
    [
      "record",
      /^\/spaces\/[^/]+\/records\/[^/]+\/[^/]+\/?$/,
      [
        SPACE,
        "src/routes/spaces/$spaceId/records/$collectionId/$recordId.tsx",
        SIDEBAR,
      ],
    ],
    [
      "records",
      /^\/spaces\/[^/]+\/records(?:\/|$)/,
      [SPACE, "src/routes/spaces/$spaceId/records/$.tsx", SIDEBAR],
    ],
    [
      "space-threads",
      /^\/spaces\/[^/]+\/threads(?:\/|$)/,
      [SPACE, "src/routes/spaces/$spaceId/threads/$.tsx", SIDEBAR],
    ],
    ["space", /^\/spaces\/[^/]+\/?$/, [SPACE, SIDEBAR]],
    ["other", /^/, [SIDEBAR]],
  ]

export interface RoutePreloads {
  /** Modules the page needs on every route: the entry and its imports. */
  entry: ReadonlySet<string>
  /** The route a path opens, and the modules it adds to the entry. */
  forPath(pathname: string): { route: string; files: string[] }
}

export function readRoutePreloads(staticDir: string): RoutePreloads | null {
  const manifest = readManifest(staticDir)
  if (!manifest) return null
  const entry = new Set(
    staticImports(
      manifest,
      Object.keys(manifest).filter((key) => manifest[key]!.isEntry)
    )
  )
  const routes = APP_ROUTES.map(
    ([route, pattern, sources]) =>
      [
        route,
        pattern,
        sourcesClosure(manifest, sources).filter((file) => !entry.has(file)),
      ] as const
  )
  return {
    entry,
    forPath(pathname) {
      const [route, , files] = routes.find(([, pattern]) =>
        pattern.test(pathname)
      )!
      return { route, files }
    },
  }
}

const MODULE_PRELOAD = /<link\b[^>]*\brel="modulepreload"[^>]*>/g

/**
 * The prerendered shell is the home page, so it bakes in the home route's
 * modules. Keep only the entry's, then add the requested route's.
 */
export function shellWithRoutePreloads(
  shell: string,
  entry: ReadonlySet<string>,
  files: readonly string[]
): string {
  let insertAt = -1
  let removed = 0
  const kept = shell.replace(MODULE_PRELOAD, (link, offset: number) => {
    const href = /\bhref="([^"]+)"/.exec(link)?.[1]
    if (href && !entry.has(href)) {
      removed += link.length
      return ""
    }
    insertAt = offset - removed + link.length
    return link
  })
  if (insertAt < 0) insertAt = kept.indexOf("</head>")
  if (insertAt < 0) return kept
  const links = files
    .map((href) => `<link rel="modulepreload" href="${href}"/>`)
    .join("")
  return kept.slice(0, insertAt) + links + kept.slice(insertAt)
}
