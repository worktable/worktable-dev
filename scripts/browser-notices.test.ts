import { expect, test } from "bun:test"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { build } from "vite"
import { browserNotices } from "./browser-notices"

// Two real Vite builds include cold bundler startup on CI workers.
const REAL_BUILD_TIMEOUT_MS = 15_000

test("browser bundles retain reachable notices after minification, including CSS-only dependencies", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktable-browser-notices-"))
  try {
    for (const name of ["fast-deep-equal", "tw-animate-css"]) {
      cpSync(
        join(import.meta.dir, "../node_modules", name),
        join(root, "node_modules", name),
        {
          recursive: true,
          dereference: true,
        }
      )
    }
    writeFileSync(
      join(root, "index.html"),
      '<script type="module" src="/entry.js"></script>'
    )
    writeFileSync(
      join(root, "entry.js"),
      'import equal from "fast-deep-equal"; import "./style.css"; console.log(equal([1], [2]));'
    )
    writeFileSync(join(root, "style.css"), '@import "tw-animate-css";')
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [browserNotices()],
      build: { write: false, minify: "esbuild" },
    })
    if (Array.isArray(result) || !("output" in result))
      throw new Error("Expected one browser output")
    const script = result.output.find((item) => item.type === "chunk")!
    if (script.type !== "chunk") throw new Error("Expected browser script")
    const target = script.code.match(
      /Third-party notices and source: ([^ ]+) \*/
    )?.[1]
    expect(target).toBeDefined()
    const noticePath = resolve(dirname(join(root, script.fileName)), target!)
    const notice = result.output.find(
      (item) => resolve(root, item.fileName) === noticePath
    )!
    if (notice.type !== "asset") throw new Error("Expected notice asset")
    const text = Buffer.from(notice.source).toString()
    expect(text).toContain(
      readFileSync(join(root, "node_modules/fast-deep-equal/LICENSE"), "utf8")
    )
    expect(text).toContain(
      readFileSync(join(root, "node_modules/tw-animate-css/LICENSE"), "utf8")
    )
    expect(text).not.toContain(root)

    // A new icon family is a new embedded license surface even at the same package version.
    const icons = join(root, "node_modules/react-icons")
    mkdirSync(join(icons, "fi"), { recursive: true })
    cpSync(
      join(import.meta.dir, "../node_modules/react-icons/package.json"),
      join(icons, "package.json")
    )
    cpSync(
      join(import.meta.dir, "../node_modules/react-icons/LICENSE"),
      join(icons, "LICENSE")
    )
    writeFileSync(join(icons, "fi/index.mjs"), "export const icon = 1;")
    writeFileSync(
      join(root, "entry.js"),
      'import {icon} from "./node_modules/react-icons/fi/index.mjs"; console.log(icon);'
    )
    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [browserNotices()],
        build: { write: false },
      })
    ).rejects.toThrow("Review the embedded component notice")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, REAL_BUILD_TIMEOUT_MS)
