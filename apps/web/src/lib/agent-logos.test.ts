import { expect, it } from "bun:test"
import { existsSync } from "node:fs"
import dynamicIconImports from "lucide-react/dynamicIconImports.mjs"
import { AGENT_PLATFORMS } from "@worktable/types"
import { AGENT_LOGOS } from "./agent-logos"

it("offers every logo as a stored icon name the server accepts", () => {
  const directory = new URL("../../public/agent-logos/", import.meta.url)
  const files = new Set(AGENT_LOGOS.map((logo) => logo.file))
  for (const logo of AGENT_LOGOS) {
    // The same rule the agent routes apply to icons.
    expect(logo.key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(logo.key in dynamicIconImports).toBe(false)
    expect(existsSync(new URL(logo.file, directory))).toBe(true)
  }
  expect(new Set(AGENT_LOGOS.map((logo) => logo.key)).size).toBe(
    AGENT_LOGOS.length
  )
  for (const platform of Object.values(AGENT_PLATFORMS))
    if (platform.logo) expect(files.has(platform.logo)).toBe(true)
})
