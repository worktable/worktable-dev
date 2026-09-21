import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ThreadActivity, ThreadLocation } from "@worktable/types"
import { threadLocationKey } from "@worktable/types"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { notifyWorkspaceChange, onWorkspaceChange } from "./workspace-events.ts"
import { workspaceCacheKey } from "./workspace.ts"

type InternalDeliveryState =
  | "queued"
  | "leased"
  | "accepted"
  | "working"
  | "receiving"
  | "replied"
  | "failed"

interface DeliveryRecord {
  messageId: string
  threadId: string
  location: ThreadLocation
  authorId: string
  participantId: string
  identityId: string
  state: InternalDeliveryState
  revision: number
  attempts: number
  nextAttemptAt?: string
  leaseId?: string
  leaseExpiresAt?: string
  receivedCharacters?: number
  error?: {
    code: string
    message: string
    retryable: boolean
  }
  createdAt: string
  updatedAt: string
}

interface DeliveryFile {
  type: "worktable.thread-deliveries"
  version: 4
  deliveries: DeliveryRecord[]
  canonicalRevisions: Record<string, number>
}

export class ThreadDeliveryError extends Error {
  readonly code: "LEASE_LOST" | "DELIVERY_FAILED"

  constructor(code: "LEASE_LOST" | "DELIVERY_FAILED", message: string) {
    super(message)
    this.name = "ThreadDeliveryError"
    this.code = code
  }
}

export interface ClaimedDelivery {
  messageId: string
  threadId: string
  location: ThreadLocation
  /** @deprecated Use location instead. */
  spaceId?: string
  leaseId: string
  leaseExpiresAt: string
  attempt: number
  identityId: string
}

const LEASE_MS = 60_000
const MAX_ATTEMPTS = 3
const PROGRESS_COALESCE_MS = 500

let mutationQueue: Promise<unknown> = Promise.resolve()
let tmpCounter = 0

function normalizeDeliveryLocation(
  location: ThreadLocation | string
): ThreadLocation {
  return typeof location === "string"
    ? { kind: "space", spaceId: location }
    : location
}

function deliveryInputLocation(input: {
  location?: ThreadLocation
  spaceId?: string
}): ThreadLocation {
  if (input.location) return input.location
  if (input.spaceId) return { kind: "space", spaceId: input.spaceId }
  throw new Error("Thread delivery location is required")
}

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const locked = () =>
    withCrossProcessLock(
      `${deliveryPath()}.lock`,
      { label: "Thread delivery state" },
      fn
    )
  const next = mutationQueue.then(locked, locked)
  mutationQueue = next.catch(() => undefined)
  return next
}

function deliveryPath(): string {
  return join(
    ensureAppDir(),
    "thread-deliveries",
    `${workspaceCacheKey()}.json`
  )
}

function emptyFile(): DeliveryFile {
  return {
    type: "worktable.thread-deliveries",
    version: 4,
    deliveries: [],
    canonicalRevisions: {},
  }
}

