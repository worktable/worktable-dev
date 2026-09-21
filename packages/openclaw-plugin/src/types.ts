export interface WorktableParticipant {
  id: string
  kind: "human" | "agent" | "system"
  name: string
}

export interface WorktableMessage {
  id: string
  sequence: number
  authorIdentityId?: string
  authorMemberId?: string
  notifyIdentityIds?: string[]
  responseRequest?: {
    identityId: string
    status: "open" | "responded" | "withdrawn"
    respondedBy?: string
  }
  authorId?: string
  recipientIds?: string[]
  body: string
  inReplyTo?: string
  idempotencyKey: string
  createdAt: string
}

export type WorktableThreadLocation =
  | { kind: "worktable" }
  | { kind: "space"; spaceId: string }

export interface WorktableThread {
  id: string
  version: 3
  location: WorktableThreadLocation
  /** Deprecated V1 migration provenance used for durable session keys. */
  spaceId?: string
  title: string
  members: WorktableParticipant[]
  identities: Array<{
    id: string
    memberId: string
    name: string
    default: boolean
    status: "active" | "inactive"
  }>
}

export interface ClaimedWorktableDelivery {
  messageId: string
  threadId: string
  location: WorktableThreadLocation
  leaseId: string
  leaseExpiresAt: string
  identityId: string
  thread: WorktableThread
  message: WorktableMessage
}

export interface WorktablePostResult {
  threadId: string
  location?: WorktableThreadLocation
  spaceId?: string
  messageId: string
  cursor: number
}

export interface WorktableThreadSummary {
  id: string
  version?: 1 | 2 | 3
  location?: WorktableThreadLocation
  spaceId?: string
  title: string
  participants?: WorktableParticipant[]
  members?: WorktableParticipant[]
  identities?: Array<{ id: string; memberId: string; name: string }>
}

export interface ThreadProgress {
  state: string
  receivedCharacters?: number
}

export interface AgentDispatchInput {
  accountId: string
  location?: WorktableThreadLocation
  conversationId?: string
  threadTarget?: string
  /** Deprecated compatibility input for qualified V1 Space sessions. */
  spaceId?: string
  threadId: string
  messageId: string
  body: string
  sender: WorktableParticipant
}

export interface AgentDispatchCallbacks {
  onWorking(): Promise<void>
  onReceiving(receivedCharacters: number): Promise<void>
}

export interface AgentDispatcher {
  dispatch(
    input: AgentDispatchInput,
    callbacks: AgentDispatchCallbacks,
    signal?: AbortSignal
  ): Promise<string>
}

export interface WorktableClient {
  close(): Promise<void>
  participants(signal?: AbortSignal): Promise<WorktableParticipant[]>
  listThreads(spaceId?: string): Promise<WorktableThreadSummary[]>
  claim(
    waitSeconds?: number,
    signal?: AbortSignal
  ): Promise<ClaimedWorktableDelivery | null>
  accept(messageId: string, leaseId: string): Promise<void>
  progress(
    messageId: string,
    leaseId: string,
    phase: "working" | "receiving",
    receivedCharacters?: number
  ): Promise<void>
  fail(
    messageId: string,
    leaseId: string,
    retryable: boolean,
    code: string,
    message: string
  ): Promise<void>
  reply(input: {
    location?: WorktableThreadLocation
    spaceId?: string
    threadId: string
    inReplyTo: string
    to?: string
    responseTo?: string
    authorIdentityId?: string
    deliveryLeaseId?: string
    body: string
    idempotencyKey: string
  }): Promise<WorktablePostResult>
  post(input: {
    to?: string
    threadId?: string
    location?: WorktableThreadLocation
    spaceId?: string
    body: string
    idempotencyKey: string
  }): Promise<WorktablePostResult>
}

export interface WorktableChannelAccount {
  accountId: string
  enabled: boolean
  server: string
  token: string
  authMode?: "local-token" | "agent-registration"
  agentAuth?: WorktableAgentAuth
  pendingAgentAuth?: WorktableAgentAuth
  participantName?: string
  defaultSpaceId?: string
  pendingPairingCode?: string
}

export interface WorktableAgentAuth {
  registrationId: string
  authorizationServer: string
  identityEndpoint: string
  tokenEndpoint: string
  resource: string
  assertion: string
  assertionExpiresAt: string
  refreshToken: string
  refreshTokenExpiresAt: string
}
