import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { nanoid } from "nanoid"
import type {
  ParticipantRef,
  Thread,
  ThreadLocation,
  ThreadMessage,
  ThreadSummary,
} from "@worktable/types"
import {
  defaultConversationIdentityId,
  PortableThreadSchema,
  prospectiveDefaultConversationIdentities,
  ThreadV3Schema,
  threadBodyMentionsIdentity,
  threadLocation,
  threadLocationKey,
  uniqueConversationIdentityNames,
  upgradeThreadToV3,
} from "@worktable/types"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import {
  getSpacesBaseDir,
  prepareSuppressedPathReplay,
  suppressPath,
  unsuppressPath,
  withStoreWriteLock,
} from "./store.ts"
import { listSpaces } from "./store.ts"
import { getWorkspaceRoot, workspaceCacheKey } from "./workspace.ts"
import { notifyWorkspaceChange } from "./workspace-events.ts"

export type ThreadErrorCode =
  | "THREAD_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "THREAD_STORE_INCOMPLETE"
  | "THREAD_SPACE_MISMATCH"
  | "AMBIGUOUS_THREAD_LOCATION"
  | "FORBIDDEN"

export class ThreadError extends Error {
  readonly code: ThreadErrorCode

  constructor(code: ThreadErrorCode, message: string) {
    super(message)
    this.name = "ThreadError"
    this.code = code
  }
}

export interface AppendThreadMessageInput {
  author: ParticipantRef
  authorIdentityId?: string
  recipient?: ParticipantRef
  notifyIdentityIds?: string[]
  responseIdentityId?: string | null
  body: string
  idempotencyKey: string
  inReplyTo?: string
  responseTo?: string
  expectsReply?: boolean
  participants?: ParticipantRef[]
  availableParticipants?: ParticipantRef[]
}

let tmpCounter = 0

function assertSafeSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new ThreadError("THREAD_NOT_FOUND", `Invalid ${label}`)
  }
}

export function normalizeThreadLocation(
  location: ThreadLocation | string
): ThreadLocation {
  return typeof location === "string"
    ? { kind: "space", spaceId: location }
    : location
}

export function threadsDir(locationInput: ThreadLocation | string): string {
  const location = normalizeThreadLocation(locationInput)
  if (location.kind === "worktable") {
    return join(getWorkspaceRoot(), "threads")
  }
  assertSafeSegment(location.spaceId, "space ID")
  return join(getSpacesBaseDir(), location.spaceId, "threads")
}

export function threadPath(
  location: ThreadLocation | string,
  threadId: string
): string {
  assertSafeSegment(threadId, "thread ID")
  return join(threadsDir(location), `${threadId}.json`)
}

function threadMutationLockPath(
  locationInput: ThreadLocation | string,
  threadId: string
): string {
  const location = normalizeThreadLocation(locationInput)
  return join(
    ensureAppDir(),
    "thread-locks",
    workspaceCacheKey(),
    location.kind === "space" ? location.spaceId : "worktable",
    `${threadId}.lock`
  )
}

function withThreadMutationLock<T>(
  location: ThreadLocation | string,
  threadId: string,
  operation: () => Promise<T>
): Promise<T> {
  const lockPath = threadMutationLockPath(location, threadId)
  return withStoreWriteLock(lockPath, () =>
    withCrossProcessLock(lockPath, { label: `Thread ${threadId}` }, operation)
  )
}

