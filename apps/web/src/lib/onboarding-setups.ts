import { isAgentPlatformId, type AgentPlatformId } from "@worktable/types"

import { createClientId } from "./client-id"

/** An agent connected during onboarding, remembered until setup finishes. */
export interface SetupRecord {
  id: string
  name: string
  harness: string
  mode: "on-demand" | "always-on"
  verified: boolean
  /** Where the agent comes from, for its logo. */
  platform?: AgentPlatformId
  participantName?: string
  starterThreadKey?: string
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
    (setup.participantName === undefined ||
      typeof setup.participantName === "string") &&
    (setup.starterThreadKey === undefined ||
      (typeof setup.starterThreadKey === "string" &&
        Boolean(setup.starterThreadKey)))
  )
}

export function ensureStarterThreadKey(setup: SetupRecord): SetupRecord {
  if (setup.mode !== "always-on" || setup.starterThreadKey) return setup
  return {
    ...setup,
    starterThreadKey: createClientId("onboarding-thread"),
  }
}
