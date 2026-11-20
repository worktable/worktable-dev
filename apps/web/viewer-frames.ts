import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"
import { build } from "esbuild"
import type { Plugin } from "vite"
import { HTML_DOC_THEME } from "../../packages/ui/src/lib/html-doc-theme.generated"
import {
  contributingPackages,
  renderDependencyNotices,
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
 * origin away wherever it is opened. Its own script and style are allowed by
 * hash; a worker starts only from a blob of the code the document carries;
 * nothing may be fetched, framed, submitted or navigated to.
 */
export function viewerFrameCsp(hashes: {
  script: string
  style: string
}): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    // WebAssembly: pdf.js decodes JPEG 2000, JBIG2 and colour profiles with it.
    `script-src ${hashes.script} 'wasm-unsafe-eval'`,
    "worker-src blob:",
    `style-src ${hashes.style}`,
    "img-src blob: data:",
    "font-src blob: data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ")
}

function frameStyles(): string {
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
.rail-pages, .rail-outline { flex: 1; min-height: 0; overflow: auto; padding: 10px 8px; }
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

/** Build the PDF viewer's frame document from pdf.js and the frame source. */
export async function buildPdfViewerFrame(): Promise<ViewerFrameBuild> {
  const pdfjs = dirname(require.resolve("pdfjs-dist/package.json"))
  const inputs: string[] = []
  const bundle = async (
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
    ) + frameStyles()
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

/** Every file a viewer frame's build writes, by path under `viewers/`. */
export function viewerFrameOutput(
  frame: ViewerFrameBuild
): Map<string, Uint8Array> {
  const html = Buffer.from(frame.html)
  const output = new Map<string, Uint8Array>([
    [`${frame.key}/frame.html`, html],
    [
      `${frame.key}/frame.html.br`,
      brotliCompressSync(html, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: html.length,
        },
      }),
    ],
    [`${frame.key}/frame.html.gz`, gzipSync(html, { level: 9 })],
    [
      `${frame.key}/policy.json`,
      Buffer.from(JSON.stringify({ csp: frame.csp })),
    ],
  ])
  for (const [path, bytes] of frame.files) {
    output.set(`${frame.key}/files/${path}`, bytes)
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
      for (const [path, source] of viewerFrameOutput(
        await buildPdfViewerFrame()
      )) {
        this.emitFile({ type: "asset", fileName: `viewers/${path}`, source })
      }
    },
  }
}
