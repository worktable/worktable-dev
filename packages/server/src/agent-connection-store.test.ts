import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  disconnectAgentConnection,
  listAgentConnections,
  upsertAgentConnection,
} from "./agent-connection-store.ts"
import { createToken, verifyToken } from "./token-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import { onWorkspaceChange } from "./workspace-events.ts"

let appDir: string
let workspaceDir: string

beforeEach(async () => {
  appDir = await mkdtemp(join(tmpdir(), "worktable-agent-connections-app-"))
  workspaceDir = await mkdtemp(
    join(tmpdir(), "worktable-agent-connections-workspace-")
  )
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
})

afterEach(async () => {
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await Promise.all([
    rm(appDir, { recursive: true, force: true }),
    rm(workspaceDir, { recursive: true, force: true }),
  ])
})

describe("semantic agent connections", () => {
  it("invalidates thread participants after always-on metadata changes", async () => {
    const credential = await createToken({
      scopes: ["threads:*"],
      agent: "openclaw@oci_participant_update",
    })
    const participantEvents: Array<string | undefined> = []
    const unsubscribe = onWorkspaceChange((event) => {
      if (event.type === "participants") {
        participantEvents.push(event.spaceId)
      }
    })
    try {
      await upsertAgentConnection({
        target: {
          kind: "agent-adapter",
          adapter: "openclaw",
          installationId: "oci_participant_update",
        },
        mode: "always-on",
        participant: {
          id: "ptc_participant_update",
          kind: "agent",
          name: "Atlas",
        },
        machine: "studio",
        credentialId: credential.metadata.id,
      })
      expect(participantEvents).toEqual([undefined])
      participantEvents.length = 0
      await upsertAgentConnection({
        target: {
          kind: "agent-adapter",
          adapter: "openclaw",
          installationId: "oci_participant_update",
        },
        mode: "on-demand",
        participant: {
          id: "ptc_participant_update",
          kind: "agent",
          name: "Atlas",
        },
        machine: "studio",
        credentialId: credential.metadata.id,
      })
      expect(participantEvents).toEqual([undefined])
      participantEvents.length = 0
      await upsertAgentConnection({
        target: {
          kind: "agent-adapter",
          adapter: "openclaw",
          installationId: "oci_participant_update",
        },
        mode: "on-demand",
        participant: {
          id: "ptc_participant_replaced",
          kind: "agent",
          name: "Scout",
        },
        machine: "studio",
        credentialId: credential.metadata.id,
      })
      expect(participantEvents).toEqual([undefined])
    } finally {
      unsubscribe()
    }
  })

  it("stores verified identity privately, rotates credentials, and disconnects", async () => {
    const first = await createToken({
      scopes: ["threads:*"],
      agent: "openclaw@oci_test_install",
    })
    const target = {
      kind: "agent-adapter" as const,
      adapter: "openclaw",
      installationId: "oci_test_install",
    }
    await upsertAgentConnection({
      target,
      mode: "always-on",
      participant: {
        id: "ptc_abcdefghijkl",
        kind: "agent",
        name: "Atlas",
      },
      machine: "studio",
      credentialId: first.metadata.id,
    })
    const initial = (await listAgentConnections())[0]!
    expect(initial).toMatchObject({
      target,
      mode: "always-on",
      machine: "studio",
      scopes: ["threads:*"],
      lastSeenAt: null,
    })
    expect(
      (await stat(join(appDir, "agent-connections.json"))).mode & 0o777
    ).toBe(0o600)

    const second = await createToken({
      scopes: ["threads:*"],
      agent: "openclaw@oci_test_install",
    })
    await upsertAgentConnection({
      target,
      mode: "always-on",
      participant: initial.participant,
      machine: "studio",
      credentialId: second.metadata.id,
      displayName: "Studio Claw",
    })
    const rotated = (await listAgentConnections())[0]!
    expect(rotated.id).toBe(initial.id)
    expect(rotated.connectedAt).toBe(initial.connectedAt)
    expect(rotated.displayName).toBe("Studio Claw")
    expect(await verifyToken(first.token)).toBeNull()
    expect(await verifyToken(second.token)).not.toBeNull()

    const third = await createToken({
      scopes: ["threads:*"],
      agent: "openclaw@oci_test_install",
    })
    await upsertAgentConnection({
      target,
      mode: "always-on",
      participant: initial.participant,
      machine: "studio",
      credentialId: third.metadata.id,
      displayName: "OpenClaw",
    })
    const rotatedAgain = (await listAgentConnections())[0]!
    expect(rotatedAgain.displayName).toBe("Studio Claw")
    expect(await verifyToken(second.token)).toBeNull()
    expect(await verifyToken(third.token)).not.toBeNull()

    expect(await disconnectAgentConnection(rotatedAgain.id)).toBe(true)
    expect(await disconnectAgentConnection(rotatedAgain.id)).toBe(true)
    expect(await listAgentConnections()).toEqual([])
    expect(await verifyToken(third.token)).toBeNull()
  })

  it("does not turn an ordinary hand-minted token into a connection", async () => {
    await createToken({ scopes: ["docs:read"], agent: "manual-token" })
    expect(await listAgentConnections()).toEqual([])
  })

  it("keeps the same installation distinct across registered Worktables", async () => {
    const otherWorkspace = await mkdtemp(
      join(tmpdir(), "worktable-agent-connections-other-workspace-")
    )
    const target = {
      kind: "agent-adapter" as const,
      adapter: "openclaw",
      installationId: "oci_shared_install",
    }
    try {
      const first = await createToken({
        scopes: ["threads:*"],
        agent: "openclaw@oci_shared_install",
      })
      await upsertAgentConnection({
        target,
        mode: "always-on",
        participant: null,
        machine: "studio",
        credentialId: first.metadata.id,
      })
      const firstConnection = (await listAgentConnections())[0]!

      setWorkspaceRootOverride(otherWorkspace)
      const second = await createToken({
        scopes: ["threads:*"],
        agent: "openclaw@oci_shared_install",
      })
      await upsertAgentConnection({
        target,
        mode: "always-on",
        participant: null,
        machine: "studio",
        credentialId: second.metadata.id,
      })
      const secondConnection = (await listAgentConnections())[0]!
      expect(secondConnection.id).not.toBe(firstConnection.id)
      expect(await verifyToken(second.token)).not.toBeNull()

      setWorkspaceRootOverride(workspaceDir)
      expect(await listAgentConnections()).toEqual([
        expect.objectContaining({
          id: firstConnection.id,
        }),
      ])
      expect(await disconnectAgentConnection(secondConnection.id)).toBe(false)
      setWorkspaceRootOverride(otherWorkspace)
      expect(await verifyToken(second.token)).not.toBeNull()
    } finally {
      setWorkspaceRootOverride(workspaceDir)
      await rm(otherWorkspace, { recursive: true, force: true })
    }
  })

  it("keeps hostname-less MCP clients distinct by credential", async () => {
    const target = {
      kind: "mcp-client" as const,
      clientId: "codex",
    }
    const first = await createToken({
      scopes: ["threads:*"],
      agent: "codex@unknown-first",
    })
    const second = await createToken({
      scopes: ["threads:*"],
      agent: "codex@unknown-second",
    })
    for (const credentialId of [first.metadata.id, second.metadata.id]) {
      await upsertAgentConnection({
        target,
        mode: "on-demand",
        participant: null,
        machine: null,
        credentialId,
      })
    }

    const connections = await listAgentConnections()
    expect(connections).toHaveLength(2)
    expect(new Set(connections.map((connection) => connection.id)).size).toBe(2)
    const stored = JSON.parse(
      await readFile(join(appDir, "agent-connections.json"), "utf8")
    ) as {
      connections: Array<{ id: string; credentialId: string }>
    }
    const firstConnectionId = stored.connections.find(
      (connection) => connection.credentialId === first.metadata.id
    )!.id
    expect(await disconnectAgentConnection(firstConnectionId)).toBe(true)
    expect(await verifyToken(first.token)).toBeNull()
    expect(await verifyToken(second.token)).not.toBeNull()
    expect(await listAgentConnections()).toHaveLength(1)
  })

  it("does not let delayed completion replace a newer credential", async () => {
    const target = {
      kind: "agent-adapter" as const,
      adapter: "openclaw",
      installationId: "oci_ordered_install",
    }
    const older = await createToken({
      scopes: ["threads:*"],
      agent: "openclaw@oci_ordered_install",
    })
    const newer = await createToken({
      scopes: ["threads:*"],
      agent: "openclaw@oci_ordered_install",
    })
    const connection = (credentialId: string) => ({
      target,
      mode: "always-on" as const,
      participant: null,
      machine: "studio",
      credentialId,
    })

    expect(await upsertAgentConnection(connection(newer.metadata.id))).toBe(
      true
    )
    expect(await upsertAgentConnection(connection(older.metadata.id))).toBe(
      false
    )

    expect(await listAgentConnections()).toHaveLength(1)
    expect(await verifyToken(newer.token)).not.toBeNull()
  })

  it("disconnects a credential rotation that was queued first", async () => {
    const target = {
      kind: "agent-adapter" as const,
      adapter: "openclaw",
      installationId: "oci_disconnect_rotation",
    }
    const first = await createToken({
      scopes: ["threads:*"],
      agent: "openclaw@oci_disconnect_rotation",
    })
    const second = await createToken({
      scopes: ["threads:*"],
      agent: "openclaw@oci_disconnect_rotation",
    })
    const connection = (credentialId: string) => ({
      target,
      mode: "always-on" as const,
      participant: null,
      machine: "studio",
      credentialId,
    })

    await upsertAgentConnection(connection(first.metadata.id))
    const connectionId = (await listAgentConnections())[0]!.id

    const rotation = upsertAgentConnection(connection(second.metadata.id))
    const disconnect = disconnectAgentConnection(connectionId)
    expect(await Promise.all([rotation, disconnect])).toEqual([true, true])

    expect(await listAgentConnections()).toEqual([])
    expect(await verifyToken(second.token)).toBeNull()
  })

  it("rotates one MCP connection across hostname casing changes", async () => {
    const target = {
      kind: "mcp-client" as const,
      clientId: "codex",
    }
    const first = await createToken({
      scopes: ["threads:*"],
      agent: "codex@Studio-Mac",
    })
    const second = await createToken({
      scopes: ["threads:*"],
      agent: "codex@studio-mac",
    })
    const connection = (machine: string, credentialId: string) => ({
      target,
      mode: "on-demand" as const,
      participant: null,
      machine,
      credentialId,
    })

    await upsertAgentConnection(connection("Studio-Mac", first.metadata.id))
    const initial = (await listAgentConnections())[0]!
    await upsertAgentConnection(connection("studio-mac", second.metadata.id))

    expect(await listAgentConnections()).toEqual([
      expect.objectContaining({
        id: initial.id,
        machine: "studio-mac",
      }),
    ])
    expect(await verifyToken(first.token)).toBeNull()
    expect(await verifyToken(second.token)).not.toBeNull()
  })
})