async function loadFile(): Promise<DeliveryFile> {
  try {
    const value = JSON.parse(await readFile(deliveryPath(), "utf8")) as unknown
    if (
      !value ||
      typeof value !== "object" ||
      (value as { type?: unknown }).type !== "worktable.thread-deliveries" ||
      ![1, 2, 3, 4].includes(
        (value as { version?: unknown }).version as number
      ) ||
      !Array.isArray((value as { deliveries?: unknown }).deliveries)
    ) {
      throw new Error("Invalid thread delivery file")
    }
    const stored = value as {
      version: 1 | 2 | 3 | 4
      canonicalRevisions?: Record<string, number>
      deliveries: Array<
        | DeliveryRecord
        | (Omit<DeliveryRecord, "location"> & {
            spaceId: string
          })
      >
    }
    return {
      type: "worktable.thread-deliveries",
      version: 4,
      canonicalRevisions: stored.canonicalRevisions ?? {},
      deliveries: stored.deliveries.map((delivery) =>
        "location" in delivery
          ? {
              ...delivery,
              identityId:
                delivery.identityId ??
                `idt_${delivery.participantId.replace(/^ptc_/, "")}`,
            }
          : {
              ...delivery,
              location: { kind: "space", spaceId: delivery.spaceId },
              spaceId: undefined,
              identityId:
                delivery.identityId ??
                `idt_${delivery.participantId.replace(/^ptc_/, "")}`,
            }
      ),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile()
    throw error
  }
}

async function saveFile(file: DeliveryFile): Promise<void> {
  const path = deliveryPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8")
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

function notify(record: DeliveryRecord): void {
  notifyWorkspaceChange({
    type: "threadActivity",
    location: record.location,
    ...(record.location.kind === "space"
      ? { spaceId: record.location.spaceId }
      : {}),
    threadId: record.threadId,
    messageId: record.messageId,
    participantId: record.participantId,
    identityId: record.identityId,
  })
}

function publicState(record: DeliveryRecord): ThreadActivity["state"] {
  switch (record.state) {
    case "queued":
    case "leased":
      return "queued"
    case "accepted":
    case "working":
      return "working"
    case "receiving":
      return "receiving"
    case "replied":
      return "replied"
    case "failed":
      return "failed"
  }
}

function activityFor(record: DeliveryRecord): ThreadActivity {
  return {
    messageId: record.messageId,
    participantId: record.participantId,
    identityId: record.identityId,
    state: publicState(record),
    revision: record.revision,
    attempts: record.attempts,
    receivedCharacters: record.receivedCharacters,
    updatedAt: record.updatedAt,
    error: record.error,
  }
}

function deliveryKey(
  location: ThreadLocation,
  threadId: string,
  messageId: string,
  identityId: string
): string {
  return `${threadLocationKey(location)}\0${threadId}\0${messageId}\0${identityId}`
}

function canonicalThreadKey(
  participantId: string,
  location: ThreadLocation,
  threadId: string
): string {
  return `${participantId}\0${threadLocationKey(location)}\0${threadId}`
}

function requireLease(
  file: DeliveryFile,
  messageId: string,
  leaseId: string,
  participantId: string
): DeliveryRecord {
  const record = file.deliveries.find(
    (delivery) =>
      delivery.messageId === messageId &&
      delivery.leaseId === leaseId &&
      delivery.participantId === participantId
  )
  if (
    !record ||
    !record.leaseExpiresAt ||
    Date.parse(record.leaseExpiresAt) <= Date.now()
  ) {
    throw new ThreadDeliveryError(
      "LEASE_LOST",
      `Delivery lease is no longer valid for message ${messageId}`
    )
  }
  return record
}

export async function requireThreadDeliveryLease(input: {
  messageId: string
  threadId: string
  location: ThreadLocation
  identityId: string
  participantId: string
  leaseId: string
}): Promise<void> {
  await serialized(async () => {
    const file = await loadFile()
    const record = requireLease(
      file,
      input.messageId,
      input.leaseId,
      input.participantId
    )
    if (
      record.threadId !== input.threadId ||
      threadLocationKey(record.location) !==
        threadLocationKey(input.location) ||
      record.identityId !== input.identityId
    ) {
      throw new ThreadDeliveryError(
        "LEASE_LOST",
        `Delivery lease does not authorize ${input.identityId} in thread ${input.threadId}`
      )
    }
  })
}

function renewLease(record: DeliveryRecord, nowMs: number): void {
  record.leaseExpiresAt = new Date(nowMs + LEASE_MS).toISOString()
}

export async function queueThreadDelivery(input: {
  messageId: string
  threadId: string
  location?: ThreadLocation
  /** @deprecated Use location instead. */
  spaceId?: string
  authorId: string
  participantId: string
  identityId?: string
  threadRevision: number
}): Promise<ThreadActivity | undefined> {
  return serialized(async () => {
    const file = await loadFile()
    const location = deliveryInputLocation(input)
    const canonicalKey = canonicalThreadKey(
      input.participantId,
      location,
      input.threadId
    )
    const canonicalRevision = file.canonicalRevisions[canonicalKey] ?? 0
    if (input.threadRevision < canonicalRevision) return undefined
    file.canonicalRevisions[canonicalKey] = Math.max(
      canonicalRevision,
      input.threadRevision
    )
    const identityId =
      input.identityId ?? `idt_${input.participantId.replace(/^ptc_/, "")}`
    const existing = file.deliveries.find(
      (delivery) =>
        threadLocationKey(delivery.location) === threadLocationKey(location) &&
        delivery.threadId === input.threadId &&
        delivery.messageId === input.messageId &&
        delivery.identityId === identityId
    )
    if (existing) {
      await saveFile(file)
      return activityFor(existing)
    }
    const now = new Date().toISOString()
    const record: DeliveryRecord = {
      messageId: input.messageId,
      threadId: input.threadId,
      location,
      authorId: input.authorId,
      participantId: input.participantId,
      identityId,
      state: "queued",
      revision: 0,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }
    file.deliveries.push(record)
    await saveFile(file)
    notify(record)
    return activityFor(record)
  })
}

export interface ReconcileThreadDeliveryInput {
  messageId: string
  threadId: string
  location?: ThreadLocation
  /** @deprecated Use location instead. */
  spaceId?: string
  authorId: string
  participantId: string
  identityId?: string
  replied: boolean
  createdAt: string
  repliedAt?: string
  threadRevision: number
}

export interface ReconcileThreadSnapshot {
  threadId: string
  location: ThreadLocation
  revision: number
}

export async function reconcileThreadDeliveries(
  participantId: string,
  inputs: ReconcileThreadDeliveryInput[],
  options: {
    retireMissing?: boolean
    threads?: ReconcileThreadSnapshot[]
  } = {}
): Promise<void> {
  await serialized(async () => {
    const retireMissing = options.retireMissing !== false
    const file = await loadFile()
    const changed: DeliveryRecord[] = []
    let metadataChanged = false
    const previousCanonicalRevisions = { ...file.canonicalRevisions }
    const snapshots = new Map(
      (options.threads ?? []).map((thread) => [
        `${threadLocationKey(thread.location)}\0${thread.threadId}`,
        thread,
      ])
    )
    for (const snapshot of snapshots.values()) {
      const key = canonicalThreadKey(
        participantId,
        snapshot.location,
        snapshot.threadId
      )
      const previous = file.canonicalRevisions[key] ?? 0
      if (snapshot.revision > previous) {
        file.canonicalRevisions[key] = snapshot.revision
        metadataChanged = true
      }
    }
    const canonicalDeliveries = new Set(
      inputs.map((input) =>
        deliveryKey(
          deliveryInputLocation(input),
          input.threadId,
          input.messageId,
          input.identityId ?? `idt_${input.participantId.replace(/^ptc_/, "")}`
        )
      )
    )
    const removedTerminal: DeliveryRecord[] = []
    if (retireMissing) {
      file.deliveries = file.deliveries.filter((record) => {
        const snapshot = snapshots.get(
          `${threadLocationKey(record.location)}\0${record.threadId}`
        )
        const canonicalKey = canonicalThreadKey(
          participantId,
          record.location,
          record.threadId
        )
        const highWatermark = file.canonicalRevisions[canonicalKey] ?? 0
        const snapshotRevision = snapshot?.revision ?? Number.MAX_SAFE_INTEGER
        if (snapshotRevision < highWatermark) return true
        if (
          record.participantId !== participantId ||
          (record.state !== "replied" && record.state !== "failed") ||
          canonicalDeliveries.has(
            deliveryKey(
              record.location,
              record.threadId,
              record.messageId,
              record.identityId
            )
          )
        ) {
          return true
        }
        file.canonicalRevisions[canonicalKey] = snapshotRevision
        metadataChanged = true
        removedTerminal.push(record)
        return false
      })
    }
    const byDelivery = new Map(
      file.deliveries.map((delivery) => [
        deliveryKey(
          delivery.location,
          delivery.threadId,
          delivery.messageId,
          delivery.identityId
        ),
        delivery,
      ])
    )
    for (const record of file.deliveries) {
      const snapshot = snapshots.get(
        `${threadLocationKey(record.location)}\0${record.threadId}`
      )
      const canonicalKey = canonicalThreadKey(
        participantId,
        record.location,
        record.threadId
      )
      const highWatermark = file.canonicalRevisions[canonicalKey] ?? 0
      const snapshotRevision = snapshot?.revision ?? Number.MAX_SAFE_INTEGER
      if (
        !retireMissing ||
        record.participantId !== participantId ||
        snapshotRevision < highWatermark ||
        record.state === "replied" ||
        record.state === "failed" ||
        canonicalDeliveries.has(
          deliveryKey(
            record.location,
            record.threadId,
            record.messageId,
            record.identityId
          )
        )
      ) {
        continue
      }
      file.canonicalRevisions[canonicalKey] = snapshotRevision
      metadataChanged = true
      record.state = "failed"
      record.leaseId = undefined
      record.leaseExpiresAt = undefined
      record.nextAttemptAt = undefined
      record.error = {
        code: "DELIVERY_RETIRED",
        message:
          "The portable thread no longer requests this participant's reply.",
        retryable: false,
      }
      record.revision += 1
      record.updatedAt = new Date().toISOString()
      changed.push(record)
    }
    for (const input of inputs) {
      const location = deliveryInputLocation(input)
      const canonicalKey = canonicalThreadKey(
        participantId,
        location,
        input.threadId
      )
      const highWatermark = file.canonicalRevisions[canonicalKey] ?? 0
      if (input.threadRevision < highWatermark) continue
      if (input.threadRevision > highWatermark) {
        file.canonicalRevisions[canonicalKey] = input.threadRevision
        metadataChanged = true
      }
      const key = deliveryKey(
        location,
        input.threadId,
        input.messageId,
        input.identityId ?? `idt_${input.participantId.replace(/^ptc_/, "")}`
      )
      const existing = byDelivery.get(key)
      if (existing) {
        if (existing.participantId !== input.participantId) {
          existing.authorId = input.authorId
          existing.participantId = input.participantId
          existing.state = input.replied ? "replied" : "queued"
          existing.attempts = 0
          existing.leaseId = undefined
          existing.leaseExpiresAt = undefined
          existing.nextAttemptAt = undefined
          existing.receivedCharacters = undefined
          existing.error = undefined
          existing.createdAt = input.createdAt
          existing.updatedAt = input.repliedAt ?? new Date().toISOString()
          existing.revision += 1
          changed.push(existing)
          continue
        }
        if (input.replied) {
          if (existing.state === "replied") continue
          existing.state = "replied"
          existing.leaseId = undefined
          existing.leaseExpiresAt = undefined
          existing.nextAttemptAt = undefined
          existing.error = undefined
          existing.revision += 1
          existing.updatedAt = input.repliedAt ?? new Date().toISOString()
          changed.push(existing)
        } else if (
          existing.state === "failed" &&
          existing.error?.code === "DELIVERY_RETIRED" &&
          input.threadRevision > (previousCanonicalRevisions[canonicalKey] ?? 0)
        ) {
          existing.state = "queued"
          existing.attempts = 0
          existing.leaseId = undefined
          existing.leaseExpiresAt = undefined
          existing.nextAttemptAt = undefined
          existing.receivedCharacters = undefined
          existing.error = undefined
          existing.revision += 1
          existing.updatedAt = new Date().toISOString()
          changed.push(existing)
        }
        continue
      }

      const record: DeliveryRecord = {
        messageId: input.messageId,
        threadId: input.threadId,
        location,
        authorId: input.authorId,
        participantId: input.participantId,
        identityId:
          input.identityId ?? `idt_${input.participantId.replace(/^ptc_/, "")}`,
        state: input.replied ? "replied" : "queued",
        revision: 0,
        attempts: 0,
        createdAt: input.createdAt,
        updatedAt: input.repliedAt ?? input.createdAt,
      }
      file.deliveries.push(record)
      byDelivery.set(key, record)
      changed.push(record)
    }
    if (
      changed.length === 0 &&
      removedTerminal.length === 0 &&
      !metadataChanged
    ) {
      return
    }
    await saveFile(file)
    for (const record of changed) notify(record)
    for (const record of removedTerminal) notify(record)
  })
}

export async function getThreadActivity(
  locationInput: ThreadLocation | string,
  threadId: string,
  messageId: string,
  identityId?: string
): Promise<ThreadActivity | undefined> {
  const location = normalizeDeliveryLocation(locationInput)
  const records = (await loadFile()).deliveries.filter(
    (delivery) =>
      threadLocationKey(delivery.location) === threadLocationKey(location) &&
      delivery.threadId === threadId &&
      delivery.messageId === messageId &&
      (!identityId || delivery.identityId === identityId)
  )
  const record = records.sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )[0]
  return record ? activityFor(record) : undefined
}

export async function latestThreadActivity(
  location: ThreadLocation | string,
  threadId: string
): Promise<ThreadActivity | undefined> {
  const records = await getThreadActivities(location, threadId)
  return records.at(-1)
}

export async function getThreadActivities(
  locationInput: ThreadLocation | string,
  threadId: string
): Promise<ThreadActivity[]> {
  const location = normalizeDeliveryLocation(locationInput)
  return (await loadFile()).deliveries
    .filter(
      (delivery) =>
        threadLocationKey(delivery.location) === threadLocationKey(location) &&
        delivery.threadId === threadId
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(activityFor)
}

export async function nextThreadDeliveryEligibleAt(
  participantId: string,
  options: { allowWorktable?: boolean } = {
    allowWorktable: true,
  }
): Promise<number | undefined> {
  const now = Date.now()
  let next: number | undefined
  const blockedThreads = new Set<string>()
  for (const record of (await loadFile()).deliveries) {
    if (
      record.participantId !== participantId ||
      (!options.allowWorktable && record.location.kind === "worktable") ||
      record.state === "replied" ||
      record.state === "failed"
    ) {
      continue
    }
    const threadKey = `${threadLocationKey(record.location)}\0${record.threadId}\0${record.identityId}`
    if (blockedThreads.has(threadKey)) continue
    blockedThreads.add(threadKey)
    const boundary =
      record.nextAttemptAt && Date.parse(record.nextAttemptAt) > now
        ? Date.parse(record.nextAttemptAt)
        : record.state !== "queued" &&
            record.leaseExpiresAt &&
            Date.parse(record.leaseExpiresAt) > now
          ? Date.parse(record.leaseExpiresAt)
          : now
    next = next === undefined ? boundary : Math.min(next, boundary)
  }
  return next
}

export async function claimThreadDelivery(
  participantId: string,
  options: { allowWorktable?: boolean } = {
    allowWorktable: true,
  }
): Promise<ClaimedDelivery | null> {
  return serialized(async () => {
    const file = await loadFile()
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    const exhausted: DeliveryRecord[] = []
    const blockedThreads = new Set<string>()
    let candidate: DeliveryRecord | undefined
    for (const record of file.deliveries) {
      if (record.participantId !== participantId) continue
      if (!options.allowWorktable && record.location.kind === "worktable") {
        continue
      }
      if (record.state === "replied" || record.state === "failed") continue
      const threadKey = `${threadLocationKey(record.location)}\0${record.threadId}\0${record.identityId}`
      if (blockedThreads.has(threadKey)) continue
      if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > nowMs) {
        blockedThreads.add(threadKey)
        continue
      }
      if (
        record.state !== "queued" &&
        record.leaseExpiresAt &&
        Date.parse(record.leaseExpiresAt) > nowMs
      ) {
        blockedThreads.add(threadKey)
        continue
      }
      if (record.state !== "queued" && record.attempts >= MAX_ATTEMPTS) {
        record.state = "failed"
        record.leaseId = undefined
        record.leaseExpiresAt = undefined
        record.nextAttemptAt = undefined
        record.error = {
          code: "DELIVERY_FAILED",
          message: `Delivery lease expired after ${MAX_ATTEMPTS} attempts.`,
          retryable: false,
        }
        record.revision += 1
        record.updatedAt = now
        exhausted.push(record)
        continue
      }
      candidate = record
      break
    }
    if (!candidate && exhausted.length === 0) return null

    if (candidate) {
      candidate.state = "leased"
      candidate.leaseId = `lease_${randomBytes(18).toString("base64url")}`
      candidate.leaseExpiresAt = new Date(nowMs + LEASE_MS).toISOString()
      candidate.attempts += 1
      candidate.nextAttemptAt = undefined
      candidate.error = undefined
      candidate.receivedCharacters = undefined
      candidate.revision += 1
      candidate.updatedAt = now
    }
    await saveFile(file)
    for (const record of exhausted) notify(record)
    if (!candidate) return null
    notify(candidate)
    return {
      messageId: candidate.messageId,
      threadId: candidate.threadId,
      location: candidate.location,
      ...(candidate.location.kind === "space"
        ? { spaceId: candidate.location.spaceId }
        : {}),
      leaseId: candidate.leaseId!,
      leaseExpiresAt: candidate.leaseExpiresAt!,
      attempt: candidate.attempts,
      identityId: candidate.identityId,
    }
  })
}

export async function acceptThreadDelivery(input: {
  messageId: string
  leaseId: string
  participantId: string
}): Promise<ThreadActivity> {
  return serialized(async () => {
    const file = await loadFile()
    const record = requireLease(
      file,
      input.messageId,
      input.leaseId,
      input.participantId
    )
    const nowMs = Date.now()
    record.state = "accepted"
    record.revision += 1
    record.updatedAt = new Date(nowMs).toISOString()
    renewLease(record, nowMs)
    await saveFile(file)
    notify(record)
    return activityFor(record)
  })
}

export async function progressThreadDelivery(input: {
  messageId: string
  leaseId: string
  participantId: string
  phase: "working" | "receiving"
  receivedCharacters?: number
}): Promise<ThreadActivity> {
  return serialized(async () => {
    const file = await loadFile()
    const record = requireLease(
      file,
      input.messageId,
      input.leaseId,
      input.participantId
    )
    const nowMs = Date.now()
    const shouldNotify =
      record.state !== input.phase ||
      nowMs - Date.parse(record.updatedAt) >= PROGRESS_COALESCE_MS
    record.state = input.phase
    if (input.receivedCharacters !== undefined) {
      record.receivedCharacters = Math.max(
        record.receivedCharacters ?? 0,
        input.receivedCharacters
      )
    }
    renewLease(record, nowMs)
    if (shouldNotify) {
      record.revision += 1
      record.updatedAt = new Date(nowMs).toISOString()
    }
    await saveFile(file)
    if (shouldNotify) notify(record)
    return activityFor(record)
  })
}

export async function failThreadDelivery(input: {
  messageId: string
  leaseId: string
  participantId: string
  canonicalThreadRevision?: number
  retryable: boolean
  code: string
  message: string
}): Promise<ThreadActivity> {
  return serialized(async () => {
    const file = await loadFile()
    const record = requireLease(
      file,
      input.messageId,
      input.leaseId,
      input.participantId
    )
    if (input.canonicalThreadRevision !== undefined) {
      const canonicalKey = canonicalThreadKey(
        record.participantId,
        record.location,
        record.threadId
      )
      file.canonicalRevisions[canonicalKey] = Math.max(
        file.canonicalRevisions[canonicalKey] ?? 0,
        input.canonicalThreadRevision
      )
    }
    const nowMs = Date.now()
    const retry = input.retryable && record.attempts < MAX_ATTEMPTS
    record.state = retry ? "queued" : "failed"
    record.error = {
      code: input.code,
      message: input.message.slice(0, 500),
      retryable: retry,
    }
    record.leaseId = undefined
    record.leaseExpiresAt = undefined
    record.nextAttemptAt = retry
      ? new Date(
          nowMs + 1_000 * 2 ** Math.max(0, record.attempts - 1)
        ).toISOString()
      : undefined
    record.revision += 1
    record.updatedAt = new Date(nowMs).toISOString()
    await saveFile(file)
    notify(record)
    return activityFor(record)
  })
}

export async function markThreadDeliveryReplied(input: {
  messageId: string
  threadId: string
  location?: ThreadLocation
  /** @deprecated Use location instead. */
  spaceId?: string
  participantId: string
  identityId?: string
}): Promise<ThreadActivity | undefined> {
  return serialized(async () => {
    const file = await loadFile()
    const location = deliveryInputLocation(input)
    const record = file.deliveries.find(
      (delivery) =>
        delivery.messageId === input.messageId &&
        delivery.threadId === input.threadId &&
        threadLocationKey(delivery.location) === threadLocationKey(location) &&
        (!input.identityId || delivery.identityId === input.identityId)
    )
    if (!record) return undefined
    if (record.participantId !== input.participantId) return undefined
    if (record.state === "replied") return activityFor(record)
    record.state = "replied"
    record.leaseId = undefined
    record.leaseExpiresAt = undefined
    record.nextAttemptAt = undefined
    record.error = undefined
    record.revision += 1
    record.updatedAt = new Date().toISOString()
    await saveFile(file)
    notify(record)
    return activityFor(record)
  })
}

onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") {
    return serialized(() => saveFile(emptyFile()))
  }
})
