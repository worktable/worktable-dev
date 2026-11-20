import type {
  ClaimedWorktableComments,
  ClaimedWorktableDelivery,
  WorktableClient,
  WorktableParticipant,
  WorktablePostResult,
  WorktableThreadSummary,
} from "./types.js"

export class FakeWorktableClient implements WorktableClient {
  readonly deliveries: Array<ClaimedWorktableDelivery | ClaimedWorktableComments> = []
  readonly replies: Array<{
    location?: import("./types.js").WorktableThreadLocation
    spaceId?: string
    threadId: string
    inReplyTo: string
    to?: string
    responseTo?: string
    authorIdentityId?: string
    deliveryLeaseId?: string
    body: string
    idempotencyKey: string
  }> = []
  readonly progressEvents: Array<{
    messageId: string
    phase: "working" | "receiving"
    receivedCharacters?: number
  }> = []
  readonly failed: Array<{
    messageId: string
    retryable: boolean
    code: string
    message: string
  }> = []
  readonly accepted = new Set<string>()
  participantsList: WorktableParticipant[] = []
  threadList: WorktableThreadSummary[] = []
  #replyCounter = 0

  close(): Promise<void> {
    return Promise.resolve()
  }

  participants(): Promise<WorktableParticipant[]> {
    return Promise.resolve(this.participantsList)
  }

  listThreads(): Promise<WorktableThreadSummary[]> {
    return Promise.resolve(this.threadList)
  }

  claim(): Promise<ClaimedWorktableDelivery | ClaimedWorktableComments | null> {
    return Promise.resolve(this.deliveries.shift() ?? null)
  }

  accept(messageId: string): Promise<void> {
    this.accepted.add(messageId)
    return Promise.resolve()
  }

  progress(
    messageId: string,
    _leaseId: string,
    phase: "working" | "receiving",
    receivedCharacters?: number
  ): Promise<void> {
    this.progressEvents.push({ messageId, phase, receivedCharacters })
    return Promise.resolve()
  }

  fail(
    messageId: string,
    _leaseId: string,
    retryable: boolean,
    code: string,
    message: string
  ): Promise<void> {
    this.failed.push({ messageId, retryable, code, message })
    return Promise.resolve()
  }

  readonly commentReplies: Array<{ messageId: string; leaseId: string; body: string }> = []

  readonly answered: Array<{ annotationId: string; body: string }> = []

  async answerComments(input: {
    spaceId: string
    annotationIds: string[]
    body: string
  }): Promise<string[]> {
    for (const annotationId of input.annotationIds)
      this.answered.push({ annotationId, body: input.body })
    return input.annotationIds
  }

  async replyToComments(input: {
    messageId: string
    leaseId: string
    body: string
  }): Promise<void> {
    this.commentReplies.push(input)
  }

  reply(input: {
    location?: import("./types.js").WorktableThreadLocation
    spaceId?: string
    threadId: string
    inReplyTo: string
    to?: string
    responseTo?: string
    authorIdentityId?: string
    deliveryLeaseId?: string
    body: string
    idempotencyKey: string
  }): Promise<WorktablePostResult> {
    this.replies.push(input)
    this.#replyCounter += 1
    return Promise.resolve({
      threadId: input.threadId,
      messageId: `msg_reply_${this.#replyCounter}`,
      cursor: this.#replyCounter + 1,
    })
  }

  post(input: { threadId?: string }): Promise<WorktablePostResult> {
    this.#replyCounter += 1
    return Promise.resolve({
      threadId: input.threadId ?? `thr_new_${this.#replyCounter}`,
      messageId: `msg_out_${this.#replyCounter}`,
      cursor: 1,
    })
  }
}
