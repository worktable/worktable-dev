import type {
  ParticipantRef,
  ThreadActivity,
  ThreadDeliveryState,
  ThreadLocation,
  ThreadPostResult,
  ThreadReadResult,
  ThreadSummary,
  ThreadWaitResult,
} from "@worktable/types"
import { defaultConversationIdentityId, threadLocation } from "@worktable/types"
import type { TokenIdentity } from "./token-store.ts"
import { hasWorkspaceOwnerAuthority } from "./owner-authority.ts"
import {
  acceptThreadDelivery,
  claimThreadDelivery,
  failThreadDelivery,
  getThreadActivities,
  getThreadActivity,
  latestThreadActivity,
  markThreadDeliveryReplied,
  nextThreadDeliveryEligibleAt,
  progressThreadDelivery,
  queueThreadDelivery,
  reconcileThreadDeliveries,
  requireThreadDeliveryLease,
  type ReconcileThreadDeliveryInput,
  type ClaimedDelivery,
} from "./thread-delivery-store.ts"
import {
  appendThreadMessage,
  assignThreadMessage,
  createThread,
  findThreadAppendRetry,
  findThreadCreationRetry,
  findThread,
  listThreads,
  normalizeThreadLocation,
  readThread,
  scanAllThreads,
  summarizeThread,
  ThreadError,
} from "./thread-store.ts"
import {
  listParticipantBindings,
  requireParticipant,
  resolveParticipant,
} from "./participant-store.ts"
import { getSpaceArchiveInfo, listSpaces, readSpace } from "./store.ts"
import { listAgentConnections } from "./agent-connection-store.ts"
import {
  inboxSignalRevision,
  threadSignalRevision,
  waitForInboxSignal,
  waitForThreadSignal,
} from "./thread-waiters.ts"

const MAX_WAIT_SECONDS = 25
const THREAD_MESSAGE_PAGE_SIZE = 100
type ThreadIdentity = Pick<
  TokenIdentity,
  "agent" | "credentialClass" | "principal" | "scopes"
>

export interface PostThreadInput {
  location?: ThreadLocation
  /** @deprecated Use location instead. */
  spaceId?: string
  threadId?: string
  to?: string
  body: string
  idempotencyKey: string
  authorIdentityId?: string
  deliveryLeaseId?: string
  notifyIdentityIds?: string[]
  responseIdentityId?: string | null
  inReplyTo?: string
  /** Explicitly names the response request this message satisfies. */
  responseTo?: string | null
  expectsReply?: boolean
  waitSeconds?: number
}

export interface ThreadProgressUpdate {
  activity: ThreadActivity
}

function boundedWaitSeconds(value: number | undefined): number {
  if (value === undefined) return 0
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, value))
}

function latestActivity(
  activities: ThreadActivity[]
): ThreadActivity | undefined {
  return activities.reduce<ThreadActivity | undefined>(
    (latest, activity) =>
      !latest || activity.updatedAt >= latest.updatedAt ? activity : latest,
    undefined
  )
}

function responseMessages(
  messages: ThreadReadResult["thread"]["messages"],
  messageId: string | undefined
): ThreadReadResult["messages"] {
  if (!messageId) return []
  const respondedBy = messages.find((message) => message.id === messageId)
    ?.responseRequest?.respondedBy
  if (!respondedBy) return []
  const response = messages.find((message) => message.id === respondedBy)
  return response ? [response] : []
}

function expectedActivityTerminal(
  request: ThreadReadResult["thread"]["messages"][number]["responseRequest"],
  activity: ThreadActivity | undefined
): boolean {
  return (
    request?.status === "responded" ||
    request?.status === "withdrawn" ||
    activity?.state === "failed"
  )
}