function titleFromBody(body: string): string {
  const firstLine = body
    .split(/\r?\n/, 1)[0]
    ?.replace(/^#{1,6}\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const title = firstLine || "New thread"
  if (title.length <= 72) return title
  const clipped = title.slice(0, 71)
  const lastWordBoundary = clipped.lastIndexOf(" ")
  return `${
    lastWordBoundary > 0
      ? clipped.slice(0, lastWordBoundary).trimEnd()
      : clipped
  }…`
}

async function writeThreadFile(thread: Thread): Promise<void> {
  const parsed = ThreadV3Schema.parse(thread)
  const location = threadLocation(parsed)
  const path = threadPath(location, parsed.id)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`
  suppressPath(path)
  suppressPath(tmp)
  prepareSuppressedPathReplay(path, async () => {
    try {
      if ((await readFile(path, "utf8")) === serialized) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    notifyWorkspaceChange({
      type: "thread",
      location,
      ...(location.kind === "space" ? { spaceId: location.spaceId } : {}),
      threadId: parsed.id,
    })
  })
  try {
    try {
      const current = PortableThreadSchema.parse(
        JSON.parse(await readFile(path, "utf8"))
      )
      if (current.version < 3) {
        await copyFile(
          path,
          `${path}.v${current.version}.bak`,
          fsConstants.COPYFILE_EXCL
        ).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await writeFile(tmp, serialized, "utf8")
    await rename(tmp, path)
  } finally {
    setTimeout(() => {
      unsuppressPath(path)
      unsuppressPath(tmp)
    }, 200)
  }
}

export async function readThread(
  locationInput: ThreadLocation | string,
  threadId: string
): Promise<Thread> {
  const location = normalizeThreadLocation(locationInput)
  const path = threadPath(location, threadId)
  try {
    const parsed = PortableThreadSchema.safeParse(
      JSON.parse(await readFile(path, "utf8"))
    )
    if (!parsed.success) {
      throw new Error(
        `Invalid thread file ${threadLocationKey(location)}/${threadId}: ${parsed.error.message}`
      )
    }
    const thread = upgradeThreadToV3(parsed.data)
    if (
      threadLocationKey(threadLocation(thread)) !==
        threadLocationKey(location) ||
      thread.id !== threadId
    ) {
      throw new ThreadError(
        "THREAD_SPACE_MISMATCH",
        `Thread ${threadId} does not belong to ${threadLocationKey(location)}`
      )
    }
    return thread
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ThreadError("THREAD_NOT_FOUND", `Thread not found: ${threadId}`)
    }
    throw error
  }
}

export interface ThreadScanResult {
  threads: Thread[]
  complete: boolean
}

export async function scanThreads(
  locationInput: ThreadLocation | string
): Promise<ThreadScanResult> {
  const location = normalizeThreadLocation(locationInput)
  const dir = threadsDir(location)
  if (!existsSync(dir)) return { threads: [], complete: true }
  const threads: Thread[] = []
  let complete = true
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const threadId = entry.name.slice(0, -".json".length)
    try {
      threads.push(await readThread(location, threadId))
    } catch (error) {
      complete = false
      console.error(`[threads] skipping unreadable thread ${threadId}:`, error)
    }
  }
  return {
    threads: threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    complete,
  }
}

export async function listThreads(
  location: ThreadLocation | string
): Promise<Thread[]> {
  return (await scanThreads(location)).threads
}

export async function scanAllThreads(): Promise<ThreadScanResult> {
  const scans = await Promise.all([
    scanThreads({ kind: "worktable" }),
    ...(await listSpaces()).map((space) => scanThreads(space.id)),
  ])
  return {
    threads: scans
      .flatMap((scan) => scan.threads)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    complete: scans.every((scan) => scan.complete),
  }
}

async function scanThreadsForIdempotency(
  location: ThreadLocation | string
): Promise<Thread[]> {
  const scan = await scanThreads(location)
  if (!scan.complete) {
    throw new ThreadError(
      "THREAD_STORE_INCOMPLETE",
      "Thread creation is temporarily unavailable while a portable thread file is unreadable; retry after the file write completes"
    )
  }
  return scan.threads
}

export async function findThread(
  threadId: string,
  preferredLocation?: ThreadLocation | string
): Promise<Thread> {
  if (preferredLocation) return readThread(preferredLocation, threadId)
  let match: Thread | undefined
  const locations: ThreadLocation[] = [
    { kind: "worktable" },
    ...(await listSpaces()).map(
      (space): ThreadLocation => ({ kind: "space", spaceId: space.id })
    ),
  ]
  for (const location of locations) {
    try {
      const candidate = await readThread(location, threadId)
      if (match) {
        throw new ThreadError(
          "AMBIGUOUS_THREAD_LOCATION",
          `Thread ${threadId} exists in more than one location; provide location`
        )
      }
      match = candidate
    } catch (error) {
      if (
        !(error instanceof ThreadError) ||
        error.code !== "THREAD_NOT_FOUND"
      ) {
        throw error
      }
    }
  }
  if (match) return match
  throw new ThreadError("THREAD_NOT_FOUND", `Thread not found: ${threadId}`)
}

function defaultIdentityForMember(
  thread: Thread,
  memberId: string,
  options: { requireActive?: boolean } = {}
): Thread["identities"][number] | undefined {
  const requireActive = options.requireActive ?? true
  return thread.identities.find(
    (identity) =>
      identity.memberId === memberId &&
      identity.default &&
      (!requireActive || identity.status === "active")
  )
}

function messageTargetMemberIds(
  thread: Thread,
  message: ThreadMessage
): string[] {
  const creationIntent = messageCreationIntent(message)
  const identityIds = new Set([
    ...creationIntent.notifyIdentityIds,
    ...(creationIntent.responseIdentityId
      ? [creationIntent.responseIdentityId]
      : []),
  ])
  return [
    ...new Set(
      thread.identities
        .filter((identity) => identityIds.has(identity.id))
        .map((identity) => identity.memberId)
    ),
  ]
}

function messageCreationIntent(message: ThreadMessage): {
  notifyIdentityIds: string[]
  responseIdentityId: string | null
} {
  return (
    message.creationIntent ?? {
      notifyIdentityIds: message.notifyIdentityIds,
      responseIdentityId: message.responseRequest?.identityId ?? null,
    }
  )
}

function messageRecipientForRetry(
  thread: Thread,
  message: ThreadMessage,
  authorMemberId: string
): ParticipantRef | undefined {
  const targetMemberIds = messageTargetMemberIds(thread, message)
  if (targetMemberIds.length === 1) {
    return thread.members.find((member) => member.id === targetMemberIds[0])
  }
  if (targetMemberIds.length > 1) return undefined

  const otherMembers = thread.members.filter(
    (member) => member.id !== authorMemberId
  )
  return otherMembers.length === 1 ? otherMembers[0] : undefined
}

function resolvedIntent(
  thread: Thread,
  input: AppendThreadMessageInput,
  options: { requireActive?: boolean } = {}
): {
  authorIdentityId: string
  notifyIdentityIds: string[]
  responseIdentityId?: string
} {
  const requireActive = options.requireActive ?? true
  const authorIdentity = input.authorIdentityId
    ? thread.identities.find(
        (identity) =>
          identity.id === input.authorIdentityId &&
          identity.memberId === input.author.id &&
          (!requireActive || identity.status === "active")
      )
    : defaultIdentityForMember(thread, input.author.id, { requireActive })
  if (!authorIdentity) {
    throw new ThreadError(
      "FORBIDDEN",
      "The authenticated member has no active conversation identity in this thread"
    )
  }
  const recipientIdentity = input.recipient
    ? defaultIdentityForMember(thread, input.recipient.id, { requireActive })
    : undefined
  if (input.recipient && !recipientIdentity) {
    throw new ThreadError(
      "FORBIDDEN",
      "The recipient has no active conversation identity in this thread"
    )
  }
  const requestedNotifyIdentityIds = input.notifyIdentityIds ?? []
  const responseIdentityId =
    input.responseIdentityId === null
      ? undefined
      : (input.responseIdentityId ??
        (recipientIdentity && (input.expectsReply ?? true)
          ? recipientIdentity.id
          : undefined))
  const notifyIdentityIds = [...new Set(requestedNotifyIdentityIds)].filter(
    (identityId) => identityId !== responseIdentityId
  )
  if (requireActive) {
    const memberIds = new Set(thread.members.map((member) => member.id))
    for (const identityId of [
      ...requestedNotifyIdentityIds,
      ...(responseIdentityId ? [responseIdentityId] : []),
    ]) {
      const identity = thread.identities.find(
        (candidate) => candidate.id === identityId
      )
      if (
        !identity ||
        identity.status !== "active" ||
        !memberIds.has(identity.memberId)
      ) {
        throw new ThreadError(
          "FORBIDDEN",
          `Conversation identity is not active in this thread: ${identityId}`
        )
      }
    }
  }
  if (requireActive) {
    for (const identityId of notifyIdentityIds) {
      const identity = thread.identities.find(
        (candidate) => candidate.id === identityId
      )
      if (identity && !threadBodyMentionsIdentity(input.body, identity.name)) {
        throw new ThreadError(
          "FORBIDDEN",
          `A passive mention of ${identity.name} must appear in the message body as @${identity.name}`
        )
      }
    }
  }
  return {
    authorIdentityId: authorIdentity.id,
    notifyIdentityIds,
    ...(responseIdentityId ? { responseIdentityId } : {}),
  }
}

function responseTargetForMessage(
  thread: Thread,
  messageId: string
): string | undefined {
  return thread.messages.find(
    (source) => source.responseRequest?.respondedBy === messageId
  )?.id
}

function responseTargetMatchesRetry(
  thread: Thread,
  message: ThreadMessage,
  input: AppendThreadMessageInput
): boolean {
  const recordedTarget = responseTargetForMessage(thread, message.id)
  return (
    recordedTarget === input.responseTo ||
    (input.responseTo === undefined &&
      input.inReplyTo !== undefined &&
      recordedTarget === input.inReplyTo)
  )
}

function sameIdentitySet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const sortedRight = [...right].sort()
  return [...left].sort().every((value, index) => value === sortedRight[index])
}

function sameMessageIntent(
  thread: Thread,
  message: ThreadMessage,
  input: AppendThreadMessageInput
): boolean {
  const intent = resolvedIntent(thread, input, { requireActive: false })
  const creationIntent = messageCreationIntent(message)
  const replyTarget = input.responseTo ?? input.inReplyTo
  return (
    message.authorMemberId === input.author.id &&
    message.authorIdentityId === intent.authorIdentityId &&
    message.body === input.body &&
    message.inReplyTo === replyTarget &&
    responseTargetMatchesRetry(thread, message, input) &&
    sameIdentitySet(
      creationIntent.notifyIdentityIds,
      intent.notifyIdentityIds
    ) &&
    (creationIntent.responseIdentityId ?? undefined) ===
      intent.responseIdentityId
  )
}

function idempotencyMatch(
  thread: Thread,
  input: AppendThreadMessageInput
): ThreadMessage | null {
  const existing = thread.messages.find(
    (message) =>
      message.authorMemberId === input.author.id &&
      message.idempotencyKey === input.idempotencyKey
  )
  if (!existing) return null
  if (!sameMessageIntent(thread, existing, input)) {
    throw new ThreadError(
      "IDEMPOTENCY_CONFLICT",
      `Idempotency key "${input.idempotencyKey}" was already used for different thread content`
    )
  }
  return existing
}

export interface ThreadCreationRetryInput extends Omit<
  AppendThreadMessageInput,
  "recipient"
> {
  to: string
}

export interface ThreadAppendRetryInput extends Omit<
  AppendThreadMessageInput,
  "recipient"
> {
  to?: string
}

export function findThreadAppendRetry(
  thread: Thread,
  input: ThreadAppendRetryInput
): {
  thread: Thread
  message: ThreadMessage
  recipient?: ParticipantRef
  created: false
} | null {
  const existing = thread.messages.find(
    (message) =>
      message.authorMemberId === input.author.id &&
      message.idempotencyKey === input.idempotencyKey
  )
  if (!existing) return null

  const hasExplicitTargets =
    input.notifyIdentityIds !== undefined ||
    input.responseIdentityId !== undefined
  const recipient = hasExplicitTargets
    ? undefined
    : messageRecipientForRetry(thread, existing, input.author.id)
  const recipientNeedle = input.to?.trim().toLocaleLowerCase()
  const intendedRecipient = hasExplicitTargets
    ? true
    : input.to
      ? recipient &&
        (recipient.id === input.to ||
          recipient.name.toLocaleLowerCase() === recipientNeedle)
      : thread.members.filter((member) => member.id !== input.author.id)
          .length === 1

  if (
    !intendedRecipient ||
    !sameMessageIntent(thread, existing, { ...input, recipient })
  ) {
    throw new ThreadError(
      "IDEMPOTENCY_CONFLICT",
      `Idempotency key "${input.idempotencyKey}" was already used for different thread content`
    )
  }
  return { thread, message: existing, recipient, created: false }
}

export async function findThreadCreationRetry(
  location: ThreadLocation | string,
  input: ThreadCreationRetryInput
): Promise<{
  thread: Thread
  message: ThreadMessage
  recipient: ParticipantRef
  created: false
} | null> {
  const matches: Array<{
    thread: Thread
    message: ThreadMessage
    recipient: ParticipantRef
    created: false
  }> = []
  const recipientNeedle = input.to.trim().toLocaleLowerCase()
  for (const thread of await scanThreadsForIdempotency(location)) {
    const existing = thread.messages.find(
      (message) =>
        message.authorMemberId === input.author.id &&
        message.idempotencyKey === input.idempotencyKey
    )
    if (!existing) continue
    const recipient = messageRecipientForRetry(
      thread,
      existing,
      input.author.id
    )
    if (
      !recipient ||
      (recipient.id !== input.to &&
        recipient.name.toLocaleLowerCase() !== recipientNeedle) ||
      !sameMessageIntent(thread, existing, { ...input, recipient })
    ) {
      throw new ThreadError(
        "IDEMPOTENCY_CONFLICT",
        `Idempotency key "${input.idempotencyKey}" was already used for different thread content`
      )
    }
    matches.push({ thread, message: existing, recipient, created: false })
  }
  if (matches.length > 1) {
    throw new ThreadError(
      "IDEMPOTENCY_CONFLICT",
      `Idempotency key "${input.idempotencyKey}" matches more than one portable thread`
    )
  }
  return matches[0] ?? null
}

export async function createThread(
  locationInput: ThreadLocation | string,
  input: AppendThreadMessageInput
): Promise<{ thread: Thread; message: ThreadMessage; created: boolean }> {
  if (input.inReplyTo || input.responseTo) {
    throw new ThreadError(
      "THREAD_NOT_FOUND",
      "A new thread cannot reply to a message from another thread"
    )
  }
  const location = normalizeThreadLocation(locationInput)
  if (!input.recipient) {
    throw new ThreadError(
      "FORBIDDEN",
      "A new thread requires at least one conversation member"
    )
  }
  const recipient = input.recipient
  return withThreadMutationLock({ kind: "worktable" }, "create", async () => {
    for (const existingThread of await scanThreadsForIdempotency(location)) {
      const existing = idempotencyMatch(existingThread, input)
      if (existing) {
        return { thread: existingThread, message: existing, created: false }
      }
    }

    const now = new Date().toISOString()
    let threadId: string
    while (true) {
      threadId = `thr_${nanoid(16)}`
      try {
        await findThread(threadId)
      } catch (error) {
        if (error instanceof ThreadError && error.code === "THREAD_NOT_FOUND") {
          break
        }
        throw error
      }
    }
    const memberRefs = new Map(
      [input.author, recipient].map((member) => [member.id, member])
    )
    const members: Thread["members"] = [...memberRefs.values()].map(
      (member) => ({
        ...member,
        addedAt: now,
      })
    )
    const identityNames = uniqueConversationIdentityNames(
      members.map((member) => member.name)
    )
    const identities: Thread["identities"] = members.map((member, index) => ({
      id: `idt_${member.id.replace(/^ptc_/, "")}`,
      memberId: member.id,
      name: identityNames[index]!,
      default: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }))
    const authorIdentity = identities.find(
      (identity) => identity.memberId === input.author.id
    )!
    const recipientIdentity = identities.find(
      (identity) => identity.memberId === recipient.id
    )!
    if (
      input.authorIdentityId &&
      input.authorIdentityId !== authorIdentity.id
    ) {
      throw new ThreadError(
        "FORBIDDEN",
        "A new thread starts with the member's default conversation identity"
      )
    }
    const requestedIdentityIds = [
      ...(input.notifyIdentityIds ?? []),
      ...(input.responseIdentityId ? [input.responseIdentityId] : []),
    ]
    if (
      requestedIdentityIds.some(
        (identityId) => identityId !== recipientIdentity.id
      )
    ) {
      throw new ThreadError(
        "FORBIDDEN",
        "A new thread can direct attention only to its recipient"
      )
    }
    const responseIdentityId =
      input.responseIdentityId === null
        ? undefined
        : (input.responseIdentityId ??
          ((input.expectsReply ?? true) ? recipientIdentity.id : undefined))
    const notifyIdentityIds = [
      ...new Set(input.notifyIdentityIds ?? []),
    ].filter((identityId) => identityId !== responseIdentityId)
    for (const identityId of notifyIdentityIds) {
      const identity = identities.find(
        (candidate) => candidate.id === identityId
      )!
      if (!threadBodyMentionsIdentity(input.body, identity.name)) {
        throw new ThreadError(
          "FORBIDDEN",
          `A passive mention of ${identity.name} must appear in the message body as @${identity.name}`
        )
      }
    }
    const message: ThreadMessage = {
      id: `msg_${nanoid(16)}`,
      sequence: 1,
      authorIdentityId: authorIdentity.id,
      authorMemberId: input.author.id,
      notifyIdentityIds,
      creationIntent: {
        notifyIdentityIds,
        responseIdentityId: responseIdentityId ?? null,
      },
      ...(responseIdentityId
        ? {
            responseRequest: { identityId: responseIdentityId, status: "open" },
          }
        : {}),
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    }
    const thread: Thread = {
      type: "worktable.thread",
      version: 3,
      id: threadId,
      location,
      title: titleFromBody(input.body),
      members,
      identities,
      revision: 1,
      messages: [message],
      createdAt: now,
      updatedAt: now,
    }
    await writeThreadFile(thread)
    notifyWorkspaceChange({
      type: "thread",
      location,
      ...(location.kind === "space" ? { spaceId: location.spaceId } : {}),
      threadId,
    })
    return { thread, message, created: true }
  })
}

export async function appendThreadMessage(
  locationInput: ThreadLocation | string,
  threadId: string,
  input: AppendThreadMessageInput
): Promise<{ thread: Thread; message: ThreadMessage; created: boolean }> {
  const location = normalizeThreadLocation(locationInput)
  return withThreadMutationLock(location, threadId, async () => {
    const stored = await readThread(location, threadId)
    const existing = idempotencyMatch(stored, input)
    if (existing) return { thread: stored, message: existing, created: false }
    const now = new Date().toISOString()
    const thread = threadWithParticipants(
      stored,
      [
        input.author,
        ...(input.recipient ? [input.recipient] : []),
        ...(input.participants ?? []),
      ],
      now,
      input.availableParticipants
    )
    const replyTargetId = input.responseTo ?? input.inReplyTo
    if (
      replyTargetId &&
      !thread.messages.some((message) => message.id === replyTargetId)
    ) {
      throw new ThreadError(
        "THREAD_NOT_FOUND",
        `Reply target not found in thread: ${replyTargetId}`
      )
    }
    if (
      input.responseTo &&
      input.inReplyTo &&
      input.responseTo !== input.inReplyTo
    ) {
      throw new ThreadError(
        "FORBIDDEN",
        "A response cannot reply to a different source message"
      )
    }

    const intent = resolvedIntent(thread, input)
    const message: ThreadMessage = {
      id: `msg_${nanoid(16)}`,
      sequence: thread.messages.length + 1,
      authorIdentityId: intent.authorIdentityId,
      authorMemberId: input.author.id,
      notifyIdentityIds: intent.notifyIdentityIds,
      creationIntent: {
        notifyIdentityIds: intent.notifyIdentityIds,
        responseIdentityId: intent.responseIdentityId ?? null,
      },
      ...(intent.responseIdentityId
        ? {
            responseRequest: {
              identityId: intent.responseIdentityId,
              status: "open",
            },
          }
        : {}),
      body: input.body,
      ...(replyTargetId ? { inReplyTo: replyTargetId } : {}),
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    }
    const messages = thread.messages.map((candidate) => {
      if (candidate.id !== input.responseTo) return candidate
      const request = candidate.responseRequest
      if (
        request?.identityId !== intent.authorIdentityId ||
        request.status !== "open"
      ) {
        throw new ThreadError(
          "FORBIDDEN",
          "This conversation identity does not have an open response request for that message"
        )
      }
      return {
        ...candidate,
        creationIntent: messageCreationIntent(candidate),
        responseRequest: {
          ...request,
          status: "responded" as const,
          respondedBy: message.id,
          resolvedAt: now,
        },
      }
    })
    const next: Thread = {
      ...thread,
      revision: stored.revision + 1,
      messages: [...messages, message],
      updatedAt: now,
    }
    await writeThreadFile(next)
    notifyWorkspaceChange({
      type: "thread",
      location,
      ...(location.kind === "space" ? { spaceId: location.spaceId } : {}),
      threadId,
    })
    return { thread: next, message, created: true }
  })
}

async function persistThreadMutation(
  locationInput: ThreadLocation | string,
  threadId: string,
  mutate: (thread: Thread, now: string) => Thread
): Promise<Thread> {
  const location = normalizeThreadLocation(locationInput)
  return withThreadMutationLock(location, threadId, async () => {
    const thread = await readThread(location, threadId)
    const next = mutate(thread, new Date().toISOString())
    if (next === thread) return thread
    await writeThreadFile(next)
    notifyWorkspaceChange({
      type: "thread",
      location,
      ...(location.kind === "space" ? { spaceId: location.spaceId } : {}),
      threadId,
    })
    return next
  })
}

function threadWithParticipants(
  thread: Thread,
  participants: ParticipantRef[],
  now: string,
  availableParticipants: ParticipantRef[] = participants
): Thread {
  const requested = [
    ...new Map(
      participants.map((participant) => [participant.id, participant])
    ).values(),
  ]
  const missing = requested.filter(
    (participant) =>
      !thread.members.some((member) => member.id === participant.id)
  )
  const defaultsToActivate = thread.identities.filter(
    (identity) =>
      identity.default &&
      identity.status !== "active" &&
      requested.some((participant) => participant.id === identity.memberId)
  )
  if (missing.length === 0 && defaultsToActivate.length === 0) return thread
  const addedOrActivated = [
    ...defaultsToActivate.map((identity) =>
      requested.find((participant) => participant.id === identity.memberId)
    ),
    ...missing,
  ].filter((participant): participant is ParticipantRef => Boolean(participant))
  const prospectiveByMemberId = new Map(
    prospectiveDefaultConversationIdentities(thread.identities, [
      ...availableParticipants,
      ...requested,
    ]).map((identity) => [identity.memberId, identity.name])
  )
  const identityNames = addedOrActivated.map(
    (participant) =>
      prospectiveByMemberId.get(participant.id) ?? participant.name
  )
  const activatedNames = new Map(
    defaultsToActivate.map((identity, index) => [
      identity.id,
      identityNames[index]!,
    ])
  )
  return {
    ...thread,
    members: [
      ...thread.members,
      ...missing.map((participant) => ({ ...participant, addedAt: now })),
    ],
    identities: [
      ...thread.identities.map((identity) =>
        activatedNames.has(identity.id)
          ? {
              ...identity,
              name: activatedNames.get(identity.id)!,
              status: "active" as const,
              updatedAt: now,
            }
          : identity
      ),
      ...missing.map((participant, index) => ({
        id: defaultConversationIdentityId(participant.id),
        memberId: participant.id,
        name: identityNames[defaultsToActivate.length + index]!,
        default: true,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      })),
    ],
  }
}

export async function assignThreadMessage(
  location: ThreadLocation | string,
  threadId: string,
  messageId: string,
  identityId: string | null,
  participant?: ParticipantRef,
  availableParticipants?: ParticipantRef[]
): Promise<{ thread: Thread; replacedIdentityId?: string }> {
  let replacedIdentityId: string | undefined
  const mutate = (thread: Thread, now: string): Thread => {
    const prepared = participant
      ? threadWithParticipants(
          thread,
          [participant],
          now,
          availableParticipants
        )
      : thread
    const message = prepared.messages.find(
      (candidate) => candidate.id === messageId
    )
    if (!message) {
      throw new ThreadError("THREAD_NOT_FOUND", "Message not found")
    }
    replacedIdentityId = message.responseRequest?.identityId
    if (message.responseRequest?.status === "responded") {
      throw new ThreadError(
        "FORBIDDEN",
        "A completed assignment cannot be changed"
      )
    }
    if (identityId) {
      const identity = prepared.identities.find(
        (candidate) => candidate.id === identityId
      )
      const member = identity
        ? prepared.members.find(
            (candidate) => candidate.id === identity.memberId
          )
        : undefined
      if (identity?.status !== "active" || !member) {
        throw new ThreadError(
          "FORBIDDEN",
          "The assigned identity is not available in this thread"
        )
      }
    }
    if (
      message.responseRequest?.status === "open" &&
      message.responseRequest.identityId === identityId
    ) {
      return prepared === thread
        ? thread
        : {
            ...prepared,
            revision: thread.revision + 1,
            updatedAt: now,
          }
    }
    return {
      ...prepared,
      messages: prepared.messages.map((candidate) =>
        candidate.id === messageId
          ? {
              ...candidate,
              creationIntent: messageCreationIntent(candidate),
              notifyIdentityIds: identityId
                ? candidate.notifyIdentityIds.filter(
                    (candidateId) => candidateId !== identityId
                  )
                : candidate.notifyIdentityIds,
              ...(identityId
                ? {
                    responseRequest: {
                      identityId,
                      status: "open" as const,
                    },
                  }
                : { responseRequest: undefined }),
            }
          : candidate
      ),
      revision: thread.revision + 1,
      updatedAt: now,
    }
  }
  const updated = await persistThreadMutation(location, threadId, mutate)
  return { thread: updated, replacedIdentityId }
}

export function summarizeThread(thread: Thread): ThreadSummary {
  const location = threadLocation(thread)
  return {
    id: thread.id,
    version: thread.version,
    location,
    ...(location.kind === "space" ? { spaceId: location.spaceId } : {}),
    title: thread.title,
    members: thread.members,
    identities: thread.identities,
    revision: thread.revision,
    messageCount: thread.messages.length,
    lastMessage: thread.messages[thread.messages.length - 1]!,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  }
}
