import { dirname, resolve } from "node:path"
import type { BunPlugin } from "bun"

// BlockNote uses jsdom for document conversion. Its filesystem assets must be
// captured at build time; synchronous network XHR is not part of that runtime.
export const jsdomBundlePlugin: BunPlugin = {
  name: "worktable-jsdom-portable-assets",
  setup(build) {
    build.onLoad(
      { filter: /css-tree\/lib\/(?:data|data-patch|version)\.js$/ },
      async (args) => {
        const source = await Bun.file(args.path).text()
        // These modules use createRequire only for literal JSON imports.
        // Let Bun see those require calls so their data enters the binary.
        const contents = source
          .replace(/^import \{ createRequire \} from 'module';\n/m, "")
          .replace(
            /^const require = createRequire\(import\.meta\.url\);\n/m,
            ""
          )
        if (contents === source)
          throw new Error("Review css-tree's JSON bundling")
        return { contents, loader: "js" }
      }
    )
    build.onLoad(
      { filter: /jsdom\/lib\/jsdom\/living\/xhr\/XMLHttpRequest-impl\.js$/ },
      async (args) => {
        const source = await Bun.file(args.path).text()
        const contents = source.replace(
          /const syncWorkerFile = (?:require\.resolve \? )?require\.resolve\([^)]*xhr-sync-worker\.js[^)]*\)(?: : null)?;/,
          "const syncWorkerFile = null;"
        )
        if (contents === source)
          throw new Error("Review jsdom's sync XHR worker bundling")
        return { contents, loader: "js" }
      }
    )
    build.onLoad(
      {
        filter: /jsdom\/lib\/jsdom\/living\/css\/helpers\/computed-style\.js$/,
      },
      async (args) => {
        const source = await Bun.file(args.path).text()
        const css = await Bun.file(
          resolve(dirname(args.path), "../../../browser/default-stylesheet.css")
        ).text()
        const contents = source.replace(
          /const defaultStyleSheet = fs\.readFileSync\([\s\S]*?\n\);/,
          // Use a callback so CSS containing dollar signs stays literal.
          () => `const defaultStyleSheet = ${JSON.stringify(css)};`
        )
        if (contents === source)
          throw new Error("Review jsdom's default stylesheet bundling")
        return { contents, loader: "js" }
      }
    )
  },
}