function awaitedResult(
  result: ThreadReadResult,
  actorId: string,
  after: number,
  messageId?: string,
  expectedResponseMessages: ThreadReadResult["messages"] = []
): ThreadReadResult {
  const expectedResponseMessageIds = new Set(
    expectedResponseMessages.map((message) => message.id)
  )
  const windowMessageIds = new Set(result.messages.map((message) => message.id))
  const candidateMessages = [
    ...result.messages,
    ...expectedResponseMessages.filter(
      (message) => !windowMessageIds.has(message.id)
    ),
  ].sort((left, right) => left.sequence - right.sequence)
  const messages: ThreadReadResult["messages"] = []
  let cursor = after
  let cursorBlocked = false
  for (const message of candidateMessages) {
    const awaited =
      expectedResponseMessageIds.has(message.id) ||
      (!messageId && message.authorMemberId !== actorId)
    if (awaited) {
      messages.push(message)
      if (!cursorBlocked) cursor = Math.max(cursor, message.sequence)
      continue
    }
    // The caller already knows messages it authored, so they can be safely
    // acknowledged without returning them as replies. This comes after the
    // identity-specific match so a self-handoff can return a response spoken
    // through another conversation identity owned by the same member.
    if (message.authorMemberId === actorId) {
      if (!cursorBlocked) cursor = Math.max(cursor, message.sequence)
      continue
    }
    // A nonmatching message from anyone else must remain behind the cursor for
    // catch-up rather than being consumed by this targeted wait.
    cursorBlocked = true
  }
  return { ...result, messages, cursor }
}

async function participantForIdentity(identity: ThreadIdentity) {
  return resolveParticipant(identity)
}

function hasOwnerAuthority(identity: ThreadIdentity): boolean {
  return hasWorkspaceOwnerAuthority(identity)
}

function otherParticipant(
  participants: ParticipantRef[],
  participantId: string
): ParticipantRef {
  const others = participants.filter(
    (participant) => participant.id !== participantId
  )
  if (others.length !== 1) {
    throw new ThreadError(
      "FORBIDDEN",
      "A recipient is required for threads with more than two participants"
    )
  }
  return others[0]!
}

async function participantContextForUnknownDefaultIdentities(
  thread: ThreadReadResult["thread"],
  identityIds: string[]
): Promise<{
  participants: ParticipantRef[]
  availableParticipants: ParticipantRef[]
}> {
  const knownIdentityIds = new Set(
    thread.identities.map((identity) => identity.id)
  )
  const unknownIdentityIds = [
    ...new Set(
      identityIds.filter((identityId) => !knownIdentityIds.has(identityId))
    ),
  ]
  if (unknownIdentityIds.length === 0) {
    return { participants: [], availableParticipants: [] }
  }

  const availableParticipants = (await listParticipantBindings()).map(
    (binding) => binding.participant
  )
  const participantsByIdentity = new Map(
    availableParticipants.map((participant) => [
      defaultConversationIdentityId(participant.id),
      participant,
    ])
  )
  const matches = unknownIdentityIds.map((identityId) =>
    participantsByIdentity.get(identityId)
  )
  const missingIdentityId = unknownIdentityIds.find(
    (identityId) => !participantsByIdentity.has(identityId)
  )
  if (missingIdentityId) {
    throw new ThreadError(
      "FORBIDDEN",
      `Conversation identity is not available in this workspace: ${missingIdentityId}`
    )
  }
  return {
    participants: matches.filter((participant): participant is ParticipantRef =>
      Boolean(participant)
    ),
    availableParticipants,
  }
}

