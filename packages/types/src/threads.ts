import { z } from "zod"

export const THREAD_IDENTITY_NAME_MAX_LENGTH = 120

export const ParticipantKindSchema = z.enum(["human", "agent", "system"])
export const ThreadLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worktable") }),
  z.object({
    kind: z.literal("space"),
    spaceId: z.string().min(1),
  }),
])
export const ThreadMessageIdSchema = z
  .string()
  .regex(/^msg_[A-Za-z0-9_-]{12,}$/)
export const ConversationIdentityIdSchema = z
  .string()
  .regex(/^idt_[A-Za-z0-9_-]{12,}$/)

export function threadBodyMentionsIdentity(
  body: string,
  identityName: string
): boolean {
  const escapedName = identityName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_@])@${escapedName}(?=$|[^\\p{L}\\p{N}_])`,
    "iu"
  ).test(body)
}

export const ParticipantRefSchema = z.object({
  id: z.string().regex(/^ptc_[A-Za-z0-9_-]{12,}$/),
  kind: ParticipantKindSchema,
  name: z.string().trim().min(1).max(THREAD_IDENTITY_NAME_MAX_LENGTH),
  identityFingerprint: z
    .string()
    .regex(/^pid_[A-Za-z0-9_-]{43}$/)
    .optional(),
})

export const LegacyThreadMessageSchema = z.object({
  id: ThreadMessageIdSchema,
  sequence: z.number().int().positive(),
  authorId: z.string().regex(/^ptc_[A-Za-z0-9_-]{12,}$/),
  recipientIds: z
    .array(z.string().regex(/^ptc_[A-Za-z0-9_-]{12,}$/))
    .min(1)
    .max(1),
  body: z.string().min(1).max(100_000),
  inReplyTo: ThreadMessageIdSchema.optional(),
  expectsReply: z.boolean(),
  idempotencyKey: z.string().trim().min(1).max(200),
  createdAt: z.string(),
})
/** @deprecated V1/V2 compatibility schema. */
export const ThreadMessageSchema = LegacyThreadMessageSchema

export const ThreadMemberSchema = ParticipantRefSchema.extend({
  addedAt: z.string(),
})

export const ConversationIdentitySchema = z
  .object({
    id: ConversationIdentityIdSchema,
    memberId: z.string().regex(/^ptc_[A-Za-z0-9_-]{12,}$/),
    name: z.string().trim().min(1).max(THREAD_IDENTITY_NAME_MAX_LENGTH),
    default: z.boolean(),
    status: z.enum(["active", "inactive"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()

export const ThreadResponseRequestSchema = z
  .object({
    identityId: ConversationIdentityIdSchema,
    status: z.enum(["open", "responded", "withdrawn"]),
    respondedBy: ThreadMessageIdSchema.optional(),
    resolvedAt: z.string().optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.status === "responded" && !request.respondedBy) {
      ctx.addIssue({
        code: "custom",
        path: ["respondedBy"],
        message: "Responded requests must reference the response message",
      })
    }
    if (request.status !== "responded" && request.respondedBy) {
      ctx.addIssue({
        code: "custom",
        path: ["respondedBy"],
        message: "Only responded requests may reference a response message",
      })
    }
    if (request.status === "open" && request.resolvedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "Open requests cannot have a resolution timestamp",
      })
    }
    if (request.status !== "open" && !request.resolvedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "Resolved requests must record when they were resolved",
      })
    }
  })

export const ThreadMessageV3Schema = z
  .object({
    id: ThreadMessageIdSchema,
    sequence: z.number().int().positive(),
    authorIdentityId: ConversationIdentityIdSchema,
    authorMemberId: z.string().regex(/^ptc_[A-Za-z0-9_-]{12,}$/),
    notifyIdentityIds: z.array(ConversationIdentityIdSchema).max(100),
    responseRequest: ThreadResponseRequestSchema.optional(),
    creationIntent: z
      .object({
        notifyIdentityIds: z.array(ConversationIdentityIdSchema).max(100),
        responseIdentityId: ConversationIdentityIdSchema.nullable(),
      })
      .strict()
      .optional(),
    body: z.string().min(1).max(100_000),
    inReplyTo: ThreadMessageIdSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(200),
    createdAt: z.string(),
  })
  .strict()

const ThreadContentSchema = z.object({
  type: z.literal("worktable.thread"),
  id: z.string().regex(/^thr_[A-Za-z0-9_-]{12,}$/),
  title: z.string().min(1).max(160),
  participants: z
    .array(ParticipantRefSchema)
    .min(2)
    .refine(
      (participants) =>
        new Set(participants.map((participant) => participant.id)).size ===
        participants.length,
      "Thread participants must have unique IDs"
    ),
  revision: z.number().int().positive(),
  messages: z.array(LegacyThreadMessageSchema).min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const ThreadV1Schema = ThreadContentSchema.extend({
  version: z.literal(1),
  spaceId: z.string().min(1),
})
  // V1 has historically been an additive portable envelope. Preserve fields
  // written by file-aware tools while still rejecting the V2 discriminator.
  .passthrough()
  .superRefine((thread, ctx) => {
    if ("location" in thread) {
      ctx.addIssue({
        code: "custom",
        path: ["location"],
        message: "V1 threads cannot declare a V2 location",
      })
    }
  })

export const ThreadV2Schema = ThreadContentSchema.extend({
  version: z.literal(2),
  location: ThreadLocationSchema,
}).strict()

export const ThreadV3Schema = z
  .object({
    type: z.literal("worktable.thread"),
    version: z.literal(3),
    id: z.string().regex(/^thr_[A-Za-z0-9_-]{12,}$/),
    location: ThreadLocationSchema,
    /** @deprecated Retained only to preserve V1 Space integration keys. */
    spaceId: z.string().min(1).optional(),
    title: z.string().min(1).max(160),
    /** Append-only conversation roster for attribution and discovery, never authorization. */
    members: z.array(ThreadMemberSchema).min(1),
    identities: z.array(ConversationIdentitySchema).min(1),
    revision: z.number().int().positive(),
    messages: z.array(ThreadMessageV3Schema).min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  // V1 portable threads allowed file-aware tools to add top-level metadata.
  // Keep V3 additive at that same envelope boundary so a migration followed
  // by an ordinary Worktable mutation does not discard another tool's data.
  .passthrough()
  .superRefine((thread, ctx) => {
    if (
      thread.spaceId &&
      (thread.location.kind !== "space" ||
        thread.location.spaceId !== thread.spaceId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["spaceId"],
        message: "A legacy Space ID must match the thread location",
      })
    }
    const members = new Map(thread.members.map((member) => [member.id, member]))
    if (members.size !== thread.members.length) {
      ctx.addIssue({
        code: "custom",
        path: ["members"],
        message: "Thread members must have unique IDs",
      })
    }

    const identities = new Map(
      thread.identities.map((identity) => [identity.id, identity])
    )
    if (identities.size !== thread.identities.length) {
      ctx.addIssue({
        code: "custom",
        path: ["identities"],
        message: "Conversation identities must have unique IDs",
      })
    }
    const activeIdentityNames = new Map<string, number>()
    for (const [index, identity] of thread.identities.entries()) {
      if (!members.has(identity.memberId)) {
        ctx.addIssue({
          code: "custom",
          path: ["identities", index, "memberId"],
          message: "Conversation identities must belong to a thread member",
        })
      }
      if (identity.status === "active") {
        const matchingName = [...activeIdentityNames.keys()].find(
          (name) =>
            name.localeCompare(identity.name, undefined, {
              sensitivity: "accent",
            }) === 0
        )
        if (matchingName !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["identities", index, "name"],
            message: "Active conversation identities must have unique names",
          })
        } else {
          activeIdentityNames.set(identity.name, index)
        }
      }
    }
    for (const [memberIndex, member] of thread.members.entries()) {
      const defaults = thread.identities.filter(
        (identity) => identity.memberId === member.id && identity.default
      )
      if (defaults.length !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["members", memberIndex],
          message:
            "Every thread member must have one default conversation identity",
        })
      }
    }

    const messageIndexes = new Map(
      thread.messages.map((message, index) => [message.id, index])
    )
    if (messageIndexes.size !== thread.messages.length) {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "Thread message IDs must be unique",
      })
    }
    thread.messages.forEach((message, index) => {
      if (message.sequence !== index + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["messages", index, "sequence"],
          message: "Thread message sequences must be ordered and contiguous",
        })
      }
      const authorIdentity = identities.get(message.authorIdentityId)
      if (!authorIdentity) {
        ctx.addIssue({
          code: "custom",
          path: ["messages", index, "authorIdentityId"],
          message: "Thread message authors must be conversation identities",
        })
      } else if (authorIdentity.memberId !== message.authorMemberId) {
        ctx.addIssue({
          code: "custom",
          path: ["messages", index, "authorMemberId"],
          message:
            "Message member provenance must match its conversation identity",
        })
      }
      const attentionTargets = [
        ...message.notifyIdentityIds,
        ...(message.responseRequest
          ? [message.responseRequest.identityId]
          : []),
        ...(message.creationIntent?.notifyIdentityIds ?? []),
        ...(message.creationIntent?.responseIdentityId
          ? [message.creationIntent.responseIdentityId]
          : []),
      ]
      if (
        new Set(message.notifyIdentityIds).size !==
        message.notifyIdentityIds.length
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["messages", index, "notifyIdentityIds"],
          message: "A message cannot notify one identity more than once",
        })
      }
      if (
        message.creationIntent &&
        new Set(message.creationIntent.notifyIdentityIds).size !==
          message.creationIntent.notifyIdentityIds.length
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["messages", index, "creationIntent", "notifyIdentityIds"],
          message:
            "A message creation intent cannot notify one identity more than once",
        })
      }
      if (
        message.creationIntent?.responseIdentityId &&
        message.creationIntent.notifyIdentityIds.includes(
          message.creationIntent.responseIdentityId
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["messages", index, "creationIntent"],
          message:
            "A message creation intent cannot both notify and assign one identity",
        })
      }
      for (const [
        notifyIndex,
        identityId,
      ] of message.notifyIdentityIds.entries()) {
        if (message.responseRequest?.identityId === identityId) {
          ctx.addIssue({
            code: "custom",
            path: ["messages", index, "notifyIdentityIds", notifyIndex],
            message: "An assignment already directs attention to its identity",
          })
        }
      }
      for (const identityId of attentionTargets) {
        if (!identities.has(identityId)) {
          ctx.addIssue({
            code: "custom",
            path: ["messages", index],
            message:
              "Message attention targets must be conversation identities",
          })
        }
      }
      if (message.inReplyTo) {
        const targetIndex = messageIndexes.get(message.inReplyTo)
        if (targetIndex === undefined || targetIndex >= index) {
          ctx.addIssue({
            code: "custom",
            path: ["messages", index, "inReplyTo"],
            message:
              "Thread replies must target an earlier message in the same thread",
          })
        }
      }
      const request = message.responseRequest
      if (request?.respondedBy) {
        const responseIndex = messageIndexes.get(request.respondedBy)
        const response =
          responseIndex === undefined
            ? undefined
            : thread.messages[responseIndex]
        if (
          responseIndex === undefined ||
          responseIndex <= index ||
          response?.authorIdentityId !== request.identityId ||
          response.inReplyTo !== message.id
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["messages", index, "responseRequest", "respondedBy"],
            message:
              "An assignment must be resolved by a later reply from its identity",
          })
        }
      }
    })
  })

export const ThreadSchema = z
  .union([ThreadV1Schema, ThreadV2Schema])
  .superRefine((thread, ctx) => {
    const participantIds = new Set(
      thread.participants.map((participant) => participant.id)
    )
    const messageIds = new Set<string>()
    thread.messages.forEach((message, index) => {
      if (message.sequence !== index + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["messages", index, "sequence"],
          message: "Thread message sequences must be ordered and contiguous",
        })
      }
      if (messageIds.has(message.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["messages", index, "id"],
          message: "Thread message IDs must be unique",
        })
      }
      messageIds.add(message.id)
      if (!participantIds.has(message.authorId)) {
        ctx.addIssue({
          code: "custom",
          path: ["messages", index, "authorId"],
          message: "Thread message authors must be thread participants",
        })
      }
      message.recipientIds.forEach((recipientId, recipientIndex) => {
        if (!participantIds.has(recipientId)) {
          ctx.addIssue({
            code: "custom",
            path: ["messages", index, "recipientIds", recipientIndex],
            message: "Thread message recipients must be thread participants",
          })
        }
        if (recipientId === message.authorId) {
          ctx.addIssue({
            code: "custom",
            path: ["messages", index, "recipientIds", recipientIndex],
            message: "Thread messages cannot be addressed to their author",
          })
        }
      })
      if (message.inReplyTo) {
        const replyTargetIndex = thread.messages.findIndex(
          (candidate) => candidate.id === message.inReplyTo
        )
        if (replyTargetIndex < 0 || replyTargetIndex >= index) {
          ctx.addIssue({
            code: "custom",
            path: ["messages", index, "inReplyTo"],
            message:
              "Thread replies must target an earlier message in the same thread",
          })
        }
      }
    })
  })

export const PortableThreadSchema = z.union([ThreadSchema, ThreadV3Schema])

export const ThreadDeliveryStateSchema = z.enum([
  "queued",
  "working",
  "receiving",
  "replied",
  "failed",
])

export const ThreadActivitySchema = z.object({
  messageId: ThreadMessageIdSchema,
  participantId: z.string().regex(/^ptc_[A-Za-z0-9_-]{12,}$/),
  identityId: ConversationIdentityIdSchema.optional(),
  state: ThreadDeliveryStateSchema,
  revision: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  receivedCharacters: z.number().int().nonnegative().optional(),
  updatedAt: z.string(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
})

export type ParticipantKind = z.infer<typeof ParticipantKindSchema>
export type ParticipantRef = z.infer<typeof ParticipantRefSchema>
export type LegacyThreadMessage = z.infer<typeof LegacyThreadMessageSchema>
export type ThreadMember = z.infer<typeof ThreadMemberSchema>
export type ConversationIdentity = z.infer<typeof ConversationIdentitySchema>
export type ThreadResponseRequest = z.infer<typeof ThreadResponseRequestSchema>
export type ThreadMessageV3 = z.infer<typeof ThreadMessageV3Schema>
export type ThreadMessage = ThreadMessageV3
export type ThreadLocation = z.infer<typeof ThreadLocationSchema>
export type ThreadV1 = z.infer<typeof ThreadV1Schema>
export type ThreadV2 = z.infer<typeof ThreadV2Schema>
export type ThreadV3 = z.infer<typeof ThreadV3Schema>
export type LegacyThread = z.infer<typeof ThreadSchema>
export type Thread = ThreadV3
export type PortableThread = z.infer<typeof PortableThreadSchema>
export type ThreadDeliveryState = z.infer<typeof ThreadDeliveryStateSchema>
export type ThreadActivity = z.infer<typeof ThreadActivitySchema>

export function threadLocation(thread: PortableThread): ThreadLocation {
  return thread.version === 1
    ? { kind: "space", spaceId: thread.spaceId }
    : thread.location
}

export function defaultConversationIdentityId(memberId: string): string {
  return `idt_${memberId.replace(/^ptc_/, "")}`
}

function identityNamesMatch(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
}

export function uniqueConversationIdentityNames(
  requestedNames: string[]
): string[] {
  const allocatedNames: string[] = []
  return requestedNames.map((requestedName) => {
    let candidate = requestedName
    for (
      let suffixNumber = 2;
      allocatedNames.some((name) => identityNamesMatch(name, candidate));
      suffixNumber += 1
    ) {
      const suffix = ` (${suffixNumber})`
      candidate = `${requestedName
        .slice(0, THREAD_IDENTITY_NAME_MAX_LENGTH - suffix.length)
        .trimEnd()}${suffix}`
    }
    allocatedNames.push(candidate)
    return candidate
  })
}

export function prospectiveDefaultConversationIdentities(
  identities: Array<Pick<ConversationIdentity, "id" | "name" | "status">>,
  participants: ParticipantRef[]
): Array<Pick<ConversationIdentity, "id" | "memberId" | "name" | "default">> {
  const activeIdentities = identities.filter(
    (identity) => identity.status === "active"
  )
  const activeIdentityIds = new Set(
    activeIdentities.map((identity) => identity.id)
  )
  const candidates = [
    ...new Map(
      participants.map((participant) => [participant.id, participant])
    ).values(),
  ]
    .filter(
      (participant) =>
        !activeIdentityIds.has(defaultConversationIdentityId(participant.id))
    )
    .sort((left, right) => left.id.localeCompare(right.id))
  const names = uniqueConversationIdentityNames([
    ...activeIdentities.map((identity) => identity.name),
    ...candidates.map((participant) => participant.name),
  ]).slice(-candidates.length)

  return candidates.map((participant, index) => ({
    id: defaultConversationIdentityId(participant.id),
    memberId: participant.id,
    name: names[index]!,
    default: true,
  }))
}

export function upgradeThreadToV3(thread: PortableThread): ThreadV3 {
  if (thread.version === 3) return thread
  const legacyExtensions =
    thread.version === 1
      ? Object.fromEntries(
          Object.entries(thread).filter(
            ([key]) =>
              ![
                "type",
                "version",
                "id",
                "spaceId",
                "title",
                "participants",
                "revision",
                "messages",
                "createdAt",
                "updatedAt",
              ].includes(key)
          )
        )
      : {}
  const location = threadLocation(thread)
  const identityNames = uniqueConversationIdentityNames(
    thread.participants.map((participant) => participant.name)
  )
  const identities = thread.participants.map((participant, index) => ({
    id: defaultConversationIdentityId(participant.id),
    memberId: participant.id,
    name: identityNames[index]!,
    default: true,
    status: "active" as const,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  }))
  const identityByMember = new Map(
    identities.map((identity) => [identity.memberId, identity.id])
  )
  const responsesBySource = new Map<string, LegacyThreadMessage[]>()
  for (const message of thread.messages) {
    if (message.inReplyTo) {
      responsesBySource.set(message.inReplyTo, [
        ...(responsesBySource.get(message.inReplyTo) ?? []),
        message,
      ])
    }
  }
  return ThreadV3Schema.parse({
    ...legacyExtensions,
    type: "worktable.thread",
    version: 3,
    id: thread.id,
    location,
    ...(thread.version === 1 ? { spaceId: thread.spaceId } : {}),
    title: thread.title,
    members: thread.participants.map((participant) => ({
      ...participant,
      addedAt: thread.createdAt,
    })),
    identities,
    revision: thread.revision,
    messages: thread.messages.map((message) => {
      const responseRecipientId = message.expectsReply
        ? message.recipientIds[0]
        : undefined
      const responseIdentityId = responseRecipientId
        ? identityByMember.get(responseRecipientId)
        : undefined
      const response = responseRecipientId
        ? responsesBySource
            .get(message.id)
            ?.find((candidate) => candidate.authorId === responseRecipientId)
        : undefined
      return {
        id: message.id,
        sequence: message.sequence,
        authorIdentityId: identityByMember.get(message.authorId),
        authorMemberId: message.authorId,
        notifyIdentityIds: [],
        creationIntent: {
          notifyIdentityIds: [],
          responseIdentityId: responseIdentityId ?? null,
        },
        ...(responseIdentityId
          ? {
              responseRequest: {
                identityId: responseIdentityId,
                status: response ? ("responded" as const) : ("open" as const),
                ...(response
                  ? {
                      respondedBy: response.id,
                      resolvedAt: response.createdAt,
                    }
                  : {}),
              },
            }
          : {}),
        body: message.body,
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
        idempotencyKey: message.idempotencyKey,
        createdAt: message.createdAt,
      }
    }),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  })
}

export function threadLocationKey(location: ThreadLocation): string {
  return location.kind === "worktable"
    ? "worktable"
    : `space:${location.spaceId}`
}

export interface ThreadSummary {
  id: string
  version: 3
  location: ThreadLocation
  /** @deprecated Use location instead. */
  spaceId?: string
  title: string
  members: ThreadMember[]
  identities: ConversationIdentity[]
  revision: number
  messageCount: number
  lastMessage: ThreadMessage
  activity?: ThreadActivity
  createdAt: string
  updatedAt: string
}

export interface ThreadReadResult {
  location: ThreadLocation
  /** @deprecated Use location instead. */
  spaceId?: string
  thread: Thread
  messages: ThreadMessage[]
  cursor: number
  oldestCursor: number
  hasOlder: boolean
  hasNewer: boolean
  activities: ThreadActivity[]
  activity?: ThreadActivity
  viewerMemberId: string
  viewerIdentityId?: string
  /** @deprecated Use viewerMemberId instead. */
  viewerParticipantId: string
}

export interface ThreadWaitResult extends ThreadReadResult {
  timedOut: boolean
}

export interface ThreadPostResult {
  threadId: string
  location: ThreadLocation
  /** @deprecated Use location instead. */
  spaceId?: string
  messageId: string
  cursor: number
  createdThread: boolean
  activity?: ThreadActivity
  replies: ThreadMessage[]
  timedOut: boolean
}
