import { createHash } from "node:crypto"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  AgentAccess,
  AgentConnection,
  AgentConnectionTarget,
  AgentPlatformId,
  ParticipantRef,
} from "@worktable/types"
import {
  accessFromScopes,
  AGENT_PLATFORMS,
  platformForAdapter,
  platformForClient,
  scopesForAccess,
} from "@worktable/types"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { resolveParticipant } from "./participant-store.ts"
import {
  listTokens,
  revokeToken,
  setTokenScopes,
  type TokenMetadata,
} from "./token-store.ts"
import { listSpaces } from "./store.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { notifyWorkspaceChange } from "./workspace-events.ts"

interface StoredAgentConnection {
  id: string
  workspace: string
  target: AgentConnectionTarget
  mode: AgentConnection["mode"]
  participant: ParticipantRef | null
  machine: string | null
  credentialId: string
  connectedAt: string
  displayName?: string
  /** Recorded when the agent first connects; never taken from later requests. */
  platform?: AgentPlatformId
  /** A Lucide icon name the owner chose instead of the platform's logo. */
  icon?: string
}

interface AgentConnectionFile {
  type: "worktable.agent-connections"
  version: 1
  connections: StoredAgentConnection[]
}

let mutationQueue: Promise<unknown> = Promise.resolve()
let tmpCounter = 0

function connectionFile(): string {
  return join(ensureAppDir(), "agent-connections.json")
}

function serialized<T>(run: () => Promise<T>): Promise<T> {
  const locked = () =>
    withCrossProcessLock(
      `${connectionFile()}.lock`,
      { label: "Agent connection state" },
      run
    )
  const next = mutationQueue.then(locked, locked)
  mutationQueue = next.catch(() => undefined)
  return next
}

function emptyFile(): AgentConnectionFile {
  return {
    type: "worktable.agent-connections",
    version: 1,
    connections: [],
  }
}

async function loadFile(): Promise<AgentConnectionFile> {
  try {
    const parsed = JSON.parse(
      await readFile(connectionFile(), "utf8")
    ) as Partial<AgentConnectionFile>
    if (
      parsed.type !== "worktable.agent-connections" ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.connections)
    ) {
      throw new Error("Invalid agent connection file")
    }
    return parsed as AgentConnectionFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile()
    throw error
  }
}

