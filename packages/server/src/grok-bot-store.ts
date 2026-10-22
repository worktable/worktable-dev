import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { readFileFingerprint } from "./file-fingerprint.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { workspaceCacheKey } from "./workspace.ts"
import type { TokenIdentity } from "./token-store.ts"
import { participantKey } from "./participant-store.ts"

const probeSchema = z.object({
  location: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("worktable") }),
    z.object({ kind: z.literal("space"), spaceId: z.string() }),
  ]),
  threadId: z.string(),
  messageId: z.string(),
  identityId: z.string(),
})
const connectionSchema = z.object({
  connectionId: z.string(),
  participantId: z.string(),
  participantKey: z.string(),
  principalId: z.string(),
  generation: z.string(),
  webhookUrl: z.string(),
  webhookKey: z.string(),
  enabled: z.boolean(),
  /** A secret-free tombstone keeps an old native routine from claiming as an ordinary adapter. */
  removed: z.boolean().optional(),
  executionMinutes: z.number().int().min(1).max(120),
  verifiedAt: z.string().optional(),
  probe: probeSchema.optional(),
  error: z.string().optional(),
  wake: z
    .object({ id: z.string(), attempts: z.number().int(), nextAt: z.number() })
    .optional(),
})
const fileSchema = z.object({
  type: z.literal("worktable.grok-bots"),
  version: z.literal(1),
  connections: z.array(connectionSchema),
  candidates: z
    .array(
      z.object({
        id: z.string(),
        displayName: z.string(),
        participantId: z.string(),
        participantKey: z.string(),
        principalId: z.string(),
      })
    )
    .default([]),
})
export type StoredGrokBot = z.infer<typeof connectionSchema>
export class GrokBotConfigurationError extends Error {}
type GrokFile = z.infer<typeof fileSchema>
const empty = (): GrokFile => ({
  type: "worktable.grok-bots",
  version: 1,
  connections: [],
  candidates: [],
})
const listeners = new Set<() => void>()
let queue: Promise<unknown> = Promise.resolve()
let cache:
  | { path: string; fingerprint: string | null; file: GrokFile }
  | undefined

