import type {
  ClaimedWorktableDelivery,
  WorktableClient,
  WorktableParticipant,
  WorktablePostResult,
  WorktableThreadSummary,
} from "./types.js"

export class FakeWorktableClient implements WorktableClient {
  readonly deliveries: ClaimedWorktableDelivery[] = []
  readonly replies: Array<{
    location?: import("./types.js").WorktableThreadLocation
    spaceId?: string
    threadId: string
    to: string
    inReplyTo: string
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

  claim(): Promise<ClaimedWorktableDelivery | null> {
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
    code: string
  ): Promise<void> {
    this.failed.push({ messageId, retryable, code })
    return Promise.resolve()
  }

  reply(input: {
    location?: import("./types.js").WorktableThreadLocation
    spaceId?: string
    threadId: string
    to: string
    inReplyTo: string
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