async function readResult(
  location: ThreadLocation,
  threadId: string,
  options: { after?: number; before?: number },
  viewerParticipantId: string,
  knownThread?: ThreadReadResult["thread"]
): Promise<ThreadReadResult> {
  const thread = knownThread ?? (await readThread(location, threadId))
  const messages =
    options.before !== undefined
      ? thread.messages
          .filter((message) => message.sequence < options.before!)
          .slice(-THREAD_MESSAGE_PAGE_SIZE)
      : options.after !== undefined
        ? thread.messages
            .filter((message) => message.sequence > options.after!)
            .slice(0, THREAD_MESSAGE_PAGE_SIZE)
        : thread.messages.slice(-THREAD_MESSAGE_PAGE_SIZE)
  const messageIds = new Set(messages.map((message) => message.id))
  const activities = (await getThreadActivities(location, threadId)).filter(
    (activity) => messageIds.has(activity.messageId)
  )
  const viewerIdentity = thread.identities.find(
    (identity) =>
      identity.memberId === viewerParticipantId &&
      identity.default &&
      identity.status === "active"
  )
  const latestSequence = thread.messages.at(-1)?.sequence ?? 0
  return {
    location,
    ...(location.kind === "space" ? { spaceId: location.spaceId } : {}),
    thread: { ...thread, messages },
    messages,
    cursor:
      messages.at(-1)?.sequence ??
      (options.after === undefined
        ? 0
        : Math.min(options.after, latestSequence)),
    oldestCursor: messages[0]?.sequence ?? options.before ?? 0,
    hasOlder: Boolean(
      messages[0] && thread.messages[0]!.sequence < messages[0].sequence
    ),
    hasNewer:
      messages.length > 0
        ? latestSequence > messages.at(-1)!.sequence
        : options.before !== undefined &&
          thread.messages.length > 0 &&
          latestSequence >= options.before,
    activities,
    activity: activities.at(-1),
    viewerMemberId: viewerParticipantId,
    ...(viewerIdentity ? { viewerIdentityId: viewerIdentity.id } : {}),
    viewerParticipantId,
  }
}

async function latestThreadSummaryActivity(
  thread: ThreadReadResult["thread"]
): Promise<ThreadActivity | undefined> {
  const activities = await getThreadActivities(
    threadLocation(thread),
    thread.id
  )
  const requests = new Map(
    thread.messages.flatMap((message) =>
      message.responseRequest
        ? [[message.id, message.responseRequest] as const]
        : []
    )
  )
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!
    const request = requests.get(activity.messageId)
    if (!request || request.identityId !== activity.identityId) continue
    if (
      request.status === "open" ||
      (request.status === "responded" && activity.state === "replied")
    ) {
      return activity
    }
  }
  return undefined
}

