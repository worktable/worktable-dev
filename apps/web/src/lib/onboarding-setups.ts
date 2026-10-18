import { isAgentPlatformId, type AgentPlatformId } from "@worktable/types"

/** An agent connected during setup, remembered until setup finishes. */
export interface SetupRecord {
  id: string
  name: string
  harness: string
  mode: "on-demand" | "always-on"
  verified: boolean
  /** Where the agent comes from, for its logo. */
  platform?: AgentPlatformId
  /** The row and tab it was connected from, such as `code:Codex`. */
  source?: string
}

export function isSetupRecord(item: unknown): item is SetupRecord {
  if (item === null || typeof item !== "object") return false
  const setup = item as SetupRecord
  return (
    typeof setup.id === "string" &&
    typeof setup.name === "string" &&
    typeof setup.harness === "string" &&
    ["on-demand", "always-on"].includes(setup.mode) &&
    typeof setup.verified === "boolean" &&
    (setup.platform === undefined || isAgentPlatformId(setup.platform)) &&
    (setup.source === undefined || typeof setup.source === "string")
  )
}
