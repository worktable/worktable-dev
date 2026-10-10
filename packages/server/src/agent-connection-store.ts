import { createHash } from "node:crypto"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  AgentAccess,
  AgentConnection,
  AgentConnectionTarget,
  AgentPlatformId,
  DirectAgentLabel,
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
  createToken,
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
  /**
   * An agent set up outside pairing is its label: the record follows the
   * label's newest active credential when setup issues a new one.
   */
  agentLabel?: string
}

/**
 * How a sign-in agent (Claude or ChatGPT on Worktable Cloud) appears here.
 * Its access and grant live with Cloud; its thread name lives with its
 * participant.
 */
interface StoredSignInPresentation {
  principalId: string
  platform?: AgentPlatformId
  icon?: string
  /**
   * False when its owner took Threads away on Cloud, which enforces it; here
   * it only keeps the agent out of thread recipients.
   */
  threads?: boolean
}

interface AgentConnectionFile {
  type: "worktable.agent-connections"
  version: 1
  connections: StoredAgentConnection[]
  signIns?: StoredSignInPresentation[]
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
  /** Applied to a new agent only; the owner changes it afterwards. */
  icon?: string
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

const LABELED_PREFIX = "acn_agent_"

function labeledConnectionId(workspace: string, label: string): string {
  return `${LABELED_PREFIX}${createHash("sha256")
    .update(`${workspace}\0${label}`)
    .digest("hex")
    .slice(0, 24)}`
}

/**
 * Active credentials of agents set up outside pairing (`worktable mcp setup`,
 * the Desktop and manual setup panels, or a token made by hand with an agent
 * label), by label, oldest first. Pairing labels (`client@host`,
 * `adapter@install`) are recorded when they connect.
 */
function labeledCredentials(
  tokens: TokenMetadata[],
  workspace: string
): Map<string, TokenMetadata[]> {
  const byLabel = new Map<string, TokenMetadata[]>()
  for (const token of tokens) {
    if (
      !token.agent ||
      token.agent.includes("@") ||
      token.revokedAt !== null ||
      token.workspace !== workspace
    ) {
      continue
    }
    byLabel.set(token.agent, [...(byLabel.get(token.agent) ?? []), token])
  }
  return byLabel
}

/** An agent set up outside pairing, before its owner first edits it. */
function unrecordedConnection(
  label: string,
  credentials: TokenMetadata[],
  workspace: string
): StoredAgentConnection {
  const clientId = clientIdForAgentLabel(label)
  return {
    id: labeledConnectionId(workspace, label),
    workspace,
    target: { kind: "mcp-client", clientId },
    mode: "on-demand",
    participant: null,
    machine: null,
    credentialId: credentials.at(-1)!.id,
    connectedAt: credentials[0]!.createdAt,
    platform: platformForClient(clientId),
    agentLabel: label,
  }
}

/**
 * Recorded connections plus agents set up outside pairing that have no
 * record yet. One agent per label, however many credentials it holds.
 */
function allConnections(
  file: AgentConnectionFile,
  tokens: TokenMetadata[],
  workspace: string
): StoredAgentConnection[] {
  const byLabel = labeledCredentials(tokens, workspace)
  const recorded = file.connections
    .filter((connection) => connection.workspace === workspace)
    .map((connection) => {
      const newest = connection.agentLabel
        ? byLabel.get(connection.agentLabel)?.at(-1)
        : undefined
      return newest ? { ...connection, credentialId: newest.id } : connection
    })
  const recordedLabels = new Set(
    recorded.flatMap((connection) =>
      connection.agentLabel ? [connection.agentLabel] : []
    )
  )
  return [
    ...recorded,
    ...[...byLabel].flatMap(([label, credentials]) =>
      recordedLabels.has(label)
        ? []
        : [unrecordedConnection(label, credentials, workspace)]
    ),
  ]
}

/** Every credential an agent holds: one for a pairing, any for a label. */
function credentialsOf(
  connection: StoredAgentConnection,
  tokens: TokenMetadata[],
  workspace: string,
  includeRevoked = false
): TokenMetadata[] {
  return tokens.filter(
    (token) =>
      token.workspace === workspace &&
      (includeRevoked || token.revokedAt === null) &&
      (connection.agentLabel
        ? token.agent === connection.agentLabel
        : token.id === connection.credentialId)
  )
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
    const name = publicConnection(connection, token, participants).displayName
    for (const credential of credentialsOf(
      connection,
      tokens,
      workspace,
      true
    )) {
      names.set(`local-token:${credential.id}`, name)
    }
    names.set(`local-token:${token.id}`, name)
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

/** The agent an app connected with a credential made here is, if any. */
export async function findAppAgent(
  label: DirectAgentLabel
): Promise<AgentConnection | null> {
  const id = labeledConnectionId(getWorkspaceRoot(), label)
  return (
    (await listAgentConnections()).find((connection) => connection.id === id) ??
    null
  )
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
    const credentials = credentialsOf(connection, tokens, workspace)
    if (credentials.length === 0) {
      await revokeToken(connection.credentialId)
    }
    for (const credential of credentials) await revokeToken(credential.id)
    return true
  })
}