export async function postThreadMessage(
  identity: ThreadIdentity,
  input: PostThreadInput,
  onProgress?: (update: ThreadProgressUpdate) => void | Promise<void>
): Promise<ThreadPostResult> {
  const actorBinding = await participantForIdentity(identity)
  const actor = actorBinding.participant
  const responseTo = input.responseTo ?? undefined

  if (
    input.location &&
    input.spaceId &&
    (input.location.kind !== "space" ||
      input.location.spaceId !== input.spaceId)
  ) {
    throw new ThreadError(
      "THREAD_SPACE_MISMATCH",
      "location and deprecated spaceId must identify the same Space"
    )
  }
  let location: ThreadLocation | undefined =
    input.location ??
    (input.spaceId ? { kind: "space", spaceId: input.spaceId } : undefined)
  let recipient: ParticipantRef | undefined
  let result: Awaited<ReturnType<typeof createThread>>

  if (input.threadId) {
    let existing = await findThread(input.threadId, location)
    location = threadLocation(existing)
    const replay = findThreadAppendRetry(existing, {
      author: actor,
      authorIdentityId: input.authorIdentityId,
      to: input.to,
      notifyIdentityIds: input.notifyIdentityIds,
      responseIdentityId: input.responseIdentityId,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      inReplyTo: input.inReplyTo,
      responseTo,
      expectsReply: input.expectsReply,
    })
    if (replay) {
      recipient = replay.recipient
      result = replay
    } else {
      const explicitRecipient = input.to
        ? await requireParticipant(input.to)
        : undefined
      const attentionContext =
        await participantContextForUnknownDefaultIdentities(existing, [
          ...(input.notifyIdentityIds ?? []),
          ...(input.responseIdentityId ? [input.responseIdentityId] : []),
        ])
      const selectedAuthorIdentity = input.authorIdentityId
        ? existing.identities.find(
            (candidate) =>
              candidate.id === input.authorIdentityId &&
              candidate.memberId === actor.id &&
              candidate.status === "active"
          )
        : undefined
      if (input.authorIdentityId && !selectedAuthorIdentity) {
        throw new ThreadError(
          "FORBIDDEN",
          "The selected conversation identity does not belong to the authenticated member"
        )
      }
      const selectedAuthorIdentityId =
        selectedAuthorIdentity?.id ?? defaultConversationIdentityId(actor.id)
      if (input.deliveryLeaseId && responseTo) {
        await requireThreadDeliveryLease({
          location,
          threadId: existing.id,
          messageId: responseTo,
          identityId: selectedAuthorIdentityId,
          participantId: actor.id,
          leaseId: input.deliveryLeaseId,
        })
      }
      recipient = explicitRecipient
        ? explicitRecipient
        : input.notifyIdentityIds === undefined &&
            input.responseIdentityId === undefined
          ? otherParticipant(existing.members, actor.id)
          : undefined
      result = await appendThreadMessage(location, existing.id, {
        author: actor,
        authorIdentityId: input.authorIdentityId,
        recipient,
        notifyIdentityIds: input.notifyIdentityIds,
        responseIdentityId: input.responseIdentityId,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        inReplyTo: input.inReplyTo,
        responseTo,
        expectsReply: input.expectsReply,
        participants: attentionContext.participants,
        availableParticipants: attentionContext.availableParticipants,
      })
    }
  } else {
    location =
      location ??
      (actorBinding.defaultSpaceId
        ? { kind: "space", spaceId: actorBinding.defaultSpaceId }
        : { kind: "worktable" })
    if (location.kind === "space") {
      const space = await readSpace(location.spaceId)
      if (!space.data) {
        throw new ThreadError(
          "THREAD_SPACE_MISMATCH",
          space.error ?? `Space not found: ${location.spaceId}`
        )
      }
    }
    if (!input.to) {
      throw new ThreadError(
        "FORBIDDEN",
        "to is required when creating a thread"
      )
    }
    const replay = await findThreadCreationRetry(location, {
      author: actor,
      authorIdentityId: input.authorIdentityId,
      to: input.to,
      notifyIdentityIds: input.notifyIdentityIds,
      responseIdentityId: input.responseIdentityId,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      inReplyTo: input.inReplyTo,
      responseTo,
      expectsReply: input.expectsReply,
    })
    if (replay) {
      recipient = replay.recipient
      result = replay
    } else {
      recipient = await requireParticipant(input.to)
      result = await createThread(location, {
        author: actor,
        authorIdentityId: input.authorIdentityId,
        recipient,
        notifyIdentityIds: input.notifyIdentityIds,
        responseIdentityId: input.responseIdentityId,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        inReplyTo: input.inReplyTo,
        responseTo,
        expectsReply: input.expectsReply,
      })
    }
  }

  if (responseTo) {
    const responseRequest = result.thread.messages.find(
      (message) => message.id === responseTo
    )?.responseRequest
    await markThreadDeliveryReplied({
      messageId: responseTo,
      threadId: result.thread.id,
      location: threadLocation(result.thread),
      participantId: actor.id,
      identityId: responseRequest?.identityId,
    })
  }
  const resultLocation = threadLocation(result.thread)
  const activity = result.message.responseRequest
    ? await (async (request) => {
        const target = result.thread.identities.find(
          (identity) => identity.id === request.identityId
        )
        if (!target) {
          throw new ThreadError(
            "FORBIDDEN",
            `Response target is not part of this thread: ${request.identityId}`
          )
        }
        return (
          (await getThreadActivity(
            resultLocation,
            result.thread.id,
            result.message.id,
            request.identityId
          )) ??
          (await queueThreadDelivery({
            messageId: result.message.id,
            threadId: result.thread.id,
            location: resultLocation,
            authorId: actor.id,
            participantId: target.memberId,
            identityId: target.id,
            threadRevision: result.thread.revision,
          }))
        )
      })(result.message.responseRequest)
    : undefined

  const waitSeconds = boundedWaitSeconds(input.waitSeconds)
  if (!result.message.responseRequest || waitSeconds === 0) {
    return {
      threadId: result.thread.id,
      location: resultLocation,
      ...(resultLocation.kind === "space"
        ? { spaceId: resultLocation.spaceId }
        : {}),
      messageId: result.message.id,
      cursor: result.message.sequence,
      createdThread: input.threadId === undefined && result.created,
      activity,
      replies: [],
      timedOut: false,
    }
  }

  const waited = await waitForThreadReply(identity, {
    location: resultLocation,
    threadId: result.thread.id,
    after: result.message.sequence,
    activityRevision:
      activity?.state === "failed" || activity?.state === "replied"
        ? -1
        : activity?.revision,
    waitSeconds,
    messageId: result.message.id,
    onProgress,
  })
  return {
    threadId: result.thread.id,
    location: resultLocation,
    ...(resultLocation.kind === "space"
      ? { spaceId: resultLocation.spaceId }
      : {}),
    messageId: result.message.id,
    cursor: waited.cursor,
    createdThread: input.threadId === undefined && result.created,
    activity: waited.activity ?? activity,
    replies: waited.messages,
    timedOut: waited.timedOut,
  }
}

