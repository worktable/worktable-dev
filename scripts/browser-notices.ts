import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { posix } from "node:path"
import type { Plugin } from "vite"
import {
  contributingPackages,
  renderDependencyNotices,
} from "./dependency-notices"

/** Retain notices for the browser payload, including watched CSS imports. */
export function browserNotices(): Plugin {
  let noticePath: string | undefined
  const link = (fileName: string) =>
    `\n/*! Third-party notices and source: ${posix.relative(posix.dirname(fileName), noticePath!)} */\n`
  return {
    name: "worktable-browser-notices",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    buildStart() {
      noticePath = undefined
    },
    renderChunk: {
      // Append after minification and before Rollup finalizes content hashes.
      order: "post",
      handler(code, chunk, _options, meta) {
        if (!noticePath) {
          const inputs = Object.values(meta.chunks).flatMap((item) =>
            Object.entries(item.modules)
              .filter(([, contribution]) => contribution.renderedLength > 0)
              .map(([id]) => id)
          )
          // Tailwind consumes CSS imports before they reach chunk.modules.
          inputs.push(
            ...this.getWatchFiles().filter((id) => id.endsWith(".css"))
          )
          // The configured PWA plugin generates registerSW.js from its template.
          inputs.push(createRequire(import.meta.url).resolve("vite-plugin-pwa"))
          const packages = contributingPackages(inputs, process.cwd())
          const keys = packages.map((entry) => entry.key)
          const notices = renderDependencyNotices(keys, packages)
          const hash = createHash("sha256")
            .update(notices)
            .digest("hex")
            .slice(0, 16)
          noticePath = `assets/third-party-NOTICES-${hash}.txt`
          this.emitFile({
            type: "asset",
            fileName: noticePath,
            source: notices,
          })
          this.emitFile({
            type: "asset",
            fileName: `assets/third-party-packages-${hash}.json`,
            source:
              JSON.stringify({ schemaVersion: 1, packages: keys }, null, 2) +
              "\n",
          })
        }
        return { code: code + link(chunk.fileName), map: null }
      },
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const item of Object.values(bundle)) {
          if (item.type !== "asset" || !item.fileName.endsWith(".js")) continue
          if (item.fileName !== "registerSW.js" || !noticePath)
            throw new Error(
              `Review notices for generated browser script: ${item.fileName}`
            )
          item.source =
            Buffer.from(item.source).toString("utf8") + link(item.fileName)
        }
      },
    },
  }
}
