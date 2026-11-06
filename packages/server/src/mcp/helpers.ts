import { accessForScope } from "@worktable/types/agent-connections"
import type { RequestPrincipal } from "../token-store.ts"

export const AGENT_ID = "worktable-agent"
export const DEFAULT_AGENT_PRINCIPAL: RequestPrincipal = {
  id: AGENT_ID,
  type: "agent",
  displayName: AGENT_ID,
  authorizedBy: "local:owner",
}

export function ok(data: unknown) {
  const structuredContent =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data),
      },
    ],
    ...(structuredContent ? { structuredContent } : {}),
  }
}

export function mkErr(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  }
}

const ACCESS_LABELS = {
  threads: "Threads",
  read: "Read workspace",
  edit: "Edit workspace",
} as const

const accessRefusals = new WeakSet<object>()

/**
 * A call refused for the agent's access, naming the access that allows it.
 * No OAuth challenge: signing in again never adds access here, turning it on
 * for the agent does. `threadsOnly` is an agent whose connection grants
 * threads and nothing else.
 */
export function mkAccessErr(
  toolName: string,
  requiredScope: string,
  options: { threadsOnly?: boolean } = {}
) {
  const access = accessForScope(requiredScope)
  const label = access ? ACCESS_LABELS[access] : null
  const result = mkErr(
    !label
      ? `${toolName} isn't available to agents here.`
      : options.threadsOnly && access !== "threads"
        ? `${toolName} needs ${label} access. Agents connected this way can use threads only.`
        : `${toolName} needs ${label} access, which this agent doesn't have here. Turn on ${label} for this agent in Settings → Agents.`
  )
  accessRefusals.add(result)
  return result
}

/** Whether a tool result is a refusal for the agent's access. */
export function isAccessRefusal(result: unknown): boolean {
  return typeof result === "object" && result !== null && accessRefusals.has(result)
}
