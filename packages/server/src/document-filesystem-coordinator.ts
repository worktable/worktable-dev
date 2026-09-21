import type {
  DocChangeEvent,
  DocumentCorpusChangeEvent,
  WidgetChangeEvent,
} from "./workspace-events.ts"

const DEFAULT_DEBOUNCE_MS = 250
const DEFAULT_MAX_BATCH_DELAY_MS = 1_000
// The same cap bounds exact events and conservative per-Space overflow events.
const DEFAULT_MAX_PENDING_EVENTS = 10_000

export type DocumentFilesystemChangeEvent =
  | DocChangeEvent
  | WidgetChangeEvent
  | DocumentCorpusChangeEvent

export interface DocumentFilesystemCoordinatorOptions {
  emit: (event: DocumentFilesystemChangeEvent) => unknown
  debounceMs?: number
  maxBatchDelayMs?: number
  maxPendingEvents?: number
  onError?: (error: unknown) => void
}

function eventKey(event: DocumentFilesystemChangeEvent): string {
  return event.type === "doc"
    ? `doc\0${event.spaceId}\0${event.docPath}`
    : event.type === "widget"
      ? `widget\0${event.spaceId}\0${event.widgetId}`
      : `corpus\0${event.spaceId}`
}

function deduplicateEvents(
  events: readonly DocumentFilesystemChangeEvent[]
): DocumentFilesystemChangeEvent[] {
  return [...new Map(events.map((event) => [eventKey(event), event])).values()]
}

export class DocumentFilesystemCoordinator {
  private readonly emitEvent: DocumentFilesystemCoordinatorOptions["emit"]
  private readonly onError?: DocumentFilesystemCoordinatorOptions["onError"]
  private readonly debounceMs: number
  private readonly maxBatchDelayMs: number
  private readonly maxPendingEvents: number
  private readonly pendingEvents = new Map<
    string,
    DocumentFilesystemChangeEvent
  >()
  private readonly overflowSpaces = new Set<string>()
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private overflowed = false
  private overflowLimitReported = false
  private discardPending = false
  private stopped = false

  constructor(options: DocumentFilesystemCoordinatorOptions) {
    if (
      !Number.isSafeInteger(options.maxPendingEvents ?? 1) ||
      (options.maxPendingEvents ?? 1) < 1
    ) {
      throw new Error("maxPendingEvents must be a positive safe integer")
    }
    if (
      !Number.isFinite(options.debounceMs ?? 0) ||
      (options.debounceMs ?? 0) < 0
    ) {
      throw new Error("debounceMs must be a non-negative finite number")
    }
    if (
      !Number.isFinite(options.maxBatchDelayMs ?? 0) ||
      (options.maxBatchDelayMs ?? 0) < 0
    ) {
      throw new Error("maxBatchDelayMs must be a non-negative finite number")
    }
    this.emitEvent = options.emit
    this.onError = options.onError
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.maxBatchDelayMs =
      options.maxBatchDelayMs ?? DEFAULT_MAX_BATCH_DELAY_MS
    this.maxPendingEvents =
      options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS
  }

  note(event: DocumentFilesystemChangeEvent): void {
    if (this.stopped) return
    if (this.overflowed) {
      this.addOverflowSpace(event.spaceId)
      return
    } else {
      const key = eventKey(event)
      if (this.pendingEvents.has(key)) {
        this.pendingEvents.set(key, event)
      } else if (this.pendingEvents.size < this.maxPendingEvents) {
        this.pendingEvents.set(key, event)
      } else {
        this.overflowed = true
        for (const pending of this.pendingEvents.values()) {
          this.addOverflowSpace(pending.spaceId)
        }
        this.pendingEvents.clear()
        this.addOverflowSpace(event.spaceId)
        this.scheduleFlush(true)
        return
      }
    }
    this.scheduleFlush(false)
  }

  async flush(): Promise<void> {
    this.clearTimers()
    if (this.hasPendingWork()) this.ensureWorker()
    await this.running
  }

  async drain(): Promise<void> {
    while (true) {
      await this.flush()
      if (!this.hasPendingWork()) return
    }
  }

  async stop({
    flushPending = true,
  }: { flushPending?: boolean } = {}): Promise<void> {
    if (!this.stopped) {
      this.stopped = true
      this.clearTimers()
    }
    if (flushPending) {
      await this.drain()
      return
    }
    this.discardPending = true
    this.pendingEvents.clear()
    this.overflowSpaces.clear()
    this.overflowed = false
    await this.running
  }

  private scheduleFlush(immediate: boolean): void {
    if (immediate) {
      this.clearTimers()
      this.quietTimer = setTimeout(() => this.flushFromTimer(), 0)
      this.quietTimer.unref?.()
      return
    }
    this.clearQuietTimer()
    this.quietTimer = setTimeout(
      () => this.flushFromTimer(),
      this.debounceMs
    )
    this.quietTimer.unref?.()
    if (this.maxTimer) return
    this.maxTimer = setTimeout(
      () => this.flushFromTimer(),
      this.maxBatchDelayMs
    )
    this.maxTimer.unref?.()
  }

  private flushFromTimer(): void {
    this.clearTimers()
    void this.flush().catch((error: unknown) => this.reportError(error))
  }

  private clearQuietTimer(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = null
  }

  private clearTimers(): void {
    this.clearQuietTimer()
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.maxTimer = null
  }

  private hasPendingWork(): boolean {
    return this.pendingEvents.size > 0 || this.overflowed
  }

  private takePendingBatch(): DocumentFilesystemChangeEvent[] | null {
    if (!this.hasPendingWork()) return null
    if (this.overflowed) {
      const events = [...this.overflowSpaces].sort().map(
        (spaceId): DocumentCorpusChangeEvent => ({
          type: "documentCorpus",
          spaceId,
        })
      )
      this.overflowSpaces.clear()
      this.overflowed = false
      this.overflowLimitReported = false
      return events
    }
    const events = [...this.pendingEvents.values()]
    this.pendingEvents.clear()
    return events
  }

  private addOverflowSpace(spaceId: string): void {
    if (
      this.overflowSpaces.has(spaceId) ||
      this.overflowSpaces.size < this.maxPendingEvents
    ) {
      this.overflowSpaces.add(spaceId)
      return
    }
    if (this.overflowLimitReported) return
    this.overflowLimitReported = true
    this.reportError(
      new Error(
        `document filesystem overflow exceeded ${this.maxPendingEvents} affected Spaces; additional Space events were dropped`
      )
    )
  }

  private ensureWorker(): void {
    if (this.running) return
    const task = this.processPending()
    this.running = task
    const clear = (): void => {
      if (this.running === task) this.running = null
    }
    void task.then(clear, clear)
  }

  private async processPending(): Promise<void> {
    while (true) {
      if (this.discardPending) return
      const batch = this.takePendingBatch()
      if (!batch) {
        this.clearTimers()
        return
      }
      await this.processBatch(batch)
    }
  }

  private async processBatch(
    events: readonly DocumentFilesystemChangeEvent[]
  ): Promise<void> {
    for (const event of deduplicateEvents(events)) {
      if (this.discardPending) return
      await this.emitEvent(event)
    }
  }

  private reportError(error: unknown): void {
    if (this.onError) {
      try {
        this.onError(error)
        return
      } catch (reportingError) {
        console.error(
          "[document-filesystem] error reporter failed:",
          reportingError
        )
      }
    }
    console.error("[document-filesystem] batch error:", error)
  }
}