function path(): string {
  return join(ensureAppDir(), "grok-bots", `${workspaceCacheKey()}.json`)
}
async function load(filePath: string): Promise<GrokFile> {
  try {
    return fileSchema.parse(JSON.parse(await readFile(filePath, "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty()
    throw error
  }
}
async function read(): Promise<GrokFile> {
  const filePath = path()
  const stamp = await readFileFingerprint(filePath)
  const fingerprint = stamp?.key ?? null
  if (
    !cache ||
    cache.path !== filePath ||
    cache.fingerprint !== fingerprint ||
    stamp?.racy
  ) {
    cache = { path: filePath, fingerprint, file: await load(filePath) }
  }
  return cache.file
}
export async function readGrokBots(): Promise<readonly StoredGrokBot[]> {
  return (await read()).connections
}
export async function readGrokBotCandidates() {
  return (await read()).candidates
}

/** The principal comes only from authenticated MCP ingress, never a setup form or display name. */
export async function observeGrokBotCandidate(
  identity: Pick<TokenIdentity, "principal" | "agent" | "credentialClass">,
  participant: { id: string; name: string }
): Promise<void> {
  if (
    identity.credentialClass !== "resource" ||
    identity.principal.type !== "agent"
  )
    return
  const candidate = {
    id: identity.principal.id,
    principalId: identity.principal.id,
    displayName: participant.name,
    participantId: participant.id,
    participantKey: participantKey(identity),
  }
  const previous = (await read()).candidates.find((c) => c.id === candidate.id)
  if (previous && JSON.stringify(previous) === JSON.stringify(candidate)) return
  await mutate((file) => {
    file.candidates = file.candidates.filter((c) => c.id !== candidate.id)
    file.candidates.push(candidate)
  })
}

/** Only local private state goes through this lock; never call remote services inside it. */
async function mutate<T>(change: (file: GrokFile) => T): Promise<T> {
  const filePath = path()
  const run = () =>
    withCrossProcessLock(
      `${filePath}.lock`,
      { label: "Grok Bot connections" },
      async () => {
        const file = await load(filePath)
        const result = change(file)
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
        const temporary = `${filePath}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify(file), {
          encoding: "utf8",
          mode: 0o600,
        })
        await chmod(temporary, 0o600)
        await rename(temporary, filePath)
        cache = undefined
        return result
      }
    )
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}
export function onGrokBotChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function signalGrokBotChange(): void {
  for (const listener of listeners) listener()
}

export async function saveGrokBot(
  input: Omit<StoredGrokBot, "generation">
): Promise<void> {
  await mutate((file) => {
    if (
      file.connections.some(
        (c) =>
          c.participantId === input.participantId &&
          c.connectionId !== input.connectionId &&
          !c.removed
      )
    ) {
      throw new GrokBotConfigurationError(
        "This identity already has a Grok Bot routine. Remove that routine before connecting another sign-in."
      )
    }
    file.connections = file.connections.filter(
      (c) =>
        c.connectionId !== input.connectionId &&
        !(c.removed && c.participantId === input.participantId)
    )
    file.connections.push({ ...input, generation: randomUUID() })
  })
  signalGrokBotChange()
}
export async function updateGrokBot(
  connection: Pick<StoredGrokBot, "connectionId" | "generation">,
  changes: Partial<
    Pick<StoredGrokBot, "enabled" | "verifiedAt" | "probe" | "error" | "wake">
  >
): Promise<boolean> {
  return mutate((file) => {
    const current = file.connections.find(
      (c) =>
        c.connectionId === connection.connectionId &&
        c.generation === connection.generation
    )
    if (!current) return false
    Object.assign(current, changes)
    return true
  })
}
/** Cross-process reservation coalesces simultaneous signals before any network I/O. */
export async function reserveGrokBotWake(
  connection: StoredGrokBot,
  delays: readonly number[]
) {
  return mutate((file) => {
    const current = file.connections.find(
      (c) =>
        c.connectionId === connection.connectionId &&
        c.generation === connection.generation
    )
    if (!current?.enabled || current.error) return undefined
    const wake = current.wake ?? {
      id: `wake_${randomUUID()}`,
      attempts: 0,
      nextAt: 0,
    }
    if (wake.nextAt > Date.now() || wake.attempts >= delays.length)
      return undefined
    current.wake = {
      ...wake,
      attempts: wake.attempts + 1,
      nextAt: Date.now() + delays[wake.attempts]!,
    }
    return current.wake
  })
}
export async function removeGrokBot(connectionId: string): Promise<void> {
  await mutate((file) => {
    const current = file.connections.find(
      (c) => c.connectionId === connectionId
    )
    if (!current) return
    Object.assign(current, {
      enabled: false,
      removed: true,
      webhookUrl: "",
      webhookKey: "",
      generation: randomUUID(),
      probe: undefined,
      verifiedAt: undefined,
      wake: undefined,
      error: undefined,
    })
  })
  signalGrokBotChange()
}
export async function grokBotPolicy(
  participantId: string
): Promise<StoredGrokBot | undefined> {
  return (await readGrokBots()).find((c) => c.participantId === participantId)
}

/** Only the provider's routine endpoint can receive its bearer secret. No redirects. */
export function validateGrokWebhook(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Enter the routine's webhook URL")
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api2.cursor.sh" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/automations\/webhook\/[A-Za-z0-9_-]+$/.test(url.pathname)
  ) {
    throw new Error(
      "Use the Grok Bot routine URL at https://api2.cursor.sh/automations/webhook/…"
    )
  }
  return url.href
}

onWorkspaceChange((event) => {
  if (event.type !== "workspaceReset") return
  return mutate((file) => {
    file.connections = []
    file.candidates = []
  }).then(signalGrokBotChange)
})
