import { afterEach, expect, it } from "bun:test"
import type { AgentConnection } from "@worktable/types"
import {
  disconnectAgentConnection,
  listAgentConnections,
  saveAgentChanges,
} from "./agent-connections-api"
import { resetBrowserTeamContext } from "./team-context"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  resetBrowserTeamContext()
})

it("edits and disconnects Cloud workspace agents through their owning endpoint", async () => {
  resetBrowserTeamContext()
  const paired: AgentConnection = {
    id: "acn_paired",
    authKind: "local-token",
    displayName: "Runner",
    platform: "openclaw",
    icon: null,
    access: { threads: true, read: true, edit: true },
    target: { kind: "mcp-client", clientId: null },
    mode: "always-on",
    participant: null,
    machine: null,
    scopes: ["*"],
    connectedAt: null,
    lastSeenAt: null,
    permissionGroups: null,
  }
  const signedIn: AgentConnection = {
    ...paired,
    id: "oauth:cloud",
    authKind: "oauth",
  }
  const mutations: string[] = []
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "https://app.worktable.cloud")
    if (init?.method && init.method !== "GET") {
      mutations.push(`${init.method} ${url.pathname}${url.search}`)
      return Response.json({ ok: true, connection: paired })
    }
    return Response.json({
      connections: url.searchParams.get("scope") ? [paired] : [signedIn],
    })
  }) as unknown as typeof fetch
  const inventory = await listAgentConnections({ workspaceAgentsOnCloud: true })
  const workspaceAgent = inventory.connections.find((c) => c.id === paired.id)!
  await saveAgentChanges(workspaceAgent, {
    name: "Renamed runner",
    icon: null,
    access: paired.access,
  })
  await disconnectAgentConnection(workspaceAgent)
  await disconnectAgentConnection(
    inventory.connections.find((c) => c.id === signedIn.id)!
  )
  expect(mutations).toEqual([
    "PATCH /api/agent-connections/acn_paired?scope=workspace",
    "DELETE /api/agent-connections/acn_paired?scope=workspace",
    "DELETE /api/agent-connections/oauth%3Acloud",
  ])
})
