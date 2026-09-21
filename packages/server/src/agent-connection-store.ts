import { createHash } from "node:crypto"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  AgentConnection,
  AgentConnectionTarget,
  ParticipantRef,
} from "@worktable/types"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { listTokens, revokeToken, type TokenMetadata } from "./token-store.ts"
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
        connectedAt: new Date().toISOString(),
      })
    }
    await saveFile(file)
    if (participantsChanged) await notifyThreadParticipantsChanged()
    return true
  })
}

function publicConnection(
  stored: StoredAgentConnection,
  token: TokenMetadata
): AgentConnection {
  const displayName =
    stored.displayName ??
    (stored.target.kind === "agent-adapter"
      ? stored.target.adapter === "openclaw"
        ? "OpenClaw"
        : stored.target.adapter
      : (stored.target.clientId ?? token.agent ?? "Agent"))
  return {
    id: stored.id,
    authKind: "local-token",
    displayName,
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

export async function renameAgentConnection(
  id: string,
  displayName: string
): Promise<boolean> {
  return serialized(async () => {
    const [file, tokens] = await Promise.all([loadFile(), listTokens()])
    const workspace = getWorkspaceRoot()
    const activeTokenIds = new Set(
      tokens
        .filter(
          (token) => token.workspace === workspace && token.revokedAt === null
        )
        .map((token) => token.id)
    )
    const connection = file.connections.find(
      (candidate) =>
        candidate.id === id &&
        candidate.workspace === workspace &&
        activeTokenIds.has(candidate.credentialId)
    )
    if (!connection) return false
    connection.displayName = displayName
    await saveFile(file)
    return true
  })
}
