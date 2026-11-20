import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ThreadActivity, ThreadLocation } from "@worktable/types"
import { threadLocationKey } from "@worktable/types"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { readFileFingerprint } from "./file-fingerprint.ts"
import { notifyWorkspaceChange, onWorkspaceChange } from "./workspace-events.ts"
import { workspaceCacheKey } from "./workspace.ts"
import { grokBotPolicy } from "./grok-bot-store.ts"

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
  /** Persisted fencing survives disconnects, restarts, and routine edits. */
  managedBy?: "grok-bot"
  /**
   * A comment sent to this agent, delivered like a thread message. threadId
   * is the comment's id and messageId the request's. Comments on one page
   * are handed out together, under one lease.
   */
  comment?: CommentDeliveryRef
  /** The lease whose reply answered this comment, so a retry finds it done. */
  repliedUnder?: string
  /**
   * The page batch this comment went out in. A retry keeps it and its
   * comments, so a runtime can tell the turn it already answered.
   */
  batchId?: string
  /** The comment's pending-list revision, so an older snapshot can't retire it. */
  pendingRevision?: number
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
  /** Agents whose runtime has asked for comments; only these get them. */
  commentParticipants?: string[]
}

/** A comment request delivered to an agent, and the page it is on. */
export interface CommentDeliveryRef {
  spaceId: string
  annotationId: string
  requestId: string
  /** The page: its durable id, or its path when it has none. */
  page: string
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
  /** Comments on one page, leased together, instead of a thread message. */
  comments?: CommentDeliveryRef[]
  /** The comments' batch, the same on every retry of it. */
  batchId?: string
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
      commentParticipants?: string[]
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
      commentParticipants: stored.commentParticipants ?? [],
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

interface DeliveryReadState {
  path: string
  /** The file's fingerprint when it was read; null when it did not exist. */
  key: string | null
  racy: boolean
  deliveries: readonly DeliveryRecord[]
  commentParticipants: ReadonlySet<string>
  lookup: ThreadActivityLookup
}

let readState: DeliveryReadState | undefined
/**
 * The agents whose runtimes asked for comments, as this process last read
 * or wrote them. Only this process writes the file, so asking it costs no
 * read on the request path.
 */
let commentTakers: ReadonlySet<string> | undefined

/** WORKTABLE_MODEL=0 turns off reuse of state derived from the file. */
function readStateTrusted(): boolean {
  return process.env["WORKTABLE_MODEL"] !== "0"
}

/**
 * The delivery state for reads, parsed again only when the file's
 * fingerprint changes. Callers must not modify it; writers load their own
 * copy under the lock.
 */
async function readDeliveryState(): Promise<DeliveryReadState> {
  const path = deliveryPath()
  // Stat before reading: a write that lands in between leaves an older
  // fingerprint, so the next read parses the file again.
  const fingerprint = await readFileFingerprint(path)
  const key = fingerprint?.key ?? null
  if (
    readState &&
    readState.path === path &&
    readState.key === key &&
    !readState.racy &&
    readStateTrusted()
  ) {
    return readState
  }
  const { deliveries, commentParticipants } = await loadFile()
  commentTakers = new Set(commentParticipants)
  readState = {
    path,
    key,
    racy: fingerprint?.racy ?? false,
    deliveries,
    commentParticipants: new Set(commentParticipants),
    lookup: activityLookup(deliveries),
  }
  return readState
}

async function saveFile(file: DeliveryFile): Promise<void> {
  const path = deliveryPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8")
  await chmod(tmp, 0o600)
  await rename(tmp, path)
  commentTakers = new Set(file.commentParticipants ?? [])
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
  // A page of comments shares one lease: once the agent has answered the
  // comment the lease was reported against, another one still holds it.
  const record =
    file.deliveries.find(
      (delivery) =>
        delivery.messageId === messageId &&
        delivery.leaseId === leaseId &&
        delivery.participantId === participantId
    ) ??
    file.deliveries.find(
      (delivery) =>
        delivery.comment !== undefined &&
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

interface DeliveryReplyLease {
  messageId: string
  threadId: string
  location: ThreadLocation
  identityId: string
  participantId: string
  leaseId: string
}

function replyLease(
  file: DeliveryFile,
  input: DeliveryReplyLease
): DeliveryRecord {
  const record = requireLease(
    file,
    input.messageId,
    input.leaseId,
    input.participantId
  )
  if (
    record.threadId !== input.threadId ||
    threadLocationKey(record.location) !== threadLocationKey(input.location) ||
    record.identityId !== input.identityId
  ) {
    throw new ThreadDeliveryError(
      "LEASE_LOST",
      `Delivery lease does not authorize ${input.identityId} in thread ${input.threadId}`
    )
  }
  if (record.managedBy === "grok-bot" && record.state === "leased") {
    throw new ThreadDeliveryError(
      "LEASE_LOST",
      "Accept the Grok Bot delivery before posting its reply"
    )
  }
  return record
}

export async function requireThreadDeliveryLease(
  input: DeliveryReplyLease
): Promise<void> {
  await serialized(async () => {
    replyLease(await loadFile(), input)
  })
}

/** Linearize a managed reply with expiry/retry, including the canonical append. */
export async function commitThreadDeliveryReply<T>(
  input: DeliveryReplyLease,
  append: () => Promise<T>,
  replay?: () => Promise<T | null>
): Promise<T> {
  return serialized(async () => {
    const file = await loadFile()
    let record: DeliveryRecord
    try {
      record = replyLease(file, input)
    } catch (error) {
      if (
        error instanceof ThreadDeliveryError &&
        error.code === "LEASE_LOST" &&
        replay
      ) {
        const committed = await replay()
        if (committed) return committed
      }
      throw error
    }
    const result = await append()
    record.state = "replied"
    record.leaseId = undefined
    record.leaseExpiresAt = undefined
    record.nextAttemptAt = undefined
    record.error = undefined
    record.revision += 1
    record.updatedAt = new Date().toISOString()
    await saveFile(file)
    notify(record)
    return result
  })
}

function renewLease(record: DeliveryRecord, nowMs: number): void {
  // Native routines cannot reliably heartbeat. Their claim has one absolute deadline.
  if (record.managedBy === "grok-bot") return
  record.leaseExpiresAt = new Date(nowMs + LEASE_MS).toISOString()
}

export async function requiresManagedDeliveryLease(input: {
  participantId: string
  messageId: string
  threadId: string
  location: ThreadLocation
}): Promise<boolean> {
  if (await grokBotPolicy(input.participantId)) return true
  return (await readDeliveryState()).deliveries.some(
    (record) =>
      record.managedBy === "grok-bot" &&
      record.participantId === input.participantId &&
      record.messageId === input.messageId &&
      record.threadId === input.threadId &&
      threadLocationKey(record.location) === threadLocationKey(input.location)
  )
}

function active(record: DeliveryRecord): boolean {
  return (
    record.state !== "queued" &&
    record.state !== "replied" &&
    record.state !== "failed"
  )
}
function expireManaged(
  file: DeliveryFile,
  participantId: string,
  now: number,
  includeLegacy = false
): DeliveryRecord[] {
  const expired = file.deliveries.filter(
    (record) =>
      record.participantId === participantId &&
      (record.managedBy === "grok-bot" || includeLegacy) &&
      active(record) &&
      (!record.leaseExpiresAt || Date.parse(record.leaseExpiresAt) <= now)
  )
  for (const record of expired) {
    record.managedBy = "grok-bot"
    record.state = "failed"
    record.leaseId = undefined
    record.leaseExpiresAt = undefined
    record.nextAttemptAt = undefined
    record.error = {
      code: "REMOTE_EXECUTION_UNCONFIRMED",
      retryable: false,
      message:
        "Grok Bot's execution deadline passed. Check its run before retrying; external work may have completed.",
    }
    record.revision += 1
    record.updatedAt = new Date(now).toISOString()
  }
  return expired
}

/** A background deadline pass, driven by the nearest actual deadline, never polling. */
export async function expireGrokBotDeliveries(
  participantId: string,
  now = Date.now()
): Promise<void> {
  await serialized(async () => {
    const file = await loadFile()
    const expired = expireManaged(file, participantId, now, Boolean(await grokBotPolicy(participantId)))
    if (!expired.length) return
    await saveFile(file)
    for (const record of expired) notify(record)
  })
}

export async function grokBotDeliveries(participantId: string) {
  return (await readDeliveryState()).deliveries
    .filter((record) => record.participantId === participantId)
    .map((record) => ({
      location: record.location,
      threadId: record.threadId,
      messageId: record.messageId,
      identityId: record.identityId,
      state: record.state,
      leaseExpiresAt: record.leaseExpiresAt,
      nextAttemptAt: record.nextAttemptAt,
      error: record.error,
      comment: record.comment !== undefined,
    }))
}

/**
 * A comment delivery still waiting on its agent. One whose run was never
 * confirmed counts too: it holds the agent's other work until it is retried
 * or its comment stops waiting.
 */
function commentWaiting(record: DeliveryRecord): boolean {
  return (
    (record.state !== "replied" && record.state !== "failed") ||
    record.error?.code === "REMOTE_EXECUTION_UNCONFIRMED"
  )
}

/** No canonical assignment remains to retry. */
export function isRetiredThreadDelivery(record: { error?: { code: string } }): boolean {
  return record.error?.code === "DELIVERY_RETIRED" || record.error?.code === "THREAD_NOT_FOUND"
}

/** An explicit owner action starts a new attempt; old leases can never authorize it. */
export async function retryGrokBotDelivery(input: {
  participantId: string
  messageId: string
  threadId: string
  location: ThreadLocation
  identityId: string
}): Promise<void> {
  await serialized(async () => {
    const file = await loadFile()
    const record = file.deliveries.find(
      (record) =>
        record.participantId === input.participantId &&
        record.messageId === input.messageId &&
        record.threadId === input.threadId &&
        record.identityId === input.identityId &&
        threadLocationKey(record.location) === threadLocationKey(input.location)
    )
    if (
      !record ||
      record.state !== "failed" ||
      record.error?.code === "DELIVERY_RETIRED"
    ) {
      throw new ThreadDeliveryError(
        "DELIVERY_FAILED",
        "Only a current failed assignment can be retried"
      )
    }
    // A page of comments goes again whole: the batch failed together.
    const members = record.batchId
      ? file.deliveries.filter(
          (member) =>
            member.participantId === record.participantId &&
            member.batchId === record.batchId &&
            member.state === "failed" &&
            !isRetiredThreadDelivery(member)
        )
      : [record]
    const now = new Date().toISOString()
    for (const member of members) {
      member.state = "queued"
      member.leaseId = undefined
      member.leaseExpiresAt = undefined
      member.nextAttemptAt = undefined
      member.error = undefined
      member.attempts = 0
      member.revision += 1
      member.updatedAt = now
    }
    await saveFile(file)
    for (const member of members) notify(member)
  })
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

/** A thread's activities, oldest first, from one read of the delivery state. */
export type ThreadActivityLookup = (
  location: ThreadLocation,
  threadId: string
) => ThreadActivity[]

function activityLookup(
  deliveries: readonly DeliveryRecord[]
): ThreadActivityLookup {
  const byThread = new Map<string, ThreadActivity[]>()
  const sorted = [...deliveries].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  )
  for (const delivery of sorted) {
    const key = `${threadLocationKey(delivery.location)}\0${delivery.threadId}`
    const activities = byThread.get(key)
    if (activities) activities.push(activityFor(delivery))
    else byThread.set(key, [activityFor(delivery)])
  }
  return (location, threadId) =>
    byThread.get(`${threadLocationKey(location)}\0${threadId}`) ?? []
}

/** Every thread's activities from a single read of the delivery state. */
export async function readThreadActivities(): Promise<ThreadActivityLookup> {
  return (await readDeliveryState()).lookup
}

// Per participant: the thread file versions and the delivery file that its
// last reconciliation left consistent.
const reconciled = new Map<string, string>()

function reconciledMark(
  sourceStamp: string,
  path: string,
  key: string | null
): string {
  return `${sourceStamp}\0${path}\0${key ?? ""}`
}

/** Remember the delivery file this reconciliation left, while still locked. */
async function noteReconciled(
  participantId: string,
  sourceStamp: string | undefined
): Promise<void> {
  if (sourceStamp === undefined) return
  const path = deliveryPath()
  // Only a shortcut: a file that cannot be checked is reconciled next time.
  const fingerprint = await readFileFingerprint(path).catch(() => undefined)
  if (fingerprint === undefined || fingerprint?.racy) {
    reconciled.delete(participantId)
  } else {
    reconciled.set(
      participantId,
      reconciledMark(sourceStamp, path, fingerprint?.key ?? null)
    )
  }
}

/**
 * Bring one participant's deliveries in line with the canonical threads.
 * Returns every thread's activities as of the reconciled state.
 *
 * `sourceStamp` names the thread file versions the inputs came from. When
 * neither they nor the delivery file changed since this participant's last
 * reconciliation there is nothing to do, and the cached state is returned
 * without taking the cross-process lock.
 */
export async function reconcileThreadDeliveries(
  participantId: string,
  inputs: ReconcileThreadDeliveryInput[],
  options: {
    retireMissing?: boolean
    threads?: ReconcileThreadSnapshot[]
    sourceStamp?: string
    /**
     * Locations the inputs were scanned from. A record elsewhere was not
     * observed, so it is neither retired nor fenced: on a team the caller may
     * simply be unable to see that Space.
     */
    scannedLocations?: ThreadLocation[]
  } = {}
): Promise<ThreadActivityLookup> {
  if (options.sourceStamp !== undefined && readStateTrusted()) {
    const state = await readDeliveryState()
    if (
      !state.racy &&
      reconciled.get(participantId) ===
        reconciledMark(options.sourceStamp, state.path, state.key)
    ) {
      return state.lookup
    }
  }
  return serialized(async () => {
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
    const scannedKeys = options.scannedLocations
      ? new Set(options.scannedLocations.map(threadLocationKey))
      : null
    // Comment records follow the pending list instead.
    const observed = (location: ThreadLocation, record?: DeliveryRecord) =>
      !record?.comment &&
      (!scannedKeys || scannedKeys.has(threadLocationKey(location)))
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
        if (!observed(record.location, record)) return true
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
        !observed(record.location, record) ||
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
          isRetiredThreadDelivery(existing) &&
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
      await noteReconciled(participantId, options.sourceStamp)
      return activityLookup(file.deliveries)
    }
    await saveFile(file)
    await noteReconciled(participantId, options.sourceStamp)
    for (const record of changed) notify(record)
    for (const record of removedTerminal) notify(record)
    return activityLookup(file.deliveries)
  })
}

export async function getThreadActivity(
  locationInput: ThreadLocation | string,
  threadId: string,
  messageId: string,
  identityId?: string
): Promise<ThreadActivity | undefined> {
  const location = normalizeDeliveryLocation(locationInput)
  const records = (await readDeliveryState()).deliveries.filter(
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
  return [...(await readDeliveryState()).lookup(location, threadId)]
}

/**
 * A page whose comments are being worked on holds its new ones, so they come
 * out together once that batch ends instead of as turns of their own in the
 * same conversation. Maps each busy page to when its lease runs out.
 */
function busyCommentPages(
  deliveries: readonly DeliveryRecord[],
  participantId: string,
  nowMs: number
): Map<string, number> {
  const pages = new Map<string, number>()
  for (const record of deliveries) {
    if (
      record.participantId !== participantId ||
      !record.comment ||
      record.state === "queued" ||
      !active(record) ||
      !record.leaseExpiresAt
    )
      continue
    const expires = Date.parse(record.leaseExpiresAt)
    if (expires <= nowMs) continue
    const key = commentPageKey(record.comment)
    pages.set(key, Math.max(pages.get(key) ?? 0, expires))
  }
  return pages
}

function commentPageKey(comment: CommentDeliveryRef): string {
  return `${comment.spaceId}\0${comment.page}`
}

export async function nextThreadDeliveryEligibleAt(
  participantId: string,
  options: {
    allowWorktable?: boolean
    /** Deliveries the caller cannot currently act on wait, unexpired. */
    isDeliverable?: (location: ThreadLocation) => boolean
    allowComments?: boolean
  } = {
    allowWorktable: true,
  }
): Promise<number | undefined> {
  const now = Date.now()
  const policy = await grokBotPolicy(participantId)
  if (policy) {
    if (!policy.enabled || policy.error) return undefined
    const records = (await readDeliveryState()).deliveries.filter((r) => r.participantId === participantId)
    if (records.some((r) => r.error?.code === "REMOTE_EXECUTION_UNCONFIRMED")) return undefined
    const running = records.find(active)
    if (running) return running.leaseExpiresAt ? Date.parse(running.leaseExpiresAt) : now
  }
  let next: number | undefined
  const blockedThreads = new Set<string>()
  const { deliveries } = await readDeliveryState()
  const busyPages = options.allowComments
    ? busyCommentPages(deliveries, participantId, now)
    : new Map<string, number>()
  for (const record of deliveries) {
    if (
      record.participantId !== participantId ||
      (record.managedBy === "grok-bot" && !policy) ||
      (record.comment && !options.allowComments) ||
      (policy && !policy.verifiedAt && policy.probe?.messageId !== record.messageId) ||
      (!options.allowWorktable && record.location.kind === "worktable") ||
      (options.isDeliverable && !options.isDeliverable(record.location)) ||
      record.state === "replied" ||
      record.state === "failed"
    ) {
      continue
    }
    const threadKey = `${threadLocationKey(record.location)}\0${record.threadId}\0${record.identityId}`
    if (blockedThreads.has(threadKey)) continue
    blockedThreads.add(threadKey)
    const heldUntil = record.comment
      ? busyPages.get(commentPageKey(record.comment))
      : undefined
    const boundary =
      heldUntil !== undefined && record.state === "queued"
        ? heldUntil
        : record.nextAttemptAt && Date.parse(record.nextAttemptAt) > now
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
  options: {
    allowWorktable?: boolean
    isDeliverable?: (location: ThreadLocation) => boolean
    authenticatedPrincipalId?: string
    /** The runtime takes comments as well as thread messages. */
    allowComments?: boolean
  } = {
    allowWorktable: true,
  }
): Promise<ClaimedDelivery | null> {
  return serialized(async () => {
    const file = await loadFile()
    const policy = await grokBotPolicy(participantId)
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    const exhausted: DeliveryRecord[] = []
    const blockedThreads = new Set<string>()
    let candidate: DeliveryRecord | undefined
    // From now on this agent can be woken for comments too.
    let learned = false
    if (
      options.allowComments &&
      !(file.commentParticipants ??= []).includes(participantId)
    ) {
      file.commentParticipants.push(participantId)
      learned = true
    }
    if (policy) {
      const expired = expireManaged(file, participantId, nowMs, true)
      if (expired.length) {
        await saveFile(file)
        for (const record of expired) notify(record)
      }
      if ((options.authenticatedPrincipalId && options.authenticatedPrincipalId !== policy.principalId) || !policy.enabled || policy.error || file.deliveries.some((r) => r.participantId === participantId &&
        (active(r) || r.error?.code === "REMOTE_EXECUTION_UNCONFIRMED"))) {
        if (learned) await saveFile(file)
        return null
      }
    }
    const busyPages = busyCommentPages(file.deliveries, participantId, nowMs)
    for (const record of file.deliveries) {
      if (record.participantId !== participantId) continue
      if (record.managedBy === "grok-bot" && !policy) continue
      if (record.comment && !options.allowComments) continue
      if (
        record.comment &&
        busyPages.has(commentPageKey(record.comment))
      )
        continue
      if (policy && !policy.verifiedAt && policy.probe?.messageId !== record.messageId) continue
      if (!options.allowWorktable && record.location.kind === "worktable") {
        continue
      }
      if (options.isDeliverable && !options.isDeliverable(record.location)) {
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
        // A lease still "leased" was handed out and never accepted; any later
        // state means the agent took the message and then went quiet. People
        // see this beside the attempt count, so it names neither.
        const taken = record.state !== "leased"
        record.state = "failed"
        record.leaseId = undefined
        record.leaseExpiresAt = undefined
        record.nextAttemptAt = undefined
        record.error = {
          code: "DELIVERY_FAILED",
          message: taken
            ? "The agent took this message and then stopped reporting"
            : "The agent never confirmed it got this message",
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
    if (!candidate && exhausted.length === 0) {
      if (learned) await saveFile(file)
      return null
    }

    // A batch whose lease ran out goes out again as itself; comments that
    // came since wait for a batch of their own.
    const retrying =
      candidate?.comment && candidate.state !== "queued"
        ? candidate.batchId
        : undefined
    if (candidate) {
      candidate.state = "leased"
      candidate.leaseId = `lease_${randomBytes(18).toString("base64url")}`
      candidate.leaseExpiresAt = new Date(nowMs + LEASE_MS).toISOString()
      if (policy) {
        candidate.managedBy = "grok-bot"
        candidate.leaseExpiresAt = new Date(nowMs + policy.executionMinutes * 60_000).toISOString()
      }
      candidate.attempts += 1
      candidate.nextAttemptAt = undefined
      candidate.error = undefined
      candidate.receivedCharacters = undefined
      candidate.revision += 1
      candidate.updatedAt = now
    }
    // A comment brings every comment waiting for this agent on its page,
    // under the same lease, so one turn answers them all.
    const batch: DeliveryRecord[] = candidate ? [candidate] : []
    if (candidate?.comment) {
      candidate.batchId =
        retrying ?? `bat_${randomBytes(12).toString("base64url")}`
      for (const record of file.deliveries) {
        const waiting =
          record.state === "queued" &&
          !(record.nextAttemptAt && Date.parse(record.nextAttemptAt) > nowMs)
        const expired =
          record.state !== "queued" &&
          active(record) &&
          record.attempts < MAX_ATTEMPTS &&
          (!record.leaseExpiresAt || Date.parse(record.leaseExpiresAt) <= nowMs)
        // A retry takes the rest of its own batch; a new batch takes the
        // page's waiting comments, and any expired from before batches had ids.
        const joins = retrying
          ? expired && record.batchId === retrying
          : waiting || (expired && record.batchId === undefined)
        if (
          record === candidate ||
          record.participantId !== participantId ||
          record.comment?.page !== candidate.comment.page ||
          record.comment.spaceId !== candidate.comment.spaceId ||
          !joins
        )
          continue
        record.batchId = candidate.batchId
        record.state = "leased"
        record.leaseId = candidate.leaseId
        record.leaseExpiresAt = candidate.leaseExpiresAt
        if (candidate.managedBy) record.managedBy = candidate.managedBy
        record.attempts += 1
        record.nextAttemptAt = undefined
        record.error = undefined
        record.revision += 1
        record.updatedAt = now
        batch.push(record)
      }
    }
    await saveFile(file)
    for (const record of exhausted) notify(record)
    if (!candidate) return null
    for (const record of batch) notify(record)
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
      ...(candidate.comment
        ? {
            comments: batch.map((record) => record.comment!),
            batchId: candidate.batchId!,
          }
        : {}),
    }
  })
}

/** Every delivery a lease covers: one thread message, or a page of comments. */
function leaseGroup(file: DeliveryFile, record: DeliveryRecord): DeliveryRecord[] {
  return record.comment
    ? file.deliveries.filter(
        (candidate) =>
          candidate.participantId === record.participantId &&
          candidate.leaseId === record.leaseId &&
          candidate.comment !== undefined
      )
    : [record]
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
    const group = leaseGroup(file, record)
    for (const member of group) {
      member.state = "accepted"
      member.revision += 1
      member.updatedAt = new Date(nowMs).toISOString()
      renewLease(member, nowMs)
    }
    await saveFile(file)
    for (const member of group) notify(member)
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
    const group = leaseGroup(file, record)
    for (const member of group) {
      member.state = input.phase
      if (input.receivedCharacters !== undefined) {
        member.receivedCharacters = Math.max(
          member.receivedCharacters ?? 0,
          input.receivedCharacters
        )
      }
      renewLease(member, nowMs)
      if (shouldNotify) {
        member.revision += 1
        member.updatedAt = new Date(nowMs).toISOString()
      }
    }
    await saveFile(file)
    if (shouldNotify) for (const member of group) notify(member)
    return activityFor(record)
  })
}

export async function failThreadDelivery(input: {
  messageId: string
  leaseId: string
  participantId: string
  canonicalThreadRevision?: number
  retryable: boolean
  /**
   * False when the failure was not the delivery's: the claim's attempt is
   * returned and it queues again at once, for as long as it takes.
   */
  spendAttempt?: boolean
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
    const refund = input.retryable && input.spendAttempt === false
    const group = leaseGroup(file, record)
    for (const member of group) {
      if (refund) member.attempts = Math.max(0, member.attempts - 1)
      const retry =
        refund ||
        (member.managedBy !== "grok-bot" &&
          input.retryable &&
          member.attempts < MAX_ATTEMPTS)
      member.state = retry ? "queued" : "failed"
      member.error = {
        code: input.code,
        message: input.message.slice(0, 500),
        retryable: retry,
      }
      member.leaseId = undefined
      member.leaseExpiresAt = undefined
      member.nextAttemptAt = refund
        ? new Date(nowMs).toISOString()
        : retry
          ? new Date(
              nowMs + 1_000 * 2 ** Math.max(0, member.attempts - 1)
            ).toISOString()
          : undefined
      member.revision += 1
      member.updatedAt = new Date(nowMs).toISOString()
    }
    await saveFile(file)
    for (const member of group) notify(member)
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

// ── Comments sent to an agent ─────────────────────────────

export interface CommentDeliveryInput extends CommentDeliveryRef {
  authorId: string
  createdAt: string
  /** Its revision in the agent's pending list. */
  pendingRevision: number
}

/**
 * Make one agent's comment deliveries match the comments open for it. New
 * ones queue. One no longer open that is still waiting stops; its close
 * reason, when the pending list reports it, says whether it was answered.
 * Thread deliveries are left alone.
 */
export async function reconcileCommentDeliveries(
  participantId: string,
  inputs: readonly CommentDeliveryInput[],
  /**
   * The pending list's revision for this agent when `inputs` were read. A
   * comment the list saw later isn't in them, and stays.
   */
  seenRevision: number
): Promise<void> {
  const open = new Map(inputs.map((input) => [input.requestId, input]))
  const retires = (record: DeliveryRecord) =>
    !open.has(record.comment!.requestId) &&
    commentWaiting(record) &&
    (record.pendingRevision ?? 0) <= seenRevision
  // A page renamed under the same comment moves its delivery with it.
  const moved = (record: DeliveryRecord) => {
    const input = open.get(record.comment!.requestId)
    return input !== undefined && input.page !== record.comment!.page
  }
  const mine = (await readDeliveryState()).deliveries.filter(
    (record) => record.comment && record.participantId === participantId
  )
  const known = new Set(mine.map((record) => record.comment!.requestId))
  if (
    !mine.some((record) => retires(record) || moved(record)) &&
    inputs.every((input) => known.has(input.requestId))
  )
    return
  await serialized(async () => {
    const file = await loadFile()
    const changed: DeliveryRecord[] = []
    const now = new Date().toISOString()
    for (const record of file.deliveries) {
      if (!record.comment || record.participantId !== participantId) continue
      if (moved(record)) {
        record.comment = { ...record.comment, page: open.get(record.comment.requestId)!.page }
        record.revision += 1
        record.updatedAt = now
        changed.push(record)
        continue
      }
      if (!retires(record)) continue
      retireComment(record, now)
      changed.push(record)
    }
    const present = new Set(
      file.deliveries.flatMap((record) =>
        record.comment && record.participantId === participantId
          ? [record.comment.requestId]
          : []
      )
    )
    for (const input of inputs) {
      if (present.has(input.requestId)) continue
      const record: DeliveryRecord = {
        messageId: input.requestId,
        threadId: input.annotationId,
        location: { kind: "space", spaceId: input.spaceId },
        authorId: input.authorId,
        participantId,
        identityId: `idt_${participantId.replace(/^ptc_/, "")}`,
        state: "queued",
        revision: 0,
        attempts: 0,
        createdAt: input.createdAt,
        updatedAt: now,
        pendingRevision: input.pendingRevision,
        comment: {
          spaceId: input.spaceId,
          annotationId: input.annotationId,
          requestId: input.requestId,
          page: input.page,
        },
      }
      file.deliveries.push(record)
      changed.push(record)
    }
    if (!changed.length) return
    await saveFile(file)
    for (const record of changed) notify(record)
  })
}

function retireComment(record: DeliveryRecord, now: string): void {
  record.state = "failed"
  record.leaseId = undefined
  record.leaseExpiresAt = undefined
  record.nextAttemptAt = undefined
  record.error = {
    code: "DELIVERY_RETIRED",
    message: "This comment no longer waits on this agent.",
    retryable: false,
  }
  record.revision += 1
  record.updatedAt = now
}

/**
 * A comment stopped waiting on its agent: replied when they answered it, by
 * any route, else retired.
 */
export async function closeCommentDelivery(
  participantId: string,
  requestId: string,
  reason: "replied" | "resolved" | "withdrawn"
): Promise<void> {
  const known = (await readDeliveryState()).deliveries.some(
    (record) =>
      record.participantId === participantId &&
      record.comment?.requestId === requestId &&
      commentWaiting(record)
  )
  if (!known) return
  await serialized(async () => {
    const file = await loadFile()
    const record = file.deliveries.find(
      (candidate) =>
        candidate.participantId === participantId &&
        candidate.comment?.requestId === requestId
    )
    if (!record || !commentWaiting(record)) return
    const now = new Date().toISOString()
    if (reason === "replied") {
      // The runtime may still report the batch it was holding; this lets that
      // report find the comment answered rather than a lost lease.
      if (record.leaseId) record.repliedUnder = record.leaseId
      record.state = "replied"
      record.leaseId = undefined
      record.leaseExpiresAt = undefined
      record.nextAttemptAt = undefined
      record.error = undefined
      record.revision += 1
      record.updatedAt = now
    } else retireComment(record, now)
    await saveFile(file)
    notify(record)
  })
}

/**
 * Post a runtime's answer to the comments its lease still holds open, and
 * close the batch, in one step against expiry and retry. `append` gets the
 * comments still waiting; ones the agent already answered are left out.
 */
export async function commitCommentBatchReply(
  input: { participantId: string; messageId: string; leaseId: string },
  append: (waiting: CommentDeliveryRef[]) => Promise<void>
): Promise<ThreadActivity> {
  return serialized(async () => {
    const file = await loadFile()
    const record = requireLease(
      file,
      input.messageId,
      input.leaseId,
      input.participantId
    )
    if (!record.comment)
      throw new ThreadDeliveryError(
        "LEASE_LOST",
        "This lease is for a thread message; reply in its thread"
      )
    if (record.managedBy === "grok-bot" && record.state === "leased")
      throw new ThreadDeliveryError(
        "LEASE_LOST",
        "Accept the Grok Bot delivery before posting its reply"
      )
    const group = leaseGroup(file, record)
    await append(group.map((member) => member.comment!))
    const now = new Date().toISOString()
    for (const member of group) {
      member.repliedUnder = input.leaseId
      member.state = "replied"
      member.leaseId = undefined
      member.leaseExpiresAt = undefined
      member.nextAttemptAt = undefined
      member.error = undefined
      member.revision += 1
      member.updatedAt = now
    }
    await saveFile(file)
    for (const member of group) notify(member)
    return activityFor(record)
  })
}

/** Whether a lease's reply already went through, for a retry after a lost answer. */
export async function commentBatchReplied(
  participantId: string,
  leaseId: string
): Promise<ThreadActivity | null> {
  const { deliveries } = await readDeliveryState()
  const record = deliveries.find(
    (candidate) =>
      candidate.participantId === participantId &&
      candidate.repliedUnder === leaseId
  )
  if (!record) return null
  // Done only when nothing from its batch still waits: one comment answered
  // directly doesn't answer the rest.
  const pending = deliveries.some(
    (candidate) =>
      candidate.participantId === participantId &&
      candidate.comment !== undefined &&
      record.batchId !== undefined &&
      candidate.batchId === record.batchId &&
      commentWaiting(candidate)
  )
  return pending ? null : activityFor(record)
}

/** Whether this agent's runtime has asked for comments. */
export async function takesComments(participantId: string): Promise<boolean> {
  if (!commentTakers || !readStateTrusted())
    return (await readDeliveryState()).commentParticipants.has(participantId)
  return commentTakers.has(participantId)
}

/** How far each of an agent's comment deliveries has got, by request. */
export async function commentDeliveryStates(): Promise<
  ReadonlyMap<
    string,
    { state: ThreadActivity["state"]; attempts: number; error?: string }
  >
> {
  const states = new Map<
    string,
    { state: ThreadActivity["state"]; attempts: number; error?: string }
  >()
  for (const record of (await readDeliveryState()).deliveries)
    if (record.comment)
      states.set(record.comment.requestId, {
        state: publicState(record),
        attempts: record.attempts,
        ...(record.error ? { error: record.error.code } : {}),
      })
  return states
}

onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") {
    return serialized(() => saveFile(emptyFile()))
  }
})