export async function listThreadParticipants(
  identity?: ThreadIdentity
): Promise<
  Array<ParticipantRef & { defaultIdentityId: string; alwaysOn: boolean }>
> {
  const actorId = identity
    ? (await participantForIdentity(identity)).participant.id
    : undefined
  const [bindings, connections] = await Promise.all([
    listParticipantBindings(),
    listAgentConnections(),
  ])
  const alwaysOnParticipantIds = new Set(
    connections.flatMap((connection) =>
      connection.mode === "always-on" && connection.participant
        ? [connection.participant.id]
        : []
    )
  )
  return bindings
    .map((binding) => binding.participant)
    .filter((participant) => participant.id !== actorId)
    .map((participant) => ({
      ...participant,
      defaultIdentityId: defaultConversationIdentityId(participant.id),
      alwaysOn: alwaysOnParticipantIds.has(participant.id),
    }))
}

export async function listThreadSummaries(
  identity: ThreadIdentity,
  locationInput?: ThreadLocation | string,
  participantId?: string,
  deliveryState?: ThreadDeliveryState
): Promise<ThreadSummary[]> {
  const location = locationInput
    ? normalizeThreadLocation(locationInput)
    : undefined
  if (location?.kind === "space") {
    const space = await readSpace(location.spaceId)
    if (!space.data) {
      throw new ThreadError(
        "THREAD_SPACE_MISMATCH",
        space.error ?? `Space not found: ${location.spaceId}`
      )
    }
  }
  const actor = (await participantForIdentity(identity)).participant
  await reconcileParticipantDeliveries(actor.id)
  const activeSpaceIds = location
    ? undefined
    : new Set(
        (await listSpaces())
          .filter((space) => !getSpaceArchiveInfo(space))
          .map((space) => space.id)
      )
  const threads = (
    location ? await listThreads(location) : (await scanAllThreads()).threads
  ).filter((thread) => {
    const storedLocation = threadLocation(thread)
    return (
      (location !== undefined ||
        storedLocation.kind === "worktable" ||
        activeSpaceIds?.has(storedLocation.spaceId) === true) &&
      (!participantId ||
        thread.members.some((member) => member.id === participantId))
    )
  })
  const summaries = await Promise.all(
    threads.map(async (thread) => ({
      ...summarizeThread(thread),
      activity: await latestThreadSummaryActivity(thread),
    }))
  )
  return deliveryState
    ? summaries.filter((summary) => summary.activity?.state === deliveryState)
    : summaries
}

export async function readThreadMessages(
  identity: ThreadIdentity,
  threadId: string,
  options: {
    location?: ThreadLocation
    /** @deprecated Use location instead. */
    spaceId?: string
    after?: number
    before?: number
  } = {}
): Promise<ThreadReadResult> {
  const thread = await findThread(
    threadId,
    options.location ??
      (options.spaceId
        ? { kind: "space", spaceId: options.spaceId }
        : undefined)
  )
  const actor = (await participantForIdentity(identity)).participant
  await reconcileParticipantDeliveries(actor.id)
  return readResult(
    threadLocation(thread),
    thread.id,
    { after: options.after, before: options.before },
    actor.id
  )
}

