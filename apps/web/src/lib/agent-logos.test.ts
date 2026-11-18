import { expect, it } from "bun:test"
import { existsSync } from "node:fs"
import dynamicIconImports from "lucide-react/dynamicIconImports.mjs"
import { AGENT_PLATFORMS } from "@worktable/types"
import { AGENT_LOGO_CHOICES } from "./agent-logo-choices"
import { agentLogoFileForIcon } from "./agent-logos"

it("offers every logo as a stored icon name the server accepts", () => {
  const directory = new URL("../../public/agent-logos/", import.meta.url)
  const files = new Set<string>()
  for (const { key } of AGENT_LOGO_CHOICES) {
    // The same rule the agent routes apply to icons.
    expect(key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(key in dynamicIconImports).toBe(false)
    const file = agentLogoFileForIcon(key)!
    expect(existsSync(new URL(file, directory))).toBe(true)
    files.add(file)
  }
  expect(files.size).toBe(AGENT_LOGO_CHOICES.length)
  for (const platform of Object.values(AGENT_PLATFORMS))
    if (platform.logo) expect(files.has(platform.logo)).toBe(true)
})
