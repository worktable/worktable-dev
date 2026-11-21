import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"
import { build, type Plugin as EsbuildPlugin } from "esbuild"
import type { Plugin } from "vite"
import { HTML_DOC_THEME } from "../../packages/ui/src/lib/html-doc-theme.generated"
import {
  contributingPackages,
  renderDependencyNotices,
  separateNotices,
} from "../../scripts/dependency-notices"

// Viewer frames: the documents that show files whose formats have to be
// parsed, such as a PDF. Each is built here into ONE self-contained
// document: the viewer's code, its worker's code and its styles are inside
// it, each allowed by its hash, and its policy lets it fetch nothing.
//
// It has to be one document. The server gives a frame no origin, and a
// browser keeps no cache for what a document with no origin loads, so
// separate script files would be fetched again every time a file opens.
// The document itself is a navigation and is cached like any other.

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

export interface ViewerFrameBuild {
  /** The viewer's key, and its folder in the build. */
  key: string
  /** The frame document. */
  html: string
  /** The Content-Security-Policy the server sends with it. */
  csp: string
  /** The viewer's public files, by path under its `files` folder. */
  files: Map<string, Uint8Array>
}

const sha256 = (text: string) =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`

// Text inside a script or style element must not end the element, nor open
// an HTML comment. Both replacements read the same to JavaScript and CSS.
const inScript = (code: string) =>
  code.replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--")
const inStyle = (css: string) => css.replaceAll("</style", "<\\/style")

/**
 * The policy of a viewer frame. `sandbox allow-scripts` takes the document's
 * origin away wherever it is opened. Its own script is allowed by hash, and
 * its style too, unless the viewer draws with inline styles; a worker starts
 * only from a blob of the code the document carries; nothing may be fetched,
 * framed, submitted or navigated to.
 */
export function viewerFrameCsp(hashes: {
  script: string
  /** The style's hash, or "inline" for a viewer that sets styles itself. */
  style: string
}): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    // WebAssembly: pdf.js decodes JPEG 2000, JBIG2 and colour profiles with
    // it, and Word files are read by a WebAssembly engine.
    `script-src ${hashes.script} 'wasm-unsafe-eval'`,
    "worker-src blob:",
    // Inline styles can't run code, and with nothing to fetch, nothing
    // they say can leave the frame.
    `style-src ${hashes.style === "inline" ? "'unsafe-inline'" : hashes.style}`,
    "img-src blob: data:",
    "font-src blob: data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ")
}

/** The colours every viewer frame takes from the app's theme. */
function themeStyles(): string {
  const { light, dark } = HTML_DOC_THEME
  type Theme = Readonly<Record<keyof typeof dark, string>>
  // Pages sit on the app's card in dark mode and its canvas in light mode,
  // and the page browser one step away from them.
  const roles = (theme: Theme, background: string, rail: string) =>
    [
      `--viewer-background: ${background}`,
      `--viewer-rail: ${rail}`,
      `--viewer-line: ${theme.border}`,
      `--viewer-focus: ${theme.ring}`,
      `--viewer-text: ${theme.foreground}`,
      `--viewer-muted: ${theme["muted-foreground"]}`,
      `--viewer-hover: ${theme["surface-hover"]}`,
      `--viewer-selected: ${theme["surface-selected"]}`,
    ].join("; ")
  return `
:root { color-scheme: dark; ${roles(dark, dark.card, dark.background)}; }
:root[data-theme="light"] { color-scheme: light; ${roles(light, light.background, light.card)}; }
html, body { height: 100%; margin: 0; }
body { background: var(--viewer-background); font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; }
`
}

function pdfStyles(): string {
  return `${themeStyles()}