async function saveFile(file: AgentConnectionFile): Promise<void> {
  const path = connectionFile()
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8")
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

async function notifyThreadParticipantsChanged(): Promise<void> {
  try {
    notifyWorkspaceChange({ type: "participants" })
    for (const space of await listSpaces()) {
      notifyWorkspaceChange({ type: "participants", spaceId: space.id })
    }
  } catch (error) {
    console.error(
      "[agent-connections] connection state changed, but participant invalidation failed:",
      error
    )
  }
}

function stableConnectionKey(
  target: AgentConnectionTarget,
  machine: string | null,
  credentialId: string
): string {
  return target.kind === "agent-adapter"
    ? `adapter:${target.adapter}:${target.installationId}`
    : `mcp:${target.clientId ?? "agent"}:${
        machine?.toLowerCase() ?? `credential:${credentialId}`
      }`
}

function connectionId(
  target: AgentConnectionTarget,
  machine: string | null,
  workspace: string,
  credentialId: string
): string {
  return `acn_${createHash("sha256")
    .update(
      `${workspace}\0${stableConnectionKey(target, machine, credentialId)}`
    )
    .digest("base64url")
    .slice(0, 20)}`
}

export async function upsertAgentConnection(input: {
  target: AgentConnectionTarget
  mode: AgentConnection["mode"]
  participant: ParticipantRef | null
  machine: string | null
  credentialId: string
  displayName?: string
}): Promise<boolean> {
  return serialized(async () => {
    const file = await loadFile()
    const workspace = getWorkspaceRoot()
    const id = connectionId(
      input.target,
      input.machine,
      workspace,
      input.credentialId
    )
    const tokens = await listTokens()
    const tokenById = new Map(tokens.map((token) => [token.id, token]))
    const tokenIndexById = new Map(
      tokens.map((token, index) => [token.id, index])
    )
    const existing = file.connections.find((connection) => connection.id === id)
    const participantsChanged =
      !existing ||
      existing.mode !== input.mode ||
      existing.participant?.id !== input.participant?.id
    if (existing) {
      const incomingToken = tokenById.get(input.credentialId)
      const existingTokenIndex = tokenIndexById.get(existing.credentialId)
      const incomingTokenIndex = tokenIndexById.get(input.credentialId)
      if (
        !incomingToken ||
        incomingToken.workspace !== workspace ||
        incomingToken.revokedAt !== null ||
        (existingTokenIndex !== undefined &&
          incomingTokenIndex !== undefined &&
          existingTokenIndex > incomingTokenIndex)
      ) {
        // A delayed completion may arrive after a newer pairing has already
        // installed and recorded its credential. Never point the semantic
        // connection back at an older or concurrently revoked token.
        return false
      }
      existing.id = id
      existing.workspace = workspace
      existing.target = input.target
      existing.mode = input.mode
      existing.participant = input.participant
      existing.machine = input.machine
      // Credential rotation is not a rename. The explicit rename route owns
      // later changes, but an unlabeled legacy row can accept its first name.
      existing.displayName ??= input.displayName
      const replacedCredentialId =
        existing.credentialId === input.credentialId
          ? undefined
          : existing.credentialId
      existing.credentialId = input.credentialId
      await saveFile(file)
      if (replacedCredentialId) await revokeToken(replacedCredentialId)
      if (participantsChanged) await notifyThreadParticipantsChanged()
      return true
    } else {
      const incomingToken = tokenById.get(input.credentialId)
      if (
        !incomingToken ||
        incomingToken.workspace !== workspace ||
        incomingToken.revokedAt !== null
      ) {
        return false
      }
      file.connections.push({
        id,
        workspace,
        ...input,
        platform: platformForTarget(input.target),
        connectedAt: new Date().toISOString(),
      })
    }
    await saveFile(file)
    if (participantsChanged) await notifyThreadParticipantsChanged()
    return true
  })
}

function platformForTarget(target: AgentConnectionTarget): AgentPlatformId {
  return target.kind === "agent-adapter"
    ? platformForAdapter(target.adapter)
    : platformForClient(target.clientId)
}

function publicConnection(
  stored: StoredAgentConnection,
  token: TokenMetadata
): AgentConnection {
  const platform = stored.platform ?? platformForTarget(stored.target)
  return {
    id: stored.id,
    authKind: "local-token",
    // One name: the agent's thread participant carries it once it has one.
    displayName:
      stored.participant?.name ??
      stored.displayName ??
      (platform === "other"
        ? (token.agent ?? AGENT_PLATFORMS.other.name)
        : AGENT_PLATFORMS[platform].name),
    platform,
    icon: stored.icon ?? null,
    access: accessFromScopes(token.scopes),
    target: stored.target,
    mode: stored.mode,
    participant: stored.participant,
    machine: stored.machine,
    connectedAt: stored.connectedAt,
    scopes: token.scopes,
    lastSeenAt: token.lastUsedAt,
    permissionGroups: null,
  }
}

/**
 * Current agent names keyed by the principal ID their writes carry. Revoked
 * credentials stay in the map so earlier activity keeps a readable name.
 */
export async function agentNamesByPrincipal(): Promise<Map<string, string>> {
  const [file, tokens] = await Promise.all([loadFile(), listTokens()])
  const workspace = getWorkspaceRoot()
  const tokensById = new Map(tokens.map((token) => [token.id, token]))
  const names = new Map<string, string>()
  for (const connection of file.connections) {
    if (connection.workspace !== workspace) continue
    const token = tokensById.get(connection.credentialId)
    if (!token) continue
    names.set(
      `local-token:${token.id}`,
      publicConnection(connection, token).displayName
    )
  }
  return names
}

export async function listAgentConnections(): Promise<AgentConnection[]> {
  const [file, tokens] = await Promise.all([loadFile(), listTokens()])
  const workspace = getWorkspaceRoot()
  const activeById = new Map(
    tokens
      .filter(
        (token) => token.revokedAt === null && token.workspace === workspace
      )
      .map((token) => [token.id, token])
  )
  return file.connections
    .flatMap((connection) => {
      if (connection.workspace !== workspace) return []
      const token = activeById.get(connection.credentialId)
      return token ? [publicConnection(connection, token)] : []
    })
    .sort((a, b) => (b.connectedAt ?? "").localeCompare(a.connectedAt ?? ""))
}

export async function disconnectAgentConnection(id: string): Promise<boolean> {
  return serialized(async () => {
    const [file, tokens] = await Promise.all([loadFile(), listTokens()])
    const workspace = getWorkspaceRoot()
    const tokenById = new Map(tokens.map((token) => [token.id, token]))
    const connection = file.connections.find(
      (candidate) =>
        candidate.id === id &&
        candidate.workspace === workspace &&
        tokenById.get(candidate.credentialId)?.workspace === workspace
    )
    if (!connection) return false
    await revokeToken(connection.credentialId)
    return true
  })
}

export class AgentConnectionUpdateError extends Error {}

/**
 * The owner's changes to an agent: its name (also its name in threads), its
 * icon, and its access. Returns the updated agent, or null if it is gone.
 */
export async function updateAgentConnection(
  id: string,
  changes: {
    displayName?: string
    icon?: string | null
    access?: AgentAccess
  }
): Promise<AgentConnection | null> {
  return serialized(async () => {
    const [file, tokens] = await Promise.all([loadFile(), listTokens()])
    const workspace = getWorkspaceRoot()
    const connection = file.connections.find(
      (candidate) => candidate.id === id && candidate.workspace === workspace
    )
    const token = tokens.find(
      (candidate) =>
        candidate.id === connection?.credentialId &&
        candidate.workspace === workspace &&
        candidate.revokedAt === null
    )
    if (!connection || !token) return null
    if (changes.access) {
      if (connection.mode === "always-on" && !changes.access.threads) {
        throw new AgentConnectionUpdateError(
          "An always-on agent needs threads: that is how it receives messages"
        )
      }
      const scopes = scopesForAccess(changes.access)
      if (scopes.length === 0) {
        throw new AgentConnectionUpdateError(
          "Choose at least one kind of access"
        )
      }
      await setTokenScopes(token.id, scopes)
      token.scopes = scopes
    }
    if (changes.icon !== undefined) {
      if (changes.icon === null) delete connection.icon
      else connection.icon = changes.icon
    }
    if (changes.displayName !== undefined) {
      connection.displayName = changes.displayName
      const { participant } = await resolveParticipant(
        { agent: token.agent, principal: token.principal },
        { name: changes.displayName }
      )
      connection.participant = participant
    }
    await saveFile(file)
    await notifyThreadParticipantsChanged()
    return publicConnection(connection, token)
  })
}