/**
 * Re-issue the credential of an agent set up outside pairing (`worktable mcp
 * setup --with-token`). It stays the same agent: its record follows its
 * label, and access its owner narrowed stays narrowed. `scopes` applies only
 * to an agent set up for the first time.
 */
export async function rotateAgentCredential(options: {
  agent: string
  scopes: string[]
}): Promise<{ token: string; metadata: TokenMetadata }> {
  return rotateAgentToken({
    agent: options.agent,
    scopes: (await currentAgentScopes(options.agent)) ?? options.scopes,
  })
}

/**
 * The scopes an agent set up outside pairing holds now, so setting it up
 * again keeps what its owner chose. Null for an agent not set up yet.
 */
export async function currentAgentScopes(
  agent: string
): Promise<string[] | null> {
  const workspace = getWorkspaceRoot()
  return (
    labeledCredentials(await listTokens(), workspace)
      .get(agent)
      ?.at(-1)?.scopes ?? null
  )
}

/**
 * Connect an app with a credential made here (the Claude and ChatGPT desktop
 * apps, or an MCP client configured by hand), with the name and access its
 * owner chose. Connecting the same app again is the same agent, so its
 * other credentials take the same access. Returns the credential once.
 */
export async function createAgentCredential(input: {
  label: DirectAgentLabel
  displayName?: string
  icon?: string | null
  access: AgentAccess
}): Promise<{ token: string; connection: AgentConnection }> {
  const scopes = scopesForAccess(input.access)
  if (scopes.length === 0) {
    throw new AgentConnectionUpdateError("Choose at least one kind of access")
  }
  const { token, metadata } = await createToken({ agent: input.label, scopes })
  try {
    const connection = await updateAgentConnection(
      labeledConnectionId(getWorkspaceRoot(), input.label),
      {
        access: input.access,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
      }
    )
    if (!connection) throw new Error("The new credential was revoked")
    return { token, connection }
  } catch (error) {
    // Its secret is never delivered, so it must not stay valid.
    await revokeToken(metadata.id).catch(() => false)
    throw error
  }
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
    const previousScopes = new Map<string, string[]>()
    const current = allConnections(file, tokens, workspace).find(
      (candidate) => candidate.id === id
    )
    let connection = file.connections.find(
      (candidate) => candidate.id === id && candidate.workspace === workspace
    )
    if (!connection && current?.agentLabel) {
      // First edit of an agent set up outside pairing: record it.
      connection = current
      file.connections.push(current)
    }
    if (!connection || !current) return null
    // A labeled agent's record follows its newest credential.
    connection.credentialId = current.credentialId
    const token = tokens.find(
      (candidate) =>
        candidate.id === connection.credentialId &&
        candidate.workspace === workspace &&
        candidate.revokedAt === null
    )
    if (!token) return null
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
      // Every credential the agent holds gets the access. Revoked meanwhile
      // (token management has its own lock): nothing to edit.
      for (const credential of credentialsOf(connection, tokens, workspace)) {
        if (await setTokenScopes(credential.id, scopes)) {
          previousScopes.set(credential.id, credential.scopes)
        } else if (credential.id === token.id) {
          for (const [restoreId, restore] of previousScopes) {
            await setTokenScopes(restoreId, restore).catch(() => false)
          }
          return null
        }
      }
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
      for (const [restoreId, restore] of previousScopes) {
        await setTokenScopes(restoreId, restore).catch(() => false)
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

/**
 * The owner names a sign-in agent, picks its icon (null for its platform's
 * logo), and records its platform. Its thread participant takes the name.
 */
export async function updateSignInAgent(
  principalId: string,
  changes: {
    displayName?: string
    icon?: string | null
    platform?: AgentPlatformId
    threads?: boolean
  }
): Promise<void> {
  await serialized(async () => {
    const file = await loadFile()
    const signIns = (file.signIns ??= [])
    let record = signIns.find((entry) => entry.principalId === principalId)
    if (!record) {
      record = { principalId }
      signIns.push(record)
    }
    if (changes.platform) record.platform = changes.platform
    if (changes.icon === null) delete record.icon
    else if (changes.icon !== undefined) record.icon = changes.icon
    if (changes.threads === true) delete record.threads
    else if (changes.threads === false) record.threads = false
    await saveFile(file)
  })
  if (changes.displayName !== undefined) {
    // Outside the connection lock: a rename rewrites the agent's threads.
    await resolveParticipant(
      {
        agent: null,
        principal: {
          id: principalId,
          type: "agent",
          displayName: changes.displayName,
        },
      },
      { name: changes.displayName }
    )
  }
  await notifyThreadParticipantsChanged()
}

/**
 * Platform, icon, and Threads access of sign-in agents, keyed by their
 * participant's key.
 */
export async function signInPresentations(): Promise<
  Map<string, { platform?: AgentPlatformId; icon?: string; threads?: false }>
> {
  const file = await loadFile()
  return new Map(
    (file.signIns ?? []).map((entry) => [
      `principal:${entry.principalId}`,
      {
        platform: entry.platform,
        icon: entry.icon,
        ...(entry.threads === false ? { threads: false as const } : {}),
      },
    ])
  )
}