#viewer-container { position: absolute; inset: 0; overflow: auto; outline: none; }
.pdfViewer { --page-margin: 16px auto; --page-border: 1px solid var(--viewer-line); padding-bottom: 16px; }
#viewer-rail { position: absolute; top: 0; bottom: 0; left: 0; z-index: 2; width: 168px; display: flex; flex-direction: column; background: var(--viewer-rail); border-right: 1px solid var(--viewer-line); }
#viewer-rail[hidden], .rail-tabs[hidden], .rail-pages[hidden], .rail-outline[hidden] { display: none; }
body[data-rail="open"] #viewer-container { left: 169px; }
@media (max-width: 639px) {
  #viewer-rail { width: min(72vw, 220px); box-shadow: 8px 0 24px -12px rgb(0 0 0 / 45%); }
  body[data-rail="open"] #viewer-container { left: 0; }
}
.rail-tabs { display: flex; gap: 2px; padding: 8px 8px 0; }
.rail-tabs button { flex: 1; padding: 5px 6px; border: 0; border-radius: 6px; background: none; color: var(--viewer-muted); font: inherit; font-weight: 500; cursor: pointer; }
.rail-tabs button:hover { background: var(--viewer-hover); }
.rail-tabs button[aria-selected="true"] { background: var(--viewer-selected); color: var(--viewer-text); }
.rail-pages, .rail-outline { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 10px 8px; scrollbar-width: thin; overflow-wrap: anywhere; }
.rail-page { display: flex; flex-direction: column; align-items: center; gap: 5px; width: 100%; padding: 6px 0 10px; border: 0; background: none; color: var(--viewer-muted); font: inherit; font-size: 12px; cursor: pointer; }
.rail-picture { display: block; width: 120px; overflow: hidden; border-radius: 2px; background: #fff; outline: 1px solid var(--viewer-line); }
.rail-picture img { display: block; width: 100%; height: 100%; }
.rail-page:hover .rail-picture { outline-color: var(--viewer-muted); }
.rail-page[aria-current="page"] { color: var(--viewer-text); }
.rail-page[aria-current="page"] .rail-picture { outline: 2px solid var(--viewer-focus); }
.rail-page:focus-visible, .rail-outline button:focus-visible, .rail-tabs button:focus-visible { outline: 2px solid var(--viewer-focus); outline-offset: -2px; }
.rail-outline ul { margin: 0; padding: 0 0 0 12px; list-style: none; }
.rail-outline > ul { padding-left: 0; }
.rail-outline button { display: block; width: 100%; padding: 5px 6px; border: 0; border-radius: 6px; background: none; color: var(--viewer-text); font: inherit; text-align: left; cursor: pointer; }
.rail-outline button:hover { background: var(--viewer-hover); }
`
}

/** A bundler that notes every file it reads, for the notices. */
function bundler(inputs: string[]) {
  return async (
    entry: string,
    options: Parameters<typeof build>[0]
  ): Promise<string> => {
    const result = await build({
      entryPoints: [entry],
      absWorkingDir: here,
      bundle: true,
      minify: true,
      write: false,
      metafile: true,
      target: "es2022",
      logLevel: "silent",
      ...options,
    })
    inputs.push(
      ...Object.keys(result.metafile!.inputs).map((input) => join(here, input))
    )
    return result.outputFiles![0]!.text
  }
}

/** Build the PDF viewer's frame document from pdf.js and the frame source. */
export async function buildPdfViewerFrame(): Promise<ViewerFrameBuild> {
  const pdfjs = dirname(require.resolve("pdfjs-dist/package.json"))
  const inputs: string[] = []
  const bundle = bundler(inputs)
  const [script, worker] = await Promise.all([
    bundle(join(here, "src/viewer-frames/pdf/frame.ts"), { format: "esm" }),
    // The worker runs as a classic script from a blob, so it can't be a
    // module: the address pdf.js would resolve its own files against is
    // fixed, and those files come from the page instead.
    bundle(join(pdfjs, "legacy/build/pdf.worker.mjs"), {
      format: "iife",
      define: { "import.meta.url": JSON.stringify("https://viewer.invalid/") },
    }),
  ])
  // The stylesheet's images would be fetches, which the frame can't make.
  const style = inStyle(
    readFileSync(join(pdfjs, "legacy/web/pdf_viewer.css"), "utf8").replace(
      /url\((["']?)images\/[^)]*\)/g,
      "none"
    ) + pdfStyles()
  )
  const main = inScript(script)
  // The notices of everything the document carries, kept with its files.
  const packages = contributingPackages(
    [...inputs, join(pdfjs, "legacy/web/pdf_viewer.css")],
    here
  )
  const notices = renderDependencyNotices(
    packages.map((entry) => entry.key),
    packages
  )
  const html = [
    "<!doctype html><!-- Third-party notices and source: files/notices/NOTICES.txt -->",
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>PDF</title><style>${style}</style></head><body>`,
    '<nav id="viewer-rail" aria-label="Pages" hidden></nav>',
    '<div id="viewer-container" tabindex="0"><div id="viewer-pages" class="pdfViewer"></div></div>',
    `<script type="text/plain" id="viewer-worker">${inScript(worker)}</script>`,
    `<script type="module">${main}</script></body></html>`,
  ].join("")

  const files = new Map<string, Uint8Array>([
    ["notices/NOTICES.txt", Buffer.from(notices)],
  ])
  for (const folder of ["cmaps", "standard_fonts", "wasm"]) {
    for (const name of readdirSync(join(pdfjs, folder)).sort()) {
      // Decoders that run without WebAssembly are scripts the frame's
      // policy refuses, and PDF scripting is never on.
      if (name.endsWith(".js") || name.startsWith("quickjs")) continue
      files.set(`${folder}/${name}`, readFileSync(join(pdfjs, folder, name)))
    }
  }
  return {
    key: "pdf",
    html,
    csp: viewerFrameCsp({ script: sha256(main), style: sha256(style) }),
    files,
  }
}