export async function readThreadMessage(
  identity: ThreadIdentity,
  input: {
    location?: ThreadLocation
    threadId: string
    messageId: string
  }
) {
  const thread = await findThread(input.threadId, input.location)
  const message = thread.messages.find(
    (candidate) => candidate.id === input.messageId
  )
  if (!message) {
    throw new ThreadError("THREAD_NOT_FOUND", "Message not found")
  }
  return { message }
}

async function threadForManagement(
  identity: ThreadIdentity,
  location: ThreadLocation,
  threadId: string
) {
  const thread = await readThread(location, threadId)
  return {
    thread,
    actor: (await participantForIdentity(identity)).participant,
  }
}

export async function assignResponseRequest(
  identity: ThreadIdentity,
  input: {
    location: ThreadLocation
    threadId: string
    messageId: string
    identityId: string | null
  }
) {
  const { thread, actor } = await threadForManagement(
    identity,
    input.location,
    input.threadId
  )
  const message = thread.messages.find(
    (candidate) => candidate.id === input.messageId
  )
  if (!message) {
    throw new ThreadError("THREAD_NOT_FOUND", "Message not found")
  }
  if (message.authorMemberId !== actor.id && !hasOwnerAuthority(identity)) {
    throw new ThreadError(
      "FORBIDDEN",
      "Only the message author can change its assignment"
    )
  }
  const participantContext =
    input.identityId &&
    !thread.identities.some((candidate) => candidate.id === input.identityId)
      ? await participantContextForUnknownDefaultIdentities(thread, [
          input.identityId,
        ])
      : undefined
  const addedParticipant = participantContext?.participants[0]
  const { thread: updated, replacedIdentityId } = await assignThreadMessage(
    input.location,
    input.threadId,
    input.messageId,
    input.identityId,
    addedParticipant,
    participantContext?.availableParticipants
  )
  const affectedMemberIds = new Set(
    [replacedIdentityId, input.identityId].flatMap((identityId) => {
      const target = updated.identities.find(
        (candidate) => candidate.id === identityId
      )
      return target ? [target.memberId] : []
    })
  )
  await Promise.all(
    [...affectedMemberIds].map((memberId) =>
      reconcileParticipantDeliveries(memberId)
    )
  )
  return updated
}

