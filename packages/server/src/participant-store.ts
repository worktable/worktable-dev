import { createHash, randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ParticipantKind, ParticipantRef } from "@worktable/types"
import { ParticipantRefSchema } from "@worktable/types"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { listSpaces } from "./store.ts"
import { scanAllThreads } from "./thread-store.ts"
import {
  listTokens,
  type RequestPrincipal,
  type TokenIdentity,
} from "./token-store.ts"
import { getWorkspaceRoot, workspaceCacheKey } from "./workspace.ts"
import { notifyWorkspaceChange } from "./workspace-events.ts"

interface ParticipantBinding {
  key: string
  participant: ParticipantRef
  defaultSpaceId?: string
  /** Location-aware delivery protocol supported by this participant adapter. */
  threadLocationVersion?: 2
  createdAt: string
  updatedAt: string
}

interface ParticipantBindingsFile {
  type: "worktable.participant-bindings"
  version: 1
  bindings: ParticipantBinding[]
}

export interface ResolveParticipantOptions {
  name?: string
  /** Pass null when a connection explicitly removes its saved default Space. */
  defaultSpaceId?: string | null
  threadLocationVersion?: 2
}

let mutationQueue: Promise<unknown> = Promise.resolve()
let tmpCounter = 0

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const locked = () =>
    withCrossProcessLock(
      `${bindingsPath()}.lock`,
      { label: "Participant bindings" },
      fn
    )
  const next = mutationQueue.then(locked, locked)
  mutationQueue = next.catch(() => undefined)
  return next
}

function bindingsPath(): string {
  return join(ensureAppDir(), "participants", `${workspaceCacheKey()}.json`)
}

async function loadBindings(): Promise<ParticipantBindingsFile> {
  try {
    const parsed = JSON.parse(await readFile(bindingsPath(), "utf8")) as unknown
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { type?: unknown }).type !==
        "worktable.participant-bindings" ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { bindings?: unknown }).bindings)
    ) {
      throw new Error("Invalid participant bindings file")
    }
    const bindings = (parsed as ParticipantBindingsFile).bindings.filter(
      (binding) =>
        typeof binding.key === "string" &&
        ParticipantRefSchema.safeParse(binding.participant).success
    )
    return {
      type: "worktable.participant-bindings",
      version: 1,
      bindings,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        type: "worktable.participant-bindings",
        version: 1,
        bindings: [],
      }
    }
    throw error
  }
}