function wordStyles(): string {
  return `${themeStyles()}
#viewer-container { position: absolute; inset: 0; overflow: auto; outline: none; }
#viewer-document { min-height: 100%; }
/* Extend's review cards offer Resolve, Accept and Reject even when only
   reading. This viewer never saves, so they would only change the screen. */
#viewer-document button { display: none; }
`
}

/** The look-alike font families Extend carries, by its own ids. */
const WORD_FONT_FAMILIES = [
  "carlito",
  "arimo",
  "tinos",
  "cousine",
  "intos",
  "intos-narrow",
]
/** The faces of each family, in the order the renderer asks for them. */
const WORD_FONT_FACES = [
  { style: "normal", weight: "400" },
  { style: "normal", weight: "700" },
  { style: "italic", weight: "400" },
  { style: "italic", weight: "700" },
]

/**
 * Point Extend's lazy parts at the frame. Its fonts are modules of base64
 * text that would make the frame document 7 MB larger; they become files the
 * frame asks the page for by name. Its import worker is a module script,
 * which a frame with no origin can't start; it becomes a classic one from
 * the code the document carries. Each change must find its place, so a new
 * release of Extend that moves them fails the build instead of the viewer.
 */
function wordViewerPatches(fonts: Map<string, string>): EsbuildPlugin {
  return {
    name: "worktable-word-viewer",
    setup(context) {
      context.onLoad(
        { filter: /@extend-ai[\\/]react-docx[\\/]dist[\\/]vanilla\.js$/ },
        async (args) => {
          let code = await readFile(args.path, "utf8")
          code = code.replace(
            /load: \(\) => import\("\.\/([a-z-]+)-data-[A-Za-z0-9]+\.js"\)/g,
            (whole: string, id: string) => {
              fonts.set(id, join(dirname(args.path), whole.split('"')[1]!))
              return `load: () => globalThis.__wordViewerFont(${JSON.stringify(id)})`
            }
          )
          const worker =
            /new Worker\(new URL\("\.\/docx-import-worker\.js", import\.meta\.url\), \{[^}]*\}\)/g
          const workers = code.match(worker)?.length ?? 0
          code = code.replace(worker, "globalThis.__wordViewerWorker()")
          const found = [...fonts.keys()].sort().join(",")
          if (
            found !== [...WORD_FONT_FAMILIES].sort().join(",") ||
            workers !== 1
          )
            throw new Error(
              `Extend's fonts or worker moved (fonts: ${found}; workers: ${workers})`
            )
          return { contents: code, loader: "js" }
        }
      )
    },
  }
}

/** Each font family's faces as files, from Extend's font modules. */
async function wordFontFiles(
  fonts: Map<string, string>
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  for (const [id, path] of fonts) {
    const { faces } = (await import(path)) as {
      faces: { source: string; style: string; weight: string }[]
    }
    if (
      faces.length !== WORD_FONT_FACES.length ||
      faces.some(
        (face, index) =>
          face.style !== WORD_FONT_FACES[index]!.style ||
          String(face.weight) !== WORD_FONT_FACES[index]!.weight
      )
    )
      throw new Error(
        `Extend's ${id} faces aren't regular, bold, italic, bold italic`
      )
    faces.forEach((face, index) => {
      const data = /^data:font\/woff2;base64,(.+)$/.exec(face.source)?.[1]
      if (!data) throw new Error(`Extend's ${id} face ${index} isn't WOFF2`)
      files.set(`fonts/${id}-${index}.woff2`, Buffer.from(data, "base64"))
    })
  }
  return files
}

