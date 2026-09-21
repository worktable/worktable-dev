import {
  markdownPlainText,
  prospectiveDefaultConversationIdentities,
  type ConversationIdentity,
  type ParticipantRef,
  type ThreadActivity,
  type ThreadMember,
  type ThreadMessage,
} from "@worktable/types"

export interface DeliveryPresentation {
  label: string
  visible: boolean
  live: boolean
  failed: boolean
}

export type ConversationIdentityOption = Pick<
  ConversationIdentity,
  "id" | "memberId" | "name" | "default"
>

export function directAlwaysOnAgentIdentity(
  members: ThreadMember[],
  identities: ConversationIdentityOption[],
  participants: Array<Pick<ParticipantRef, "id"> & { alwaysOn?: boolean }>,
  viewerMemberId?: string
): ConversationIdentityOption | undefined {
  if (!viewerMemberId || members.length !== 2) return undefined
  const viewer = members.find((member) => member.id === viewerMemberId)
  if (viewer?.kind !== "human") return undefined
  const agent = members.find(
    (member) => member.id !== viewerMemberId && member.kind === "agent"
  )
  if (
    !agent ||
    !participants.some(
      (participant) => participant.id === agent.id && participant.alwaysOn
    )
  ) {
    return undefined
  }
  return identities.find(
    (identity) => identity.memberId === agent.id && identity.default
  )
}

export function threadMentionRequestsResponse(
  members: Array<Pick<ThreadMember, "id">>,
  identity: Pick<ConversationIdentityOption, "memberId">
): boolean {
  return (
    members.length > 2 ||
    !members.some((member) => member.id === identity.memberId)
  )
}

export function availableConversationIdentities(
  identities: ConversationIdentity[],
  participants: ParticipantRef[]
): ConversationIdentityOption[] {
  const active = identities.filter((identity) => identity.status === "active")
  const options = new Map<string, ConversationIdentityOption>(
    active.map((identity) => [identity.id, identity])
  )
  const prospective = new Map(
    prospectiveDefaultConversationIdentities(active, participants).map(
      (identity) => [identity.memberId, identity]
    )
  )
  for (const participant of participants) {
    const identity = prospective.get(participant.id)
    if (identity) options.set(identity.id, identity)
  }
  return [...options.values()]
}

export function visibleNonterminalActivityKeys(
  activities: ThreadActivity[]
): Set<string> {
  return new Set(
    activities
      .filter(
        (activity) =>
          activity.state === "queued" ||
          activity.state === "working" ||
          activity.state === "receiving"
      )
      .map(
        (activity) =>
          `${activity.messageId}:${activity.identityId ?? activity.participantId}`
      )
  )
}

export function isCurrentAssignmentActivity(
  message: ThreadMessage,
  activity: ThreadActivity
): boolean {
  return (
    message.responseRequest?.status === "open" &&
    activity.identityId === message.responseRequest.identityId
  )
}

export function conversationIdentityDescription(
  identity: ConversationIdentityOption,
  members: ParticipantRef[],
  identities: ConversationIdentityOption[]
): string | undefined {
  const member = members.find((candidate) => candidate.id === identity.memberId)
  if (!member) return undefined
  if (identity.name !== member.name) return member.name
  const sameName = identities.filter(
    (candidate) =>
      candidate.name.localeCompare(identity.name, undefined, {
        sensitivity: "accent",
      }) === 0
  )
  if (sameName.length < 2) return undefined
  const position = sameName.findIndex(
    (candidate) => candidate.id === identity.id
  )
  return `${member.kind === "human" ? "Person" : "Agent"} ${position + 1}`
}

export function threadExcerpt(markdown: string, maxLength: number): string {
  const plain = markdownPlainText(markdown).replace(/\s+/g, " ").trim()
  if (plain.length <= maxLength) return plain
  return `${plain.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

export function participantInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const initials =
    words.length > 1 ? [words[0]!, words[words.length - 1]!] : words
  return initials.map((word) => word[0]?.toUpperCase() ?? "").join("")
}

export function resolveMessageAuthor(
  members: ThreadMember[],
  identities: ConversationIdentity[],
  message: ThreadMessage
): ParticipantRef | undefined {
  const identity = identities.find(
    (candidate) => candidate.id === message.authorIdentityId
  )
  const member = identity
    ? members.find((candidate) => candidate.id === identity.memberId)
    : undefined
  if (!identity || !member) return undefined
  return {
    id: member.id,
    kind: member.kind,
    name: identity.name,
    ...(member.identityFingerprint
      ? { identityFingerprint: member.identityFingerprint }
      : {}),
  }
}

export function resolveReplyTarget(
  messages: ThreadMessage[],
  inReplyTo: string | undefined
): ThreadMessage | undefined {
  if (!inReplyTo) return undefined
  return messages.find((message) => message.id === inReplyTo)
}

export function localDateKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

export function beginsLocalCalendarDate(
  current: string | Date,
  previous?: string | Date
): boolean {
  return !previous || localDateKey(current) !== localDateKey(previous)
}

export function deliveryPresentation(
  activity: ThreadActivity,
  participantName: string
): DeliveryPresentation {
  if (activity.error?.code === "DELIVERY_RETIRED") {
    return {
      label: "",
      visible: false,
      live: false,
      failed: false,
    }
  }
  if (activity.state === "replied") {
    return {
      label: "Reply received",
      visible: false,
      live: false,
      failed: false,
    }
  }
  if (activity.state === "failed") {
    const attempts =
      activity.attempts > 0
        ? ` after ${activity.attempts} ${activity.attempts === 1 ? "attempt" : "attempts"}`
        : ""
    return {
      label:
        (activity.error?.message ?? `Delivery to ${participantName} failed`) +
        attempts,
      visible: true,
      live: false,
      failed: true,
    }
  }
  if (activity.state === "working") {
    return {
      label: `${participantName} is working…`,
      visible: true,
      live: true,
      failed: false,
    }
  }
  if (activity.state === "receiving") {
    return {
      label: `${participantName} is responding…`,
      visible: true,
      live: true,
      failed: false,
    }
  }
  if (activity.attempts > 0) {
    return {
      label: `Retrying ${participantName} · attempt ${activity.attempts + 1}`,
      visible: true,
      live: false,
      failed: false,
    }
  }
  return {
    label: `Assigned to ${participantName}`,
    visible: true,
    live: false,
    failed: false,
  }
}