export async function waitForThreadReply(
  identity: ThreadIdentity,
  input: {
    location?: ThreadLocation
    spaceId?: string
    threadId: string
    after: number
    activityRevision?: number
    waitSeconds?: number
    messageId?: string
    onProgress?: (update: ThreadProgressUpdate) => void | Promise<void>
  }
): Promise<ThreadWaitResult> {
  const preferredLocation =
    input.location ??
    (input.spaceId
      ? { kind: "space" as const, spaceId: input.spaceId }
      : undefined)
  const thread = await findThread(input.threadId, preferredLocation)
  const location = threadLocation(thread)
  const actorId = (await participantForIdentity(identity)).participant.id
  const awaitedMessage = input.messageId
    ? thread.messages.find((message) => message.id === input.messageId)
    : undefined
  if (input.messageId && !awaitedMessage) {
    throw new ThreadError(
      "THREAD_NOT_FOUND",
      `Message not found in thread ${thread.id}: ${input.messageId}`
    )
  }
  let activityIdentityId = awaitedMessage?.responseRequest?.identityId
  await reconcileParticipantDeliveries(actorId)
  const deadline =
    Date.now() +
    boundedWaitSeconds(input.waitSeconds ?? MAX_WAIT_SECONDS) * 1000
  let activityRevision =
    input.activityRevision ??
    (input.messageId
      ? -1
      : ((await latestThreadActivity(location, thread.id))?.revision ?? -1))
  while (true) {
    const signalRevision = threadSignalRevision(location, thread.id)
    const freshThread = await readThread(location, thread.id)
    const freshAwaitedMessage = input.messageId
      ? freshThread.messages.find((message) => message.id === input.messageId)
      : undefined
    const expectedResponseMessages = responseMessages(
      freshThread.messages,
      input.messageId
    )
    const current = awaitedResult(
      await readResult(
        location,
        thread.id,
        { after: input.after },
        actorId,
        freshThread
      ),
      actorId,
      input.after,
      input.messageId,
      expectedResponseMessages
    )
    const replies = current.messages
    const expectedReplyIdentityId =
      freshAwaitedMessage?.responseRequest?.identityId
    if (expectedReplyIdentityId !== activityIdentityId) {
      activityIdentityId = expectedReplyIdentityId
      activityRevision = -1
    }
    const requestedActivities = input.messageId
      ? (await getThreadActivities(location, thread.id)).filter(
          (activity) =>
            activity.messageId === input.messageId &&
            (!expectedReplyIdentityId ||
              activity.identityId === expectedReplyIdentityId)
        )
      : []
    const activity = input.messageId
      ? latestActivity(requestedActivities)
      : await latestThreadActivity(location, thread.id)
    if (replies.length > 0 && !expectedReplyIdentityId) {
      return { ...current, messages: replies, activity, timedOut: false }
    }
    if (input.messageId && expectedReplyIdentityId) {
      if (activity && activity.revision > activityRevision) {
        activityRevision = activity.revision
        await input.onProgress?.({ activity })
      }
      if (
        expectedActivityTerminal(freshAwaitedMessage?.responseRequest, activity)
      ) {
        return {
          ...current,
          messages: replies,
          activity,
          timedOut: false,
        }
      }
    } else if (activity && activity.revision > activityRevision) {
      activityRevision = activity.revision
      await input.onProgress?.({ activity })
      if (activity.state === "failed" || activity.state === "replied") {
        return {
          ...current,
          messages: replies,
          activity,
          timedOut: false,
        }
      }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { ...current, messages: replies, activity, timedOut: true }
    }
    const changed = await waitForThreadSignal(
      location,
      thread.id,
      remaining,
      signalRevision
    )
    if (!changed) {
      const finalThread = await readThread(location, thread.id)
      const final = awaitedResult(
        await readResult(
          location,
          thread.id,
          { after: input.after },
          actorId,
          finalThread
        ),
        actorId,
        input.after,
        input.messageId,
        responseMessages(finalThread.messages, input.messageId)
      )
      const finalExpectedReplyIdentityId = input.messageId
        ? finalThread.messages.find((message) => message.id === input.messageId)
            ?.responseRequest?.identityId
        : undefined
      const finalActivities = input.messageId
        ? (await getThreadActivities(location, thread.id)).filter(
            (activity) =>
              activity.messageId === input.messageId &&
              (!finalExpectedReplyIdentityId ||
                activity.identityId === finalExpectedReplyIdentityId)
          )
        : []
      return {
        ...final,
        activity: input.messageId
          ? latestActivity(finalActivities)
          : await latestThreadActivity(location, thread.id),
        timedOut: true,
      }
    }
  }
}

async function reconcileParticipantDeliveries(
  participantId: string
): Promise<void> {
  const deliveries: ReconcileThreadDeliveryInput[] = []
  const scan = await scanAllThreads()
  for (const thread of scan.threads) {
    const location = threadLocation(thread)
    for (const message of thread.messages) {
      const responseRequest = message.responseRequest
      if (!responseRequest || responseRequest.status === "withdrawn") continue
      const targetIdentity = thread.identities.find(
        (candidate) => candidate.id === responseRequest.identityId
      )
      if (targetIdentity?.memberId !== participantId) continue
      const reply = thread.messages.find(
        (candidate) => candidate.id === responseRequest.respondedBy
      )
      deliveries.push({
        messageId: message.id,
        threadId: thread.id,
        location,
        authorId: message.authorMemberId,
        participantId,
        identityId: responseRequest.identityId,
        replied: Boolean(reply),
        createdAt: message.createdAt,
        repliedAt: reply?.createdAt,
        threadRevision: thread.revision,
      })
    }
  }
  await reconcileThreadDeliveries(participantId, deliveries, {
    retireMissing: scan.complete,
    threads: scan.threads.map((thread) => ({
      threadId: thread.id,
      location: threadLocation(thread),
      revision: thread.revision,
    })),
  })
}

export async function claimNextThreadDelivery(
  identity: ThreadIdentity,
  waitSeconds = MAX_WAIT_SECONDS,
  supportedThreadLocationVersion?: 2
): Promise<
  | (ClaimedDelivery & {
      thread: ThreadReadResult["thread"]
      message: ThreadReadResult["messages"][number]
    })
  | null
