import { isWorkspaceDraining } from "./workspace-request-lifecycle.ts"
import { grokBotPolicy, observeGrokBotCandidate, readGrokBots } from "./grok-bot-store.ts"
import { currentTeamWorktable, requireTeamDatabase } from "./team-database.ts"
import { findTeamMemberById, listTeamMembers } from "./team-members.ts"
import { identityForTeamMember } from "./team-identity.ts"
import { agentWorktableThreadAccess, canAccessSpace, canAccessWorktableThreads, resolveTeamAgentCredential, TeamAccessError, teamAgentHasSpaceAccess } from "./team-policy.ts"
import { currentActivityActor, recordActivity } from "./activity-log.ts"
import type {
  AgentPlatformId,
  ParticipantRef,
  SpaceFile,
  Thread,
  ThreadActivity,
  ThreadDeliveryState,
  ThreadLocation,
  ThreadMessage,
  ThreadPostResult,
  ThreadReadResult,
  ThreadSummary,
  ThreadWaitResult,
} from "@worktable/types"
import {
  defaultConversationIdentityId,
  threadLocation,
  threadLocationKey,
  ThreadTitleSchema,
  type ThreadRenameResult,
} from "@worktable/types"
import { hasScope, listTokens, type TokenIdentity } from "./token-store.ts"
import { getAppDir } from "./app-storage.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { hasWorkspaceOwnerAuthority } from "./owner-authority.ts"
import {
  acceptThreadDelivery,
  claimThreadDelivery,
  commitThreadDeliveryReply,
  failThreadDelivery,
  getThreadActivities,
  getThreadActivity,
  latestThreadActivity,
  markThreadDeliveryReplied,
  nextThreadDeliveryEligibleAt,
  progressThreadDelivery,
  queueThreadDelivery,
  readThreadActivities,
  reconcileThreadDeliveries,
  requireThreadDeliveryLease,
  requiresManagedDeliveryLease,
  ThreadDeliveryError,
  type ReconcileThreadDeliveryInput,
  type ClaimedDelivery,
  type ThreadActivityLookup,
} from "./thread-delivery-store.ts"
import {
  appendThreadMessage,
  assignThreadMessage,
  createThread,
  findThreadAppendRetry,
  findThreadCreationRetry,
  findThread,
  normalizeThreadLocation,
  readThread,
  renameThread,
  scanAllThreadDigests,
  scanThreadDigests,
  ThreadError,
  type ThreadDigest,
  type ThreadDigestScan,
  type ThreadRequestDigest,
} from "./thread-store.ts"
import {
  listParticipantBindings,
  participantKey,
  participantsByKey,
  requireParticipant,
  resolveParticipant,
} from "./participant-store.ts"
import { getSpaceArchiveInfo, listSpaces, readSpace } from "./store.ts"
import {
  listAgentConnections,
  signInPresentations,
} from "./agent-connection-store.ts"
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
  title?: string
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

