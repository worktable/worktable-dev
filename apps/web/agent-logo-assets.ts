import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import type { Plugin } from "vite"

/** Keep vendor artwork in public for integrations; cache the UI's copies by content. */
export function agentLogoAssets(): Plugin {
  const directory = new URL("./public/agent-logos/", import.meta.url)
  const assets = readdirSync(directory)
    .filter((name) => /\.(svg|png)$/.test(name))
    .sort()
    .map((name) => {
      const source = readFileSync(new URL(name, directory))
      return { name, source }
    })
  const hash = createHash("sha256")
  for (const { name, source } of assets) hash.update(name).update("\0").update(source)
  // One content version keeps the URL table out of every page's startup code.
  const prefix = `/assets/agent-logos-${hash.digest("hex").slice(0, 12)}-`

  return {
    name: "worktable-agent-logo-assets",
    config(_config, { command }) {
      return {
        define: {
          __WORKTABLE_AGENT_LOGO_BASE__: JSON.stringify(
            command === "build" ? prefix : "/agent-logos/"
          ),
        },
      }
    },
    generateBundle() {
      if (this.environment?.name !== "client") return
      for (const { name, source } of assets)
        this.emitFile({ type: "asset", fileName: `${prefix.slice(1)}${name}`, source })
    },
  }
}
