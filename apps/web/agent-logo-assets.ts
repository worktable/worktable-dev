import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { basename, extname } from "node:path"
import type { Plugin } from "vite"

/** Keep vendor artwork in public for integrations; cache the UI's copies by content. */
export function agentLogoAssets(): Plugin {
  const directory = new URL("./public/agent-logos/", import.meta.url)
  const assets = readdirSync(directory)
    .filter((name) => /\.(svg|png)$/.test(name))
    .sort()
    .map((name) => {
      const source = readFileSync(new URL(name, directory))
      const hash = createHash("sha256").update(source).digest("hex").slice(0, 12)
      const extension = extname(name)
      return {
        name,
        source,
        fileName: `assets/agent-logo-${basename(name, extension)}-${hash}${extension}`,
      }
    })

  return {
    name: "worktable-agent-logo-assets",
    config(_config, { command }) {
      return {
        define: {
          __WORKTABLE_AGENT_LOGOS__: JSON.stringify(
            Object.fromEntries(
              assets.map(({ name, fileName }) => [
                name,
                command === "build" ? `/${fileName}` : `/agent-logos/${name}`,
              ])
            )
          ),
        },
      }
    },
    generateBundle() {
      if (this.environment?.name !== "client") return
      for (const { fileName, source } of assets)
        this.emitFile({ type: "asset", fileName, source })
    },
  }
}