/** Build the Word viewer's frame document from Extend and the frame source. */
export async function buildWordViewerFrame(): Promise<ViewerFrameBuild> {
  const extend = dirname(require.resolve("@extend-ai/react-docx/package.json"))
  const inputs: string[] = []
  const bundle = bundler(inputs)
  const fonts = new Map<string, string>()
  const [script, worker] = await Promise.all([
    bundle(join(here, "src/viewer-frames/word/frame.ts"), {
      format: "esm",
      plugins: [wordViewerPatches(fonts)],
    }),
    // A classic script from a blob, like the PDF worker. It is given the
    // engine, so it never resolves a file of its own.
    bundle(join(extend, "dist/docx-import-worker.js"), {
      format: "iife",
      define: { "import.meta.url": JSON.stringify("https://viewer.invalid/") },
    }),
  ])
  const style = inStyle(wordStyles())
  const main = inScript(script)
  const wasm = join(extend, "dist/docx_wasm_bg.wasm")
  const fontFiles = await wordFontFiles(fonts)
  const packages = contributingPackages(
    [...inputs, wasm, ...fonts.values()],
    here
  )
  const notices = renderDependencyNotices(
    packages.map((entry) => entry.key),
    packages
  )
  const html = [
    "<!doctype html><!-- Third-party notices and source: files/notices/NOTICES.txt -->",
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Word</title><style>${style}</style></head><body>`,
    '<div id="viewer-container" tabindex="0"><div id="viewer-document"></div></div>',
    `<script type="text/plain" id="viewer-worker">${inScript(worker)}</script>`,
    `<script type="module">${main}</script></body></html>`,
  ].join("")

  const files = new Map<string, Uint8Array>([
    ["notices/NOTICES.txt", Buffer.from(notices)],
    ["wasm/docx_wasm_bg.wasm", readFileSync(wasm)],
    ...fontFiles,
  ])
  for (const [name, bytes] of separateNotices(packages)) {
    files.set(`notices/${name}`, bytes)
  }
  return {
    key: "word",
    html,
    csp: viewerFrameCsp({ script: sha256(main), style: "inline" }),
    files,
  }
}

/** Every viewer frame the app carries. */
export function buildViewerFrames(): Promise<ViewerFrameBuild[]> {
  return Promise.all([buildPdfViewerFrame(), buildWordViewerFrame()])
}

// Quality 11 takes Extend's 14.6 MB engine to 4.1 MB but adds about a
// minute to every web build; 9 gives 4.6 MB in a few seconds, and the
// browser keeps the engine until the next release.
const brotli = (bytes: Uint8Array, quality = 11) =>
  brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: quality,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
    },
  })

/** Every file a viewer frame's build writes, by path under `viewers/`. */
export function viewerFrameOutput(
  frame: ViewerFrameBuild
): Map<string, Uint8Array> {
  const html = Buffer.from(frame.html)
  const output = new Map<string, Uint8Array>([
    [`${frame.key}/frame.html`, html],
    [`${frame.key}/frame.html.br`, brotli(html)],
    [`${frame.key}/frame.html.gz`, gzipSync(html, { level: 9 })],
    [
      `${frame.key}/policy.json`,
      Buffer.from(JSON.stringify({ csp: frame.csp })),
    ],
  ])
  for (const [path, bytes] of frame.files) {
    output.set(`${frame.key}/files/${path}`, bytes)
    // An engine is the largest thing a viewer downloads, and compresses to
    // a third; the server sends these copies to a browser that takes them.
    if (path.endsWith(".wasm")) {
      output.set(`${frame.key}/files/${path}.br`, brotli(bytes, 9))
      output.set(`${frame.key}/files/${path}.gz`, gzipSync(bytes, { level: 9 }))
    }
  }
  return output
}

/** Write each viewer frame into the web build, under `viewers/`. */
export function viewerFrames(): Plugin {
  return {
    name: "worktable-viewer-frames",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    async generateBundle() {
      for (const frame of await buildViewerFrames()) {
        for (const [path, source] of viewerFrameOutput(frame)) {
          this.emitFile({ type: "asset", fileName: `viewers/${path}`, source })
        }
      }
    },
  }
}
