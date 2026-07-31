export interface WorktableParticipant {
  id: string
  kind: "human" | "agent" | "system"
  name: string
}

export interface WorktableMessage {
  id: string
  sequence: number
  authorId: string
  recipientIds: string[]
  body: string
  inReplyTo?: string
  expectsReply: boolean
  idempotencyKey: string
  createdAt: string
}

export type WorktableThreadLocation =
  | { kind: "worktable" }
  | { kind: "space"; spaceId: string }

export interface WorktableThread {
  id: string
  version?: 1 | 2
  location?: WorktableThreadLocation
  /** Present on legacy Space threads and compatibility responses. */
  spaceId?: string
  title: string
  participants: WorktableParticipant[]
}

export interface ClaimedWorktableDelivery {
  messageId: string
  threadId: string
  location?: WorktableThreadLocation
  spaceId?: string
  leaseId: string
  leaseExpiresAt: string
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
  version?: 1 | 2
  location?: WorktableThreadLocation
  spaceId?: string
  title: string
  participants: WorktableParticipant[]
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
  participants(): Promise<WorktableParticipant[]>
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
    to: string
    inReplyTo: string
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
