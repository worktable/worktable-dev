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
  clientIdForAgentLabel,
  defaultAgentNameForLabel,
  platformForAdapter,
  platformForClient,
  scopesForAccess,
} from "@worktable/types"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import {
  participantKey,
  participantsByKey,
  resolveParticipant,
} from "./participant-store.ts"
import {
  listTokens,
  revokeToken,
  rotateAgentToken,
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
  let carryName: { token: TokenMetadata; name: string } | undefined
  const stored = await serialized(async () => {
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
      if (
        existing.participant === null &&
        existing.displayName &&
        input.participant &&
        input.participant.name !== existing.displayName
      ) {
        carryName = { token: incomingToken, name: existing.displayName }
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
  if (carryName) {
    // Its first connection since agents have one name: the name its owner
    // gave it becomes its thread name. Outside the lock, like any rename.
    await resolveParticipant(
      { agent: carryName.token.agent, principal: carryName.token.principal },
      { name: carryName.name }
    )
  }
  return stored
}

function platformForTarget(target: AgentConnectionTarget): AgentPlatformId {
  return target.kind === "agent-adapter"
    ? platformForAdapter(target.adapter)
    : platformForClient(target.clientId)
}

const UNRECORDED_PREFIX = "acn_tok_"

/**
 * An agent credential minted outside pairing (`worktable mcp setup`, the
 * Desktop and manual setup panels, or a token made by hand with an agent
 * label) is still an agent. It gets a record the first time its owner edits
 * it. Pairing labels (`client@host`, `adapter@install`) always have one.
 */
function unrecordedConnection(
  token: TokenMetadata
): StoredAgentConnection | null {
  if (!token.agent || token.agent.includes("@")) return null
  const clientId = clientIdForAgentLabel(token.agent)
  return {
    id: `${UNRECORDED_PREFIX}${token.id}`,
    workspace: token.workspace,
    target: { kind: "mcp-client", clientId },
    mode: "on-demand",
    participant: null,
    machine: null,
    credentialId: token.id,
    connectedAt: token.createdAt,
    platform: platformForClient(clientId),
  }
}

/** Recorded connections plus agent credentials that have none yet. */
function allConnections(
  file: AgentConnectionFile,
  tokens: TokenMetadata[],
  workspace: string
): StoredAgentConnection[] {
  const recorded = file.connections.filter(
    (connection) => connection.workspace === workspace
  )
  const recordedCredentials = new Set(
    recorded.map((connection) => connection.credentialId)
  )
  return [
    ...recorded,
    ...tokens.flatMap((token) =>
      token.workspace === workspace && !recordedCredentials.has(token.id)
        ? (unrecordedConnection(token) ?? [])
        : []
    ),
  ]
}

function publicConnection(
  stored: StoredAgentConnection,
  token: TokenMetadata,
  participants: Map<string, ParticipantRef>
): AgentConnection {
  const platform = stored.platform ?? platformForTarget(stored.target)
  // The participant's current record, not the copy saved when it connected:
  // the agent itself may have renamed it since.
  const participant =
    participants.get(
      participantKey({ agent: token.agent, principal: token.principal })
    ) ?? stored.participant
  // A pairing recorded before agents had one name keeps the name its owner
  // gave it until reconnecting or renaming carries that name into threads.
  const legacyName =
    stored.participant === null ? stored.displayName : undefined
  return {
    id: stored.id,
    authKind: "local-token",
    // One name: the agent's thread participant carries it once it has one.
    displayName:
      legacyName ??
      participant?.name ??
      stored.displayName ??
      (platform === "other"
        ? (defaultAgentNameForLabel(token.agent) ??
          token.agent ??
          AGENT_PLATFORMS.other.name)
        : AGENT_PLATFORMS[platform].name),
    platform,
    icon: stored.icon ?? null,
    access: accessFromScopes(token.scopes),
    target: stored.target,
    mode: stored.mode,
    participant,
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
  const [file, tokens, participants] = await Promise.all([
    loadFile(),
    listTokens(),
    participantsByKey(),
  ])
  const workspace = getWorkspaceRoot()
  const tokensById = new Map(tokens.map((token) => [token.id, token]))
  const names = new Map<string, string>()
  for (const connection of allConnections(file, tokens, workspace)) {
    const token = tokensById.get(connection.credentialId)
    if (!token) continue
    names.set(
      `local-token:${token.id}`,
      publicConnection(connection, token, participants).displayName
    )
  }
  return names
}

export async function listAgentConnections(): Promise<AgentConnection[]> {
  const [file, tokens, participants] = await Promise.all([
    loadFile(),
    listTokens(),
    participantsByKey(),
  ])
  const workspace = getWorkspaceRoot()
  const activeById = new Map(
    tokens
      .filter(
        (token) => token.revokedAt === null && token.workspace === workspace
      )
      .map((token) => [token.id, token])
  )
  return allConnections(file, tokens, workspace)
    .flatMap((connection) => {
      const token = activeById.get(connection.credentialId)
      return token ? [publicConnection(connection, token, participants)] : []
    })
    .sort((a, b) => (b.connectedAt ?? "").localeCompare(a.connectedAt ?? ""))
}

export async function disconnectAgentConnection(id: string): Promise<boolean> {
  return serialized(async () => {
    const [file, tokens] = await Promise.all([loadFile(), listTokens()])
    const workspace = getWorkspaceRoot()
    const tokenById = new Map(tokens.map((token) => [token.id, token]))
    const connection = allConnections(file, tokens, workspace).find(
      (candidate) =>
        candidate.id === id &&
        tokenById.get(candidate.credentialId)?.workspace === workspace
    )
    if (!connection) return false
    await revokeToken(connection.credentialId)
    return true
  })
}

/**
 * Re-issue the credential of an agent set up outside pairing (`worktable mcp
 * setup --with-token`). The agent stays the same one: its record follows the
 * new credential, and access its owner narrowed stays narrowed. `scopes`
 * applies only to an agent set up for the first time.
 */
export async function rotateAgentCredential(options: {
  agent: string
  scopes: string[]
}): Promise<{ token: string; metadata: TokenMetadata }> {
  return serialized(async () => {
    const workspace = getWorkspaceRoot()
    // Read the record first: an unreadable one fails before the current
    // credential is revoked.
    const [file, tokens] = await Promise.all([loadFile(), listTokens()])
    const predecessors = tokens.filter(
      (token) =>
        token.agent === options.agent &&
        token.workspace === workspace &&
        token.revokedAt === null
    )
    const rotated = await rotateAgentToken({
      agent: options.agent,
      scopes: predecessors.at(-1)?.scopes ?? options.scopes,
    })
    const replaced = new Set(predecessors.map((token) => token.id))
    let changed = false
    for (const connection of file.connections) {
      if (
        connection.workspace === workspace &&
        replaced.has(connection.credentialId)
      ) {
        connection.credentialId = rotated.metadata.id
        changed = true
      }
    }
    // The new credential is already the only one, so it is returned even if
    // its record cannot follow; the agent then lists as newly set up.
    if (changed) await saveFile(file).catch(() => undefined)
    return rotated
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
  const token = await serialized(async () => {
    const [file, tokens] = await Promise.all([loadFile(), listTokens()])
    const workspace = getWorkspaceRoot()
    let previousScopes: string[] | undefined
    let connection = file.connections.find(
      (candidate) => candidate.id === id && candidate.workspace === workspace
    )
    if (!connection && id.startsWith(UNRECORDED_PREFIX)) {
      // First edit of an agent credential minted outside pairing: record it.
      const unrecorded = allConnections(file, tokens, workspace).find(
        (candidate) => candidate.id === id
      )
      if (unrecorded) {
        connection = unrecorded
        file.connections.push(unrecorded)
      }
    }
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
      // Revoked meanwhile (token management has its own lock): nothing to edit.
      if (!(await setTokenScopes(token.id, scopes))) return null
      previousScopes = token.scopes
    }
    if (changes.icon !== undefined) {
      if (changes.icon === null) delete connection.icon
      else connection.icon = changes.icon
    }
    if (changes.displayName !== undefined) {
      connection.displayName = changes.displayName
    }
    try {
      await saveFile(file)
    } catch (error) {
      // The edit applies whole or not at all.
      if (previousScopes) {
        await setTokenScopes(token.id, previousScopes).catch(() => false)
      }
      throw error
    }
    return token
  })
  if (!token) return null
  if (changes.displayName !== undefined) {
    // Outside the connection lock: the rename rewrites every thread the
    // agent is in, and other processes should not wait on that.
    const { participant } = await resolveParticipant(
      { agent: token.agent, principal: token.principal },
      { name: changes.displayName }
    )
    // From now on its participant carries its name.
    await serialized(async () => {
      const file = await loadFile()
      const connection = file.connections.find(
        (candidate) => candidate.id === id && candidate.participant === null
      )
      if (!connection) return
      connection.participant = participant
      await saveFile(file)
    })
  }
  await notifyThreadParticipantsChanged()
  return (
    (await listAgentConnections()).find((connection) => connection.id === id) ??
    null
  )
}
