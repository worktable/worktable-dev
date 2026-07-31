import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe"
import type { ReplyOutbox } from "./reply-outbox.js"
import type {
  AgentDispatcher,
  ClaimedWorktableDelivery,
  WorktableClient,
  WorktableThreadLocation,
} from "./types.js"

const HEARTBEAT_MS = 15_000
const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 3
const MAX_CONCURRENT_TURNS = 4
const DEFAULT_SHUTDOWN_DRAIN_MS = 5_000

export interface ConnectorLogger {
  debug?(message: string): void
  info?(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

export interface DeliveryDedupe {
  claim(
    key: string,
    options?: { namespace?: string }
  ): Promise<
    | { kind: "claimed" }
    | { kind: "duplicate" }
    | { kind: "inflight"; pending: Promise<boolean> }
  >
  commit(key: string, options?: { namespace?: string }): Promise<boolean>
  release(key: string, options?: { namespace?: string; error?: unknown }): void
  warmup(namespace?: string): Promise<number>
}

export interface ConnectorConnectionState {
  connected: boolean
  errorCode?: string
}

type SettledDeliveryClaim = Exclude<
  Awaited<ReturnType<DeliveryDedupe["claim"]>>,
  { kind: "inflight" }
>

async function claimSettledDelivery(
  dedupe: DeliveryDedupe,
  eventId: string,
  namespace: string
): Promise<SettledDeliveryClaim> {
  while (true) {
    const claim = await dedupe.claim(eventId, { namespace })
    if (claim.kind !== "inflight") return claim
    if (await claim.pending) return { kind: "duplicate" }
  }
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code.slice(0, 100)
  }
  return "OPENCLAW_DISPATCH_FAILED"
}

function safeErrorMessage(error: unknown): string {
  const code = errorCode(error)
  return `OpenClaw could not complete this message (${code}).`
}

function deliveryLocation(
  delivery: ClaimedWorktableDelivery
): WorktableThreadLocation {
  if (delivery.location) return delivery.location
  const spaceId = delivery.spaceId ?? delivery.thread.spaceId
  if (spaceId) return { kind: "space", spaceId }
  return { kind: "worktable" }
}

function isLegacyDelivery(delivery: ClaimedWorktableDelivery): boolean {
  const location = deliveryLocation(delivery)
  return (
    delivery.thread.version === 1 ||
    (delivery.thread.version === undefined && location.kind === "space")
  )
}

function deliveryLocationKey(delivery: ClaimedWorktableDelivery): string {
  const location = deliveryLocation(delivery)
  return location.kind === "worktable"
    ? "worktable"
    : `space:${location.spaceId}`
}

function deliveryConversationId(delivery: ClaimedWorktableDelivery): string {
  const location = deliveryLocation(delivery)
  const legacy = isLegacyDelivery(delivery)
  return legacy && location.kind === "space"
    ? `${location.spaceId}/${delivery.threadId}`
    : `${deliveryLocationKey(delivery)}/${delivery.threadId}`
}

function deliveryThreadTarget(delivery: ClaimedWorktableDelivery): string {
  const location = deliveryLocation(delivery)
  return location.kind === "space"
    ? `thread:${location.spaceId}/${delivery.threadId}`
    : `thread:${delivery.threadId}`
}

function deliveryEventId(delivery: ClaimedWorktableDelivery): string {
  return `${deliveryConversationId(delivery)}/${delivery.messageId}`
}

function transformOutsideInlineCode(
  markdown: string,
  transform: (prose: string) => string
): string {
  let output = ""
  let proseStart = 0
  let index = 0
  while (index < markdown.length) {
    if (markdown[index] !== "`") {
      index += 1
      continue
    }
    let openingEnd = index + 1
    while (markdown[openingEnd] === "`") openingEnd += 1
    const width = openingEnd - index
    let closingStart = openingEnd
    let found = false
    while (closingStart < markdown.length) {
      closingStart = markdown.indexOf("`", closingStart)
      if (closingStart < 0) break
      let closingEnd = closingStart + 1
      while (markdown[closingEnd] === "`") closingEnd += 1
      if (closingEnd - closingStart === width) {
        output += transform(markdown.slice(proseStart, index))
        output += markdown.slice(index, closingEnd)
        proseStart = closingEnd
        index = closingEnd
        found = true
        break
      }
      closingStart = closingEnd
    }
    if (!found) index = openingEnd
  }
  return output + transform(markdown.slice(proseStart))
}

function transformMarkdownProse(
  markdown: string,
  transform: (prose: string) => string
): string {
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let output = ""
  let prose = ""
  let fence: { marker: "`" | "~"; width: number } | undefined
  const flushProse = () => {
    output += transformOutsideInlineCode(prose, transform)
    prose = ""
  }

  for (const line of lines) {
    const content = line.endsWith("\n") ? line.slice(0, -1) : line
    const opening = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!fence && opening) {
      const marker = opening[1]![0] as "`" | "~"
      if (marker === "~" || !opening[2]!.includes("`")) {
        flushProse()
        fence = { marker, width: opening[1]!.length }
        output += line
        continue
      }
    }
    if (fence) {
      output += line
      const closing = content.match(/^ {0,3}(`+|~+)[ \t]*\r?$/)
      if (
        closing &&
        closing[1]![0] === fence.marker &&
        closing[1]!.length >= fence.width
      ) {
        fence = undefined
      }
      continue
    }
    if (/^(?: {4}|\t)/.test(content)) {
      flushProse()
      output += line
      continue
    }
    prose += line
  }
  flushProse()
  return output
}

export function portableWorktableDocLinks(
  body: string,
  spaceId: string,
  worktableOrigin?: string
): string {
  let knownOrigin: string
  try {
    knownOrigin = new URL(worktableOrigin ?? "").origin
  } catch {
    return body
  }
  return transformMarkdownProse(body, (prose) =>
    prose.replace(
      /(\]\()?<?(https?:\/\/[^\s<>)\]]+)>?/gi,
      (value, markdownPrefix: string | undefined, urlValue: string) => {
        try {
          const wrapped = Boolean(markdownPrefix) || value.startsWith("<")
          const trailing = wrapped
            ? ""
            : (urlValue.match(/[,.;:!?]+$/)?.[0] ?? "")
          const normalizedUrl = trailing
            ? urlValue.slice(0, -trailing.length)
            : urlValue
          const url = new URL(normalizedUrl)
          if (url.origin !== knownOrigin) return value
          const match = url.pathname.match(/^\/spaces\/([^/]+)\/docs\/(.+)$/)
          if (
            !match ||
            (spaceId && decodeURIComponent(match[1]!) !== spaceId)
          ) {
            return value
          }
          const portable = spaceId
            ? `/${match[2]}${url.search}${url.hash}`
            : `${url.pathname}${url.search}${url.hash}`
          return markdownPrefix
            ? `${markdownPrefix}${portable}${trailing}`
            : `[${portable}](${portable})${trailing}`
        } catch {
          return value
        }
      }
    )
  )
}

export function createOpenClawDeliveryDedupe(
  env: NodeJS.ProcessEnv = process.env
): DeliveryDedupe {
  let persistenceError: unknown
  const guard = createClaimableDedupe({
    pluginId: "worktable",
    namespacePrefix: "thread-ingress",
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    memoryMaxSize: 2_000,
    stateMaxEntries: 2_000,
    env,
    onDiskError: (error) => {
      persistenceError = error
    },
  })
  const requirePersistence = () => {
    if (persistenceError) {
      throw Object.assign(
        new Error(
          "OpenClaw durable plugin state is unavailable; refusing restart-unsafe Worktable delivery.",
          { cause: persistenceError }
        ),
        { code: "DURABLE_INGRESS_UNAVAILABLE" }
      )
    }
  }
  return {
    async warmup(namespace) {
      const result = await guard.warmup(namespace, (error) => {
        persistenceError = error
      })
      requirePersistence()
      return result
    },
    async claim(key, options) {
      const result = await guard.claim(key, {
        ...options,
        onDiskError: (error) => {
          persistenceError = error
        },
      })
      requirePersistence()
      return result
    },
    async commit(key, options) {
      const result = await guard.commit(key, {
        ...options,
        onDiskError: (error) => {
          persistenceError = error
        },
      })
      requirePersistence()
      return result
    },
    release: (key, options) => guard.release(key, options),
  }
}

export function waitForReconnectDelay(
  delayMs: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    timer = setTimeout(finish, delayMs)
    signal.addEventListener("abort", finish, { once: true })
    // Close the race where abort happens between the initial check and
    // listener registration.
    if (signal.aborted) finish()
  })
}

export class WorktableConnector {
  readonly #client: WorktableClient
  readonly #dispatcher: AgentDispatcher
  readonly #dedupe: DeliveryDedupe
  readonly #replyOutbox: ReplyOutbox
  readonly #accountId: string
  readonly #logger: ConnectorLogger
  readonly #active = new Set<Promise<void>>()
  readonly #threadTails = new Map<string, Promise<void>>()
  readonly #onConnected?: () => void | Promise<void>
  readonly #onConnectionState?: (state: ConnectorConnectionState) => void
  readonly #shutdownDrainMs: number
  readonly #heartbeatMs: number
  readonly #startHeartbeat: (
    callback: () => void | Promise<void>,
    intervalMs: number
  ) => ReturnType<typeof setInterval>
  readonly #stopHeartbeat: (timer: ReturnType<typeof setInterval>) => void
  readonly #worktableOrigin?: string

  constructor(options: {
    client: WorktableClient
    dispatcher: AgentDispatcher
    dedupe?: DeliveryDedupe
    replyOutbox: ReplyOutbox
    accountId: string
    logger?: ConnectorLogger
    onConnected?: () => void | Promise<void>
    onConnectionState?: (state: ConnectorConnectionState) => void
    shutdownDrainMs?: number
    heartbeatMs?: number
    heartbeatTimer?: {
      start(
        callback: () => void | Promise<void>,
        intervalMs: number
      ): ReturnType<typeof setInterval>
      stop(timer: ReturnType<typeof setInterval>): void
    }
    worktableOrigin?: string
  }) {
    this.#client = options.client
    this.#dispatcher = options.dispatcher
    this.#dedupe = options.dedupe ?? createOpenClawDeliveryDedupe()
    this.#replyOutbox = options.replyOutbox
    this.#accountId = options.accountId
    this.#logger = options.logger ?? {}
    this.#onConnected = options.onConnected
    this.#onConnectionState = options.onConnectionState
    this.#shutdownDrainMs = options.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
    this.#startHeartbeat =
      options.heartbeatTimer?.start ??
      ((callback, ms) => setInterval(() => void callback(), ms))
    this.#stopHeartbeat =
      options.heartbeatTimer?.stop ?? ((timer) => clearInterval(timer))
    this.#worktableOrigin = options.worktableOrigin
  }

  async processOne(): Promise<boolean> {
    const delivery = await this.#client.claim(0)
    if (!delivery) return false
    await this.#handle(delivery)
    return true
  }

  async run(signal: AbortSignal): Promise<void> {
    try {
      await this.#dedupe.warmup(this.#accountId)
    } catch (error) {
      this.#onConnectionState?.({
        connected: false,
        errorCode: errorCode(error),
      })
      await this.#client.close()
      throw error
    }
    let backoffMs = 500
    let connected = false
    while (!signal.aborted) {
      try {
        if (!connected) {
          await this.#client.participants()
          await this.#onConnected?.()
          connected = true
          this.#onConnectionState?.({ connected: true })
        }
        if (this.#active.size >= MAX_CONCURRENT_TURNS) {
          let cancelCapacityWait: (() => void) | undefined
          const aborted = new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve()
              return
            }
            cancelCapacityWait = resolve
            signal.addEventListener("abort", cancelCapacityWait, {
              once: true,
            })
          })
          try {
            await Promise.race([Promise.race(this.#active), aborted])
          } finally {
            if (cancelCapacityWait) {
              signal.removeEventListener("abort", cancelCapacityWait)
            }
          }
          continue
        }
        const delivery = await this.#client.claim(25, signal)
        if (!delivery) continue
        const running = this.#handle(delivery, signal)
          .catch((error) => {
            if (signal.aborted) return
            connected = false
            this.#onConnectionState?.({
              connected: false,
              errorCode: errorCode(error),
            })
            this.#logger.error?.(
              `Worktable delivery task failed before guarded dispatch (${errorCode(error)}); its lease will recover after expiry`
            )
          })
          .finally(() => {
            this.#active.delete(running)
          })
        this.#active.add(running)
        backoffMs = 500
      } catch (error) {
        if (signal.aborted) break
        connected = false
        this.#onConnectionState?.({
          connected: false,
          errorCode: errorCode(error),
        })
        if (signal.aborted) break
        this.#logger.warn?.(
          `Worktable claim failed (${errorCode(error)}); reconnecting`
        )
        await waitForReconnectDelay(backoffMs, signal)
        backoffMs = Math.min(backoffMs * 2, 10_000)
      }
    }
    if (this.#active.size > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const drained = await Promise.race([
        Promise.allSettled([...this.#active]).then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), this.#shutdownDrainMs)
        }),
      ])
      if (timeout) clearTimeout(timeout)
      if (!drained) {
        this.#logger.warn?.(
          `Timed out draining ${this.#active.size} active Worktable turn(s); their leases will recover after expiry`
        )
      }
    }
    await this.#client.close()
  }

  async #handle(
    delivery: ClaimedWorktableDelivery,
    signal?: AbortSignal
  ): Promise<void> {
    const namespace = this.#accountId
    const location = deliveryLocation(delivery)
    const conversationId = deliveryConversationId(delivery)
    const eventId = deliveryEventId(delivery)
    const claim = await claimSettledDelivery(this.#dedupe, eventId, namespace)
    if (claim.kind === "duplicate") {
      await this.#replyOutbox.delete(eventId).catch(() => undefined)
      await this.#client.fail(
        delivery.messageId,
        delivery.leaseId,
        false,
        "DUPLICATE_EVENT",
        "This message was already completed by OpenClaw."
      )
      return
    }

    let heartbeat: ReturnType<typeof setInterval> | undefined
    let heartbeatRunning = false
    let heartbeatFailures = 0
    let leaseFailure: unknown
    const turnAbort = new AbortController()
    const abortTurn = () => turnAbort.abort(signal?.reason)
    signal?.addEventListener("abort", abortTurn, { once: true })
    let progressPhase: "working" | "receiving" = "working"
    let receivedCharacters: number | undefined
    let terminalAfterDispatch = false
    let replyAppended = false
    const reportProgress = async (
      phase: "working" | "receiving",
      characters?: number
    ) => {
      if (phase === "receiving") progressPhase = "receiving"
      if (characters !== undefined) {
        receivedCharacters = Math.max(receivedCharacters ?? 0, characters)
      }
      await this.#client.progress(
        delivery.messageId,
        delivery.leaseId,
        progressPhase,
        receivedCharacters
      )
      heartbeatFailures = 0
    }
    const stopHeartbeat = () => {
      if (heartbeat) {
        this.#stopHeartbeat(heartbeat)
        heartbeat = undefined
      }
    }
    const heartbeatTick = async () => {
      if (heartbeatRunning || turnAbort.signal.aborted) return
      heartbeatRunning = true
      try {
        await reportProgress(progressPhase, receivedCharacters)
      } catch (error) {
        heartbeatFailures += 1
        const code = errorCode(error)
        this.#logger.warn?.(
          `Worktable heartbeat failed for ${delivery.messageId} (${code}); attempt ${heartbeatFailures}/${MAX_CONSECUTIVE_HEARTBEAT_FAILURES}`
        )
        if (
          code === "LEASE_LOST" ||
          heartbeatFailures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES
        ) {
          leaseFailure =
            code === "LEASE_LOST"
              ? error
              : Object.assign(
                  new Error(
                    "Worktable lease heartbeat failed repeatedly; cancelling the active agent turn."
                  ),
                  { code: "LEASE_HEARTBEAT_FAILED" }
                )
          turnAbort.abort(leaseFailure)
        }
      } finally {
        heartbeatRunning = false
      }
    }
    try {
      await this.#client.accept(delivery.messageId, delivery.leaseId)
      await reportProgress("working")
      heartbeat = this.#startHeartbeat(heartbeatTick, this.#heartbeatMs)
      turnAbort.signal.addEventListener("abort", stopHeartbeat, { once: true })
      await this.#withThreadTurn(conversationId, turnAbort.signal, async () => {
        let retained = await this.#replyOutbox.get(eventId)
        if (!retained) {
          const sender = delivery.thread.participants.find(
            (participant) => participant.id === delivery.message.authorId
          ) ?? {
            id: delivery.message.authorId,
            kind: "agent" as const,
            name: delivery.message.authorId,
          }
          const reply = await this.#dispatcher.dispatch(
            {
              accountId: this.#accountId,
              location,
              conversationId,
              threadTarget: deliveryThreadTarget(delivery),
              ...(location.kind === "space"
                ? { spaceId: location.spaceId }
                : {}),
              threadId: delivery.threadId,
              messageId: delivery.messageId,
              body: delivery.message.body,
              sender,
            },
            {
              onWorking: () =>
                reportProgress(progressPhase, receivedCharacters),
              onReceiving: (characters) =>
                reportProgress("receiving", characters),
            },
            turnAbort.signal
          )
          if (!reply.trim()) {
            terminalAfterDispatch = true
            throw Object.assign(new Error("OpenClaw returned an empty reply"), {
              code: "EMPTY_REPLY",
            })
          }
          retained = {
            ...(isLegacyDelivery(delivery) ? {} : { location }),
            ...(location.kind === "space" ? { spaceId: location.spaceId } : {}),
            threadId: delivery.threadId,
            to: delivery.message.authorId,
            inReplyTo: delivery.messageId,
            body: portableWorktableDocLinks(
              reply,
              location.kind === "space" ? location.spaceId : "",
              this.#worktableOrigin
            ),
            idempotencyKey: `openclaw:${delivery.messageId}:reply`,
          }
          try {
            await this.#replyOutbox.put(eventId, retained)
          } catch (error) {
            terminalAfterDispatch = true
            throw error
          }
        }
        if (turnAbort.signal.aborted) {
          throw (
            leaseFailure ??
            Object.assign(new Error("Worktable channel stopped"), {
              code: "CHANNEL_STOPPED",
            })
          )
        }
        await this.#client.reply(retained)
        replyAppended = true
      })
      try {
        await this.#dedupe.commit(eventId, { namespace })
      } catch (error) {
        this.#dedupe.release(eventId, { namespace, error })
        this.#logger.warn?.(
          `Worktable reply for ${delivery.messageId} was appended, but durable ingress completion failed (${errorCode(error)})`
        )
        return
      }
      await this.#replyOutbox.delete(eventId).catch((error) => {
        this.#logger.warn?.(
          `Worktable reply outbox cleanup failed for ${delivery.messageId} (${errorCode(error)})`
        )
      })
      this.#logger.info?.(
        `Completed Worktable message ${delivery.messageId} in ${delivery.threadId}`
      )
    } catch (error) {
      if (replyAppended) {
        this.#dedupe.release(eventId, { namespace, error })
        this.#logger.warn?.(
          `Worktable reply for ${delivery.messageId} was already appended; skipped agent redispatch after ${errorCode(error)}`
        )
        return
      }
      if (terminalAfterDispatch) {
        try {
          await this.#dedupe.commit(eventId, { namespace })
        } catch (commitError) {
          this.#dedupe.release(eventId, {
            namespace,
            error: commitError,
          })
        }
        this.#logger.error?.(
          `Worktable message ${delivery.messageId} ended without a safely retryable reply (${errorCode(error)})`
        )
        await this.#client
          .fail(
            delivery.messageId,
            delivery.leaseId,
            false,
            errorCode(error),
            safeErrorMessage(error)
          )
          .catch(() => undefined)
        return
      }
      this.#dedupe.release(eventId, { namespace, error })
      if (signal?.aborted) {
        this.#logger.info?.(
          `Stopped Worktable message ${delivery.messageId}; its lease will recover`
        )
        return
      }
      this.#logger.error?.(
        `Worktable message ${delivery.messageId} failed (${errorCode(error)})`
      )
      await this.#client
        .fail(
          delivery.messageId,
          delivery.leaseId,
          true,
          errorCode(error),
          safeErrorMessage(error)
        )
        .catch(() => undefined)
    } finally {
      signal?.removeEventListener("abort", abortTurn)
      turnAbort.signal.removeEventListener("abort", stopHeartbeat)
      stopHeartbeat()
    }
  }

  async #withThreadTurn<T>(
    threadKey: string,
    signal: AbortSignal,
    run: () => Promise<T>
  ): Promise<T> {
    const previous = this.#threadTails.get(threadKey) ?? Promise.resolve()
    let release: (() => void) | undefined
    const own = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => own)
    this.#threadTails.set(threadKey, tail)

    let cancelWait: (() => void) | undefined
    const aborted = new Promise<void>((_, reject) => {
      if (signal.aborted) {
        reject(
          Object.assign(new Error("Worktable channel stopped"), {
            code: "CHANNEL_STOPPED",
          })
        )
        return
      }
      cancelWait = () =>
        reject(
          Object.assign(new Error("Worktable channel stopped"), {
            code: "CHANNEL_STOPPED",
          })
        )
      signal.addEventListener("abort", cancelWait, { once: true })
    })

    try {
      await Promise.race([previous, aborted])
      if (cancelWait) signal.removeEventListener("abort", cancelWait)
      return await run()
    } finally {
      if (cancelWait) signal.removeEventListener("abort", cancelWait)
      release?.()
      if (this.#threadTails.get(threadKey) === tail) {
        this.#threadTails.delete(threadKey)
      }
    }
  }
}
