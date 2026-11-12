import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation"
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot"
import { parseWorktableAgentAuth } from "./agent-auth.js"
import type { WorktableAgentAuth } from "./types.js"

export async function saveAgentCredential(
  registrationId: string,
  credential: WorktableAgentAuth
): Promise<void> {
  await mutateConfigFile({
    mutate: (draft) => {
      const channels = (draft.channels ?? {}) as Record<string, unknown>
      const section = channels.worktable as Record<string, unknown> | undefined
      if (!section) return
      const active = parseWorktableAgentAuth(section.agentAuth)
      const pending = parseWorktableAgentAuth(section.pendingAgentAuth)
      if (pending?.registrationId === registrationId) {
        section.pendingAgentAuth = credential
      } else if (active?.registrationId === registrationId) {
        section.agentAuth = credential
      } else {
        return
      }
      channels.worktable = section
      draft.channels = channels as typeof draft.channels
    },
  })
}

export async function loadAgentCredential(
  registrationId: string
): Promise<WorktableAgentAuth | undefined> {
  const channels = (
    getRuntimeConfig({ pin: false, skipPluginValidation: true }).channels ?? {}
  ) as Record<string, unknown>
  const section = channels.worktable as Record<string, unknown> | undefined
  const pending = parseWorktableAgentAuth(section?.pendingAgentAuth)
  if (pending?.registrationId === registrationId) return pending
  const active = parseWorktableAgentAuth(section?.agentAuth)
  return active?.registrationId === registrationId ? active : undefined
}

export async function promotePendingAgentAuth(
  registrationId: string
): Promise<void> {
  await mutateConfigFile({
    mutate: (draft) => {
      const channels = (draft.channels ?? {}) as Record<string, unknown>
      const section = channels.worktable as Record<string, unknown> | undefined
      const pending = parseWorktableAgentAuth(section?.pendingAgentAuth)
      if (!section || pending?.registrationId !== registrationId) return
      section.agentAuth = pending
      delete section.pendingAgentAuth
      delete section.token
      delete section.pendingPairingCode
      section.authMode = "agent-registration"
      channels.worktable = section
      draft.channels = channels as typeof draft.channels
    },
  })
}
