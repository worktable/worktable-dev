import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation"
import { loadConfig } from "openclaw/plugin-sdk/config-runtime"
import { parseWorktableAgentAuth } from "./agent-auth.js"
import type { WorktableAgentAuth } from "./types.js"

export async function stagePendingAgentAuth(input: {
  server: string
  participantName: string
  credential: WorktableAgentAuth
}): Promise<void> {
  await mutateConfigFile({
    mutate: (draft) => {
      const channels = (draft.channels ?? {}) as Record<string, unknown>
      const current =
        channels.worktable &&
        typeof channels.worktable === "object" &&
        !Array.isArray(channels.worktable)
          ? (channels.worktable as Record<string, unknown>)
          : {}
      channels.worktable = {
        ...current,
        enabled: true,
        server: input.server,
        authMode: "agent-registration",
        participantName: input.participantName,
        pendingAgentAuth: input.credential,
      }
      draft.channels = channels as typeof draft.channels
    },
  })
}

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
    loadConfig({ pin: false, skipPluginValidation: true }).channels ?? {}
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