async function assertCurrentThreadRecipients(
  location: ThreadLocation,
  actorId: string,
  recipient: ParticipantRef | undefined,
  input: Pick<
    PostThreadInput,
    "notifyIdentityIds" | "responseIdentityId" | "expectsReply" | "responseTo"
  >,
  thread?: ThreadReadResult["thread"]
): Promise<void> {
  if (!currentTeamWorktable()) return
  const available = await listThreadParticipants(undefined, location, false)
  const eligible = new Set([
    actorId,
    ...available.map((participant) => participant.id),
  ])
  const byIdentity = new Map(
    available.map((participant) => [
      defaultConversationIdentityId(participant.id),
      participant.id,
    ])
  )
  const memberForIdentity = (id: string) =>
    thread?.identities.find((identity) => identity.id === id)?.memberId ??
    byIdentity.get(id)
  const addressed = [
    ...(recipient ? [recipient.id] : []),
    ...[
      ...(input.notifyIdentityIds ?? []),
      ...(input.responseIdentityId ? [input.responseIdentityId] : []),
    ].map(memberForIdentity),
  ]
  if (addressed.some((id) => !id || !eligible.has(id)))
    throw new ThreadError(
      "FORBIDDEN",
      "Choose a recipient who can read and reply in this location"
    )
  const requested = [
    ...(recipient && input.expectsReply !== false && !input.responseTo
      ? [recipient.id]
      : []),
    ...(input.responseIdentityId
      ? [memberForIdentity(input.responseIdentityId)]
      : []),
  ]
  if (requested.length) {
    const respondents = new Set([
      actorId,
      ...(await listThreadParticipants(undefined, location)).map(
        (participant) => participant.id
      ),
    ])
    if (requested.some((id) => !id || !respondents.has(id)))
      throw new ThreadError(
        "FORBIDDEN",
        "Choose a recipient who can reply in this location"
      )
  }
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

  const availableParticipants = currentTeamWorktable()
    ? await listThreadParticipants(undefined, threadLocation(thread), false)
    : (await listParticipantBindings()).map(
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

function latestThreadSummaryActivity(
  threadRequests: ThreadRequestDigest[],
  activities: ThreadActivity[]
): ThreadActivity | undefined {
  if (activities.length === 0) return undefined
  const requests = new Map(
    threadRequests.map((request) => [
      request.messageId,
      request.responseRequest,
    ])
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
  return (await postThreadMessageWithStored(identity, input, onProgress)).result
}

/**
 * Post a message and also return it as stored, so the browser can show its own
 * message without reading the thread again. Agents keep the result shape above.
 */
export async function postThreadMessageWithStored(
  identity: ThreadIdentity,
  input: PostThreadInput,
  onProgress?: (update: ThreadProgressUpdate) => void | Promise<void>
): Promise<{ result: ThreadPostResult; message: ThreadMessage }> {
  if (input.title !== undefined) {
    if (input.threadId) {
      throw new ThreadError(
        "FORBIDDEN",
        "Use the rename action to name an existing thread"
      )
    }
    input = { ...input, title: ThreadTitleSchema.parse(input.title) }
  }
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
      if (
        !responseTo &&
        input.inReplyTo &&
        (await requiresManagedDeliveryLease({
          participantId: actor.id,
          messageId: input.inReplyTo,
          threadId: existing.id,
          location,
        }))
      ) {
        throw new ThreadDeliveryError(
          "LEASE_LOST",
          "Grok Bot replies must name the assignment in responseTo and include its current lease"
        )
      }
      const grok = responseTo ? await grokBotPolicy(actor.id) : undefined
      if (grok && grok.principalId !== identity.principal.id) {
        throw new ThreadError(
          "FORBIDDEN",
          "This Grok Bot connection belongs to a different authenticated principal"
        )
      }
      const managedReply =
        responseTo &&
        (await requiresManagedDeliveryLease({
          participantId: actor.id,
          messageId: responseTo,
          threadId: existing.id,
          location,
        }))
      if (managedReply && !input.deliveryLeaseId) {
        throw new ThreadDeliveryError(
          "LEASE_LOST",
          "Grok Bot replies require the current delivery lease"
        )
      }
      if (input.deliveryLeaseId && responseTo && !managedReply) {
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
      const replyLocation = location
      const append = async () => {
        await assertCurrentThreadRecipients(
          replyLocation,
          actor.id,
          recipient,
          input,
          existing
        )
        return appendThreadMessage(replyLocation, existing.id, {
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
      result =
        managedReply && responseTo && input.deliveryLeaseId
          ? await commitThreadDeliveryReply(
              {
                location,
                threadId: existing.id,
                messageId: responseTo,
                identityId: selectedAuthorIdentityId,
                participantId: actor.id,
                leaseId: input.deliveryLeaseId,
              },
              append,
              async () =>
                findThreadAppendRetry(
                  await findThread(existing.id, replyLocation),
                  { ...input, responseTo, author: actor }
                )
            )
          : await append()
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
      title: input.title,
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
      await assertCurrentThreadRecipients(location, actor.id, recipient, input)
      result = await createThread(location, {
        title: input.title,
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
  // Replays, including one that lost a race for the thread lock, created
  // nothing new.
  if (result.created) {
    recordActivity({
      spaceId:
        resultLocation.kind === "space" ? resultLocation.spaceId : null,
      action: input.threadId ? "thread.replied" : "thread.started",
      actor: currentActivityActor() ?? {
        kind: actor.kind === "human" ? "person" : actor.kind,
        id: actor.id,
        name: actor.name,
      },
      target: {
        kind: "thread",
        threadId: result.thread.id,
        title: result.thread.title,
      },
      ...(!input.threadId || result.message.responseRequest
        ? { quote: result.message.body }
        : {}),
    })
  }
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
      result: {
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
      },
      message: result.message,
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
    result: {
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
    },
    message: result.message,
  }
}

export async function listThreadParticipants(
  identity?: ThreadIdentity,
  location?: ThreadLocation,
  replyRequired = true
): Promise<
  Array<ParticipantRef & { defaultIdentityId: string; alwaysOn: boolean }>
> {
  const actorId = identity
    ? (await participantForIdentity(identity)).participant.id
    : undefined
  const grokIds = new Set((await readGrokBots()).filter((c) => c.enabled && c.verifiedAt).map((c) => c.participantId))
  const team = currentTeamWorktable()
  if (team) {
    const humans = await Promise.all(
      listTeamMembers()
        .filter(
          (member) =>
            location?.kind !== "space" ||
            canAccessSpace(
              location.spaceId,
              replyRequired ? "edit" : "read",
              identityForTeamMember(member)
            )
        )
        .map((member) =>
          resolveParticipant(identityForTeamMember(member), {
            initialName: member.name,
          })
        )
    )
    const agents = requireTeamDatabase()
      .query<
        {
          participant_key: string
          id: string
          actor_id: string
          name: string
          platform: string
          space_ids: string | null
          member_id: string | null
          ownership: string
          scope_ceiling: string | null
          mode: string
          worktable_threads: "none" | "read" | "edit"
        },
        [string]
      >(
        "SELECT a.* FROM wt_agents a WHERE a.worktable_id = ? AND a.active = 1 AND EXISTS (SELECT 1 FROM wt_agent_credentials c WHERE c.agent_id = a.id AND c.active = 1)"
      )
      .all(team.id)
      .filter(
        (agent) =>
          agent.ownership === "team" ||
          (agent.member_id && findTeamMemberById(agent.member_id))
      )
    const tokens = await listTokens()
    const credentials = requireTeamDatabase()
      .query<
        {
          credential_key: string
          agent_id: string
          sponsor_member_id: string | null
        },
        []
      >("SELECT credential_key, agent_id, sponsor_member_id FROM wt_agent_credentials WHERE active = 1")
      .all()
    const eligibleAgents = agents.filter((agent) => {
      // The unscoped list serves composers in every location; only an
      // explicit Worktable thread applies the Worktable-thread grant.
      if (location?.kind === "worktable") {
        const level = agentWorktableThreadAccess({
          ownership: agent.ownership as "team" | "personal",
          spaceIds:
            agent.space_ids === null ? null : JSON.parse(agent.space_ids),
          worktableThreads: agent.worktable_threads,
        })
        if (level === "none" || (replyRequired && level !== "edit"))
          return false
      }
      if (
        location?.kind === "space" &&
        !teamAgentHasSpaceAccess(
          {
            id: agent.id,
            ownership: agent.ownership as "team" | "personal",
            memberId: agent.member_id,
            spaceIds:
              agent.space_ids === null ? null : JSON.parse(agent.space_ids),
          },
          location.spaceId,
          replyRequired ? "edit" : "read"
        )
      )
        return false
      const bound = credentials.filter(
        (credential) =>
          credential.agent_id === agent.id &&
          (!credential.sponsor_member_id ||
            findTeamMemberById(credential.sponsor_member_id))
      )
      const keys = new Set(bound.map((credential) => credential.credential_key))
      const local = tokens.some((token) => {
        if (
          token.revokedAt ||
          token.workspace !== getWorkspaceRoot() ||
          !keys.has(token.principal.id)
        )
          return false
        const resolved = resolveTeamAgentCredential(token)
        return (
          resolved &&
          hasScope(resolved.scopes, "threads:read") &&
          (!replyRequired || hasScope(resolved.scopes, "threads:write"))
        )
      })
      const ceiling: string[] | null =
        agent.scope_ceiling === null ? null : JSON.parse(agent.scope_ceiling)
      return (
        local ||
        Boolean(
          ceiling &&
          hasScope(ceiling, "threads:read") &&
          (!replyRequired || hasScope(ceiling, "threads:write")) &&
          bound.some((credential) =>
            /^(oauth:|workos-agent:)/.test(credential.credential_key)
          )
        )
      )
    })
    await Promise.all(
      eligibleAgents.map((agent) =>
        resolveParticipant({
          agent: agent.platform,
          principal: {
            id: agent.actor_id,
            type: "agent",
            displayName: agent.name,
            participantKey: agent.participant_key,
          },
        })
      )
    )
    const alwaysOnKeys = new Set(
      eligibleAgents
        .filter((agent) => agent.mode === "always-on")
        .map((agent) => agent.participant_key)
    )
    const byKey = await participantsByKey()
    const alwaysOnIds = new Set(
      [...byKey]
        .filter(([key]) => alwaysOnKeys.has(key))
        .map(([, participant]) => participant.id)
    )
    const agentKeys = new Set(
      eligibleAgents.map((agent) => agent.participant_key)
    )
    const members = [
      ...humans.map((binding) => binding.participant),
      ...[...byKey]
        .filter(([key]) => agentKeys.has(key))
        .map(([, participant]) => participant),
    ]
    return members
      .filter((participant) => participant.id !== actorId)
      .map((participant) => ({
        ...participant,
        defaultIdentityId: defaultConversationIdentityId(participant.id),
        alwaysOn: alwaysOnIds.has(participant.id) || grokIds.has(participant.id),
      }))
  }
  const [bindings, connections, tokens, participants, signIns] =
    await Promise.all([
      listParticipantBindings(),
      listAgentConnections(),
      listTokens(),
      participantsByKey(),
      signInPresentations(),
    ])
  const alwaysOnParticipantIds = new Set(
    connections.flatMap((connection) =>
      connection.mode === "always-on" && connection.participant
        ? [connection.participant.id]
        : []
    )
  )
  // An agent none of whose credentials has Threads (read and reply) cannot
  // take part in one, so it is not offered.
  const workspace = getWorkspaceRoot()
  const readsThreads = new Map<string, boolean>()
  for (const token of tokens) {
    if (!token.agent || token.revokedAt || token.workspace !== workspace) {
      continue
    }
    const participant = participants.get(
      participantKey({ agent: token.agent, principal: token.principal })
    )
    if (!participant) continue
    readsThreads.set(
      participant.id,
      readsThreads.get(participant.id) === true ||
        (hasScope(token.scopes, "threads:read") &&
          hasScope(token.scopes, "threads:write"))
    )
  }
  // A sign-in agent on Cloud whose owner took Threads away, likewise.
  for (const [key, signIn] of signIns) {
    const participant = participants.get(key)
    if (participant && signIn.threads === false) {
      readsThreads.set(participant.id, false)
    }
  }
  const withoutThreads = new Set(
    [...readsThreads].flatMap(([id, reads]) => (reads ? [] : [id]))
  )
  return bindings
    .map((binding) => binding.participant)
    .filter(
      (participant) =>
        participant.id !== actorId && !withoutThreads.has(participant.id)
    )
    .map((participant) => ({
      ...participant,
      defaultIdentityId: defaultConversationIdentityId(participant.id),
      alwaysOn: alwaysOnParticipantIds.has(participant.id) || grokIds.has(participant.id),
    }))
}

/** A person's saved identity, or an agent's name, platform, and chosen icon. */

export interface ParticipantPresentation {
  id?: string
  /** The Threads participant, also under the principal IDs it writes with. */
  participantId?: string
  name?: string
  platform?: AgentPlatformId
  icon?: string | null
}

/**
 * Current identities as the web app shows them. Agents also carry their
 * platform and chosen icon, including when no longer offered as recipients.
 * Principal IDs alias the same identity for activity and document contributors.
 */
export async function listThreadParticipantsForDisplay(
  identity?: ThreadIdentity,
  location?: ThreadLocation
): Promise<{
  participants: Array<
    ParticipantRef & {
      defaultIdentityId: string
      alwaysOn: boolean
    } & ParticipantPresentation
  >
  presentations: Record<string, ParticipantPresentation>
}> {
  const participants = await listThreadParticipants(identity, location)
  const presentations = await buildParticipantPresentations()
  return {
    participants: participants.map((participant) => ({
      ...participant,
      ...presentations[participant.id],
    })),
    presentations,
  }
}

// Display metadata reads only identity/configuration files, never portable
// Threads. Carry one cached copy with boot/workspace so avatars need no request.
type DisplayPresentations = Record<string, ParticipantPresentation>
let displayCache:
  | { key: string; readers: Map<string, Promise<DisplayPresentations>> }
  | undefined
onWorkspaceChange((event) => {
  if (event.type === "participants" || event.type === "workspaceReset") displayCache = undefined
})

export function cachedParticipantPresentations(readerKey: string, policyRevision = 0): Promise<DisplayPresentations> {
  const key = `${getAppDir()}\0${getWorkspaceRoot()}\0${policyRevision}`
  if (displayCache?.key !== key) displayCache = { key, readers: new Map() }
  let value = displayCache.readers.get(readerKey)
  if (!value) {
    const cache = displayCache
    const pending: Promise<DisplayPresentations> = buildParticipantPresentations().catch(() => {
      if (cache.readers.get(readerKey) === pending) cache.readers.delete(readerKey)
      return {}
    })
    value = pending
    cache.readers.set(readerKey, value)
  }
  return value
}

async function buildParticipantPresentations(): Promise<Record<string, ParticipantPresentation>> {
  const connections = await listAgentConnections()
  const presentations: Record<string, ParticipantPresentation> =
    Object.fromEntries(
      connections.flatMap((connection) =>
        connection.participant
          ? [
              [
                connection.participant.id,
                {
                  name: connection.displayName,
                  platform: connection.platform,
                  icon: connection.icon,
                },
              ],
            ]
          : []
      )
    )
  // Sign-in agents (Claude, ChatGPT on Cloud) carry what their owner chose.
  const [bindings, signIns, tokens] = await Promise.all([
    participantsByKey(),
    signInPresentations(),
    listTokens(),
  ])
  for (const [key, signIn] of signIns) {
    const participant = bindings.get(key)
    if (!participant || presentations[participant.id]) continue
    presentations[participant.id] = {
      name: participant.name,
      ...(signIn.platform ? { platform: signIn.platform } : {}),
      icon: signIn.icon ?? null,
    }
  }
  for (const grok of await readGrokBots()) {
    const participant = bindings.get(grok.participantKey)
    presentations[grok.participantId] = {
      ...presentations[grok.participantId],
      ...(participant ? { name: participant.name } : {}),
      platform: "grok-bot",
    }
    presentations[grok.principalId] = presentations[grok.participantId]!
  }
  for (const [key, participant] of bindings) {
    if (participant.kind === "human") {
      presentations[participant.id] = {
        id: participant.id,
        name: participant.name,
      }
    } else if (participant.kind === "agent" && key.startsWith("principal:")) {
      // A Teams agent writes as its actor, which no connection lists.
      presentations[participant.id] ??= { name: participant.name }
    }
    const presentation = presentations[participant.id]
    if (presentation && participant.kind !== "system") {
      presentation.participantId = participant.id
    }
    if (key.startsWith("principal:") && presentation) {
      presentations[key.slice("principal:".length)] = presentation
    }
  }
  // Activity records credential principals, while Threads use participant IDs.
  // Include rotated credentials so earlier edits retain the agent's avatar.
  for (const token of tokens) {
    if (token.workspace !== getWorkspaceRoot()) continue
    const participant = bindings.get(
      participantKey({ agent: token.agent, principal: token.principal })
    )
    const presentation = participant && presentations[participant.id]
    if (participant?.kind === "agent" && presentation) {
      presentations[`local-token:${token.id}`] = presentation
    }
  }
  return presentations
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
  // One scan of the threads and one read of the delivery state serve both
  // delivery reconciliation and the list.
  const spaces = await listSpaces()
  const scan = await scanAllThreadDigests(spaces)
  const activities = await reconcileParticipantDeliveries(actor.id, scan)
  const activeSpaceIds = new Set(
    spaces
      .filter((space) => !getSpaceArchiveInfo(space))
      .map((space) => space.id)
  )
  const locationKey = location ? threadLocationKey(location) : undefined
  const threads = scan.threads.filter(({ summary }) => {
    const storedLocation = summary.location
    return (
      (locationKey !== undefined
        ? threadLocationKey(storedLocation) === locationKey
        : storedLocation.kind === "worktable" ||
          activeSpaceIds.has(storedLocation.spaceId)) &&
      (!participantId ||
        summary.members.some((member) => member.id === participantId))
    )
  })
  const summaries = threads.map(({ summary, requests }) => ({
    ...summary,
    activity: latestThreadSummaryActivity(
      requests,
      activities(summary.location, summary.id)
    ),
  }))
  return deliveryState
    ? summaries.filter((summary) => summary.activity?.state === deliveryState)
    : summaries
}

export interface ViewerThreadRequest {
  location: ThreadLocation
  threadId: string
  threadTitle: string
  message: Thread["messages"][number]
  author: { kind: ParticipantRef["kind"]; id: string; name: string }
}

export interface ViewerDeliveryFailure {
  location: ThreadLocation
  threadId: string
  threadTitle: string
  activity: ThreadActivity
  recipientName?: string
}

/**
 * What in the threads waits on the reader, from one scan: reply requests
 * addressed to them that are still open, and their messages whose delivery
 * failed while the reply request is still open. Every failed request counts,
 * not only each thread's latest.
 *
 * Covers everything outside archived Spaces, or exactly the named Space,
 * archived or not. `spaces` is the current Space list.
 */
export async function listPendingThreadWork(
  identity: ThreadIdentity,
  spaces: SpaceFile[],
  spaceId?: string
): Promise<{
  requests: ViewerThreadRequest[]
  failures: ViewerDeliveryFailure[]
}> {
  const viewer = (await participantForIdentity(identity)).participant
  const activeSpaceIds = new Set(
    spaces
      .filter((space) => !getSpaceArchiveInfo(space))
      .map((space) => space.id)
  )
  const inScope = (location: ThreadLocation) =>
    spaceId
      ? location.kind === "space" && location.spaceId === spaceId
      : location.kind !== "space" || activeSpaceIds.has(location.spaceId)
  const { threads } = !spaceId
    ? await scanAllThreadDigests(spaces)
    : spaces.some((space) => space.id === spaceId)
      ? await scanThreadDigests(spaceId)
      : { threads: [] }
  const scoped = threads.filter(({ summary }) => inScope(summary.location))
  const requests = scoped.flatMap((thread) =>
    openRequestsForViewer(thread, viewer.id)
  )
  const awaitingReply = scoped.flatMap(({ summary, requests }) => {
    const open = new Map(
      requests.flatMap((request) =>
        request.authorMemberId === viewer.id &&
        request.responseRequest.status === "open"
          ? [[request.messageId, request.responseRequest.identityId] as const]
          : []
      )
    )
    return open.size > 0 ? [{ thread: summary, open }] : []
  })
  if (awaitingReply.length === 0) return { requests, failures: [] }
  const activities = await readThreadActivities()
  const failures = awaitingReply.flatMap(({ thread, open }) =>
    failedDeliveries(thread, open, activities(thread.location, thread.id))
  )
  return { requests, failures }
}

function openRequestsForViewer(
  { summary: thread, requests }: ThreadDigest,
  viewerId: string
): ViewerThreadRequest[] {
  const location = thread.location
  const mine = new Set(
    thread.identities
      .filter((candidate) => candidate.memberId === viewerId)
      .map((candidate) => candidate.id)
  )
  return requests.flatMap(({ openMessage: message, responseRequest }) => {
    if (!message || !mine.has(responseRequest.identityId)) return []
    const member = thread.members.find(
      (candidate) => candidate.id === message.authorMemberId
    )
    const authorIdentity = thread.identities.find(
      (candidate) => candidate.id === message.authorIdentityId
    )
    return [
      {
        location,
        threadId: thread.id,
        threadTitle: thread.title,
        message,
        author: {
          kind: member?.kind ?? "agent",
          id: message.authorMemberId,
          name: authorIdentity?.name ?? member?.name ?? "Someone",
        },
      },
    ]
  })
}

/** Failed deliveries of the viewer's messages whose reply request is open. */
function failedDeliveries(
  thread: ThreadSummary,
  openRequests: Map<string, string>,
  activities: ThreadActivity[]
): ViewerDeliveryFailure[] {
  const location = thread.location
  return activities.flatMap((activity) => {
    if (
      activity.state !== "failed" ||
      openRequests.get(activity.messageId) !== activity.identityId
    ) {
      return []
    }
    const recipientName =
      thread.identities.find(
        (candidate) => candidate.id === activity.identityId
      )?.name ??
      thread.members.find((member) => member.id === activity.participantId)
        ?.name
    return [
      {
        location,
        threadId: thread.id,
        threadTitle: thread.title,
        activity,
        ...(recipientName ? { recipientName } : {}),
      },
    ]
  })
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
    actor.id,
    thread
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

export async function renameThreadTitle(input: {
  location: ThreadLocation
  threadId: string
  title: string
  expectedTitle?: string
  onlyIfAutomatic?: boolean
}): Promise<ThreadRenameResult> {
  const thread = await renameThread(input.location, input.threadId, input)
  return {
    threadId: thread.id,
    title: thread.title,
    revision: thread.revision,
    updatedAt: thread.updatedAt,
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
  if (input.identityId) await assertCurrentThreadRecipients(input.location, actor.id, undefined, {responseIdentityId: input.identityId}, thread)
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

/**
 * Bring a participant's delivery state in line with the thread files. When
 * neither a thread file nor the delivery state changed since the last time,
 * this takes no lock and writes nothing.
 */
export async function reconcileParticipantDeliveries(
  participantId: string,
  knownScan?: ThreadDigestScan
): Promise<ThreadActivityLookup> {
  const deliveries: ReconcileThreadDeliveryInput[] = []
  const scan = knownScan ?? (await scanAllThreadDigests())
  for (const { summary: thread, requests } of scan.threads) {
    for (const request of requests) {
      const responseRequest = request.responseRequest
      if (responseRequest.status === "withdrawn") continue
      const targetIdentity = thread.identities.find(
        (candidate) => candidate.id === responseRequest.identityId
      )
      if (targetIdentity?.memberId !== participantId) continue
      deliveries.push({
        messageId: request.messageId,
        threadId: thread.id,
        location: thread.location,
        authorId: request.authorMemberId,
        participantId,
        identityId: responseRequest.identityId,
        replied: request.repliedAt !== undefined,
        createdAt: request.createdAt,
        repliedAt: request.repliedAt,
        threadRevision: thread.revision,
      })
    }
  }
  return reconcileThreadDeliveries(participantId, deliveries, {
    retireMissing: scan.complete,
    scannedLocations: scan.locations,
    threads: scan.threads.map(({ summary: thread }) => ({
      threadId: thread.id,
      location: thread.location,
      revision: thread.revision,
    })),
    sourceStamp: scan.stamp,
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
  await observeGrokBotCandidate(identity, participant)
  const grok = await grokBotPolicy(participant.id)
  if (grok && grok.principalId !== identity.principal.id) return null
  // Read the signal revision before reconciling: a portable edit that lands
  // while reconciliation scans the old file must still wake this wait.
  let signalRevision = inboxSignalRevision(participant.id)
  await reconcileParticipantDeliveries(participant.id)
  const deadline = Date.now() + boundedWaitSeconds(waitSeconds) * 1000
  // Requests in threads this identity cannot currently reply in stay queued;
  // they arrive if access returns.
  const isDeliverable = (location: ThreadLocation) =>
    location.kind === "space"
      ? canAccessSpace(location.spaceId, "edit")
      : canAccessWorktableThreads("edit")
  while (true) {
    const allowWorktable = threadLocationVersion === 2
    const claim = await claimThreadDelivery(participant.id, {
      allowWorktable,
      isDeliverable,
      authenticatedPrincipalId: identity.principal.id,
    })
    if (claim) {
      let thread: Awaited<ReturnType<typeof readThread>>
      try {
        thread = await readThread(claim.location, claim.threadId)
      } catch (error) {
        if (error instanceof TeamAccessError) {
          // Access changed after the claim; release it to wait for access.
          await failThreadDelivery({
            messageId: claim.messageId,
            leaseId: claim.leaseId,
            participantId: participant.id,
            retryable: true,
            spendAttempt: false,
            code: "ACCESS_CHANGED",
            message: "Access to this thread changed while it was being delivered.",
          })
          continue
        }
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
      isDeliverable,
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
    if (!changed && (waitMs >= remaining || isWorkspaceDraining())) return null
    if (changed) {
      signalRevision = inboxSignalRevision(participant.id)
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