async function saveBindings(file: ParticipantBindingsFile): Promise<void> {
  const path = bindingsPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8")
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

async function notifyParticipantsChanged(): Promise<void> {
  notifyWorkspaceChange({ type: "participants" })
  for (const space of await listSpaces()) {
    notifyWorkspaceChange({ type: "participants", spaceId: space.id })
  }
}

function participantKey(
  identity: Pick<TokenIdentity, "agent" | "principal">
): string {
  return identity.agent
    ? `agent:${identity.agent}`
    : `principal:${identity.principal.id}`
}

export function connectionIdForIdentity(
  identity: Pick<TokenIdentity, "agent" | "principal">
): string {
  return `con_${createHash("sha256")
    .update(participantKey(identity))
    .digest("base64url")}`
}

function participantIdentityFingerprint(
  identity: Pick<TokenIdentity, "agent" | "principal">
): string {
  return `pid_${createHash("sha256")
    .update(participantKey(identity))
    .digest("base64url")}`
}

function legacyManagedBinding(
  file: ParticipantBindingsFile,
  key: string
): ParticipantBinding | undefined {
  if (!key.startsWith("agent:managed:")) return undefined
  return file.bindings.find((binding) => binding.key === "agent:managed")
}

function localCredentialAgentForBinding(key: string): string | undefined {
  if (!key.startsWith("agent:")) return undefined
  return key.slice("agent:".length)
}

function localCredentialPrincipalForBinding(key: string): string | undefined {
  const prefix = "principal:local-token:"
  return key.startsWith(prefix) ? key.slice("principal:".length) : undefined
}

function kindForPrincipal(principal: RequestPrincipal): ParticipantKind {
  return principal.type
}

function createParticipant(
  identity: Pick<TokenIdentity, "agent" | "principal">,
  name?: string
): ParticipantRef {
  return {
    id: `ptc_${randomBytes(16).toString("base64url")}`,
    kind: kindForPrincipal(identity.principal),
    name: name?.trim() || identity.principal.displayName,
    identityFingerprint: participantIdentityFingerprint(identity),
  }
}

async function recoverPortableParticipant(
  identity: Pick<TokenIdentity, "agent" | "principal">,
  options: ResolveParticipantOptions
): Promise<ParticipantRef | undefined> {
  const fingerprint = participantIdentityFingerprint(identity)
  const matches = new Map<string, ParticipantRef>()
  const scan = await scanAllThreads()
  if (!scan.complete) {
    throw new ThreadParticipantError(
      "THREAD_STORE_INCOMPLETE",
      "Participant recovery is temporarily unavailable while a portable thread file is unreadable"
    )
  }
  for (const thread of scan.threads) {
    for (const member of thread.members) {
      if (member.identityFingerprint === fingerprint) {
        matches.set(member.id, member)
      }
    }
  }
  if (matches.size > 1) {
    throw new ThreadParticipantError(
      "AMBIGUOUS_PARTICIPANT",
      "The authenticated identity maps to more than one portable participant"
    )
  }
  const recovered = matches.values().next().value as ParticipantRef | undefined
  const name = options.name?.trim()
  return recovered ? { ...recovered, ...(name ? { name } : {}) } : undefined
}

export async function resolveParticipant(
  identity: Pick<TokenIdentity, "agent" | "principal">,
  options: ResolveParticipantOptions = {}
): Promise<{
  participant: ParticipantRef
  defaultSpaceId?: string
  threadLocationVersion?: 2
}> {
  return serialized(async () => {
    const file = await loadBindings()
    const key = participantKey(identity)
    const exact = file.bindings.find((binding) => binding.key === key)
    const existing = exact ?? legacyManagedBinding(file, key)
    const now = new Date().toISOString()
    if (existing) {
      const identityFingerprint = participantIdentityFingerprint(identity)
      const nextName =
        options.name?.trim() ||
        (!exact && key.startsWith("agent:managed:")
          ? identity.principal.displayName
          : undefined)
      const nextDefault =
        options.defaultSpaceId === null
          ? undefined
          : (options.defaultSpaceId ?? existing.defaultSpaceId)
      const nextThreadLocationVersion =
        options.threadLocationVersion ?? existing.threadLocationVersion
      if (
        existing.key !== key ||
        existing.participant.identityFingerprint !== identityFingerprint ||
        (nextName && nextName !== existing.participant.name) ||
        nextDefault !== existing.defaultSpaceId ||
        nextThreadLocationVersion !== existing.threadLocationVersion
      ) {
        existing.key = key
        existing.participant = {
          ...existing.participant,
          identityFingerprint,
          ...(nextName ? { name: nextName } : {}),
        }
        existing.defaultSpaceId = nextDefault
        existing.threadLocationVersion = nextThreadLocationVersion
        existing.updatedAt = now
        await saveBindings(file)
        await notifyParticipantsChanged()
      }
      return {
        participant: existing.participant,
        defaultSpaceId: existing.defaultSpaceId,
        threadLocationVersion: existing.threadLocationVersion,
      }
    }

    const participant =
      (await recoverPortableParticipant(identity, options)) ??
      createParticipant(identity, options.name)
    file.bindings.push({
      key,
      participant,
      ...(options.defaultSpaceId
        ? { defaultSpaceId: options.defaultSpaceId }
        : {}),
      threadLocationVersion: options.threadLocationVersion,
      createdAt: now,
      updatedAt: now,
    })
    await saveBindings(file)
    await notifyParticipantsChanged()
    return {
      participant,
      ...(options.defaultSpaceId
        ? { defaultSpaceId: options.defaultSpaceId }
        : {}),
      threadLocationVersion: options.threadLocationVersion,
    }
  })
}

export async function listParticipantBindings(): Promise<
  Array<{
    participant: ParticipantRef
    defaultSpaceId?: string
    threadLocationVersion?: 2
  }>
> {
  const file = await loadBindings()
  const tokens = await listTokens()
  const workspace = getWorkspaceRoot()
  const localAgentCredentials = new Map<string, boolean>()
  const localPrincipalCredentials = new Map<string, boolean>()
  for (const token of tokens) {
    if (token.workspace !== workspace) continue
    localPrincipalCredentials.set(
      token.principal.id,
      (localPrincipalCredentials.get(token.principal.id) ?? false) ||
        !token.revokedAt
    )
    if (token.agent) {
      localAgentCredentials.set(
        token.agent,
        (localAgentCredentials.get(token.agent) ?? false) || !token.revokedAt
      )
    }
  }
  return file.bindings
    .filter((binding) => {
      const credentialAgent = localCredentialAgentForBinding(binding.key)
      if (credentialAgent) {
        const credentialActive = localAgentCredentials.get(credentialAgent)
        // An absent entry is an externally authenticated identity. Local agents
        // with known credentials remain discoverable only while one is active.
        return credentialActive ?? true
      }
      const credentialPrincipal = localCredentialPrincipalForBinding(
        binding.key
      )
      if (!credentialPrincipal) return true
      return localPrincipalCredentials.get(credentialPrincipal) ?? false
    })
    .map(({ participant, defaultSpaceId, threadLocationVersion }) => ({
      participant,
      ...(defaultSpaceId ? { defaultSpaceId } : {}),
      ...(threadLocationVersion ? { threadLocationVersion } : {}),
    }))
}

export async function findParticipant(
  value: string
): Promise<ParticipantRef | null> {
  const needle = value.trim().toLocaleLowerCase()
  const participants = (await listParticipantBindings()).map(
    (binding) => binding.participant
  )
  const byId = participants.find((participant) => participant.id === value)
  if (byId) return byId
  const byName = participants.filter(
    (participant) => participant.name.toLocaleLowerCase() === needle
  )
  if (byName.length > 1) {
    throw new ThreadParticipantError(
      "AMBIGUOUS_PARTICIPANT",
      `More than one participant is named "${value}"; use a participant ID`
    )
  }
  return byName[0] ?? null
}

export class ThreadParticipantError extends Error {
  readonly code:
    | "PARTICIPANT_NOT_FOUND"
    | "AMBIGUOUS_PARTICIPANT"
    | "THREAD_STORE_INCOMPLETE"

  constructor(
    code:
      | "PARTICIPANT_NOT_FOUND"
      | "AMBIGUOUS_PARTICIPANT"
      | "THREAD_STORE_INCOMPLETE",
    message: string
  ) {
    super(message)
    this.name = "ThreadParticipantError"
    this.code = code
  }
}

export async function requireParticipant(
  value: string
): Promise<ParticipantRef> {
  const participant = await findParticipant(value)
  if (!participant) {
    throw new ThreadParticipantError(
      "PARTICIPANT_NOT_FOUND",
      `Participant not found: ${value}`
    )
  }
  return participant
}