> {
  const { participant, threadLocationVersion } = await resolveParticipant(
    identity,
    {
      threadLocationVersion: supportedThreadLocationVersion,
    }
  )
  await reconcileParticipantDeliveries(participant.id)
  const deadline = Date.now() + boundedWaitSeconds(waitSeconds) * 1000
  while (true) {
    const signalRevision = inboxSignalRevision(participant.id)
    const allowWorktable = threadLocationVersion === 2
    const claim = await claimThreadDelivery(participant.id, { allowWorktable })
    if (claim) {
      let thread: Awaited<ReturnType<typeof readThread>>
      try {
        thread = await readThread(claim.location, claim.threadId)
      } catch (error) {
        if (
          error instanceof ThreadError &&
          (error.code === "THREAD_NOT_FOUND" ||
            error.code === "THREAD_SPACE_MISMATCH")
        ) {
          await failThreadDelivery({
            messageId: claim.messageId,
            leaseId: claim.leaseId,
            participantId: participant.id,
            retryable: false,
            code: "THREAD_NOT_FOUND",
            message: "The portable thread for this delivery no longer exists.",
          })
          continue
        }
        throw error
      }
      const message = thread.messages.find(
        (candidate) => candidate.id === claim.messageId
      )
      if (!message) {
        await failThreadDelivery({
          messageId: claim.messageId,
          leaseId: claim.leaseId,
          participantId: participant.id,
          retryable: false,
          code: "THREAD_NOT_FOUND",
          message: "The portable message for this delivery no longer exists.",
        })
        continue
      }
      const responseRequest = message.responseRequest
      const targetIdentity = thread.identities.find(
        (candidate) => candidate.id === claim.identityId
      )
      const targetMember = targetIdentity
        ? thread.members.find(
            (candidate) => candidate.id === targetIdentity.memberId
          )
        : undefined
      if (
        responseRequest?.status !== "open" ||
        responseRequest.identityId !== claim.identityId ||
        targetIdentity?.memberId !== participant.id ||
        targetIdentity.status !== "active" ||
        !targetMember
      ) {
        await failThreadDelivery({
          messageId: claim.messageId,
          leaseId: claim.leaseId,
          participantId: participant.id,
          canonicalThreadRevision: thread.revision,
          retryable: false,
          code: "DELIVERY_RETIRED",
          message: "This message is no longer assigned to this identity.",
        })
        continue
      }
      return { ...claim, thread, message }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return null
    const eligibleAt = await nextThreadDeliveryEligibleAt(participant.id, {
      allowWorktable,
    })
    if (eligibleAt !== undefined && eligibleAt <= Date.now()) continue
    const waitMs = Math.min(
      remaining,
      eligibleAt === undefined ? remaining : eligibleAt - Date.now()
    )
    const changed = await waitForInboxSignal(
      participant.id,
      waitMs,
      signalRevision
    )
    if (!changed && waitMs >= remaining) return null
    if (changed) {
      await reconcileParticipantDeliveries(participant.id)
    }
  }
}

async function deliveryActor(identity: ThreadIdentity): Promise<string> {
  return (await participantForIdentity(identity)).participant.id
}

export async function acceptDelivery(
  identity: ThreadIdentity,
  messageId: string,
  leaseId: string
) {
  return acceptThreadDelivery({
    messageId,
    leaseId,
    participantId: await deliveryActor(identity),
  })
}

export async function progressDelivery(
  identity: ThreadIdentity,
  input: {
    messageId: string
    leaseId: string
    phase: "working" | "receiving"
    receivedCharacters?: number
  }
) {
  return progressThreadDelivery({
    ...input,
    participantId: await deliveryActor(identity),
  })
}

export async function failDelivery(
  identity: ThreadIdentity,
  input: {
    messageId: string
    leaseId: string
    retryable: boolean
    code: string
    message: string
  }
) {
  return failThreadDelivery({
    ...input,
    participantId: await deliveryActor(identity),
  })
}
