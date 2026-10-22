import { createToolRenderer } from "./renderer.ts"
import {
  toolEnvironment,
  TOOL_SOURCE_CHARACTERS,
  type ToolEnvironment,
} from "./protocol.ts"

// These bounds also protect the trusted page from excessive work requested by
// the VM. Keep them independent of the VM implementation and its own checks.
const MESSAGE_CHARACTERS = 512 * 1024
const QUEUED_CHARACTERS = 2 * 1024 * 1024
const MAX_QUEUED_TURNS = 64
const METHODS = new Set([
  "records.query",
  "records.create",
  "records.update",
  "records.delete",
  "state.get",
  "state.set",
  "state.update",
  "ui.notify",
  "navigation.openDocument",
])

export interface ToolBroker {
  request: (method: string, args: unknown[]) => Promise<unknown>
  subscribe: (
    collection: string,
    query: unknown,
    changed: (value: unknown) => void
  ) => () => void
}

interface Turn {
  id: number
  type: "start" | "receive"
  payload: string
  environment?: ToolEnvironment
}

/** The worker source is a build-owned bundle, never document data. The only
 * source this function gives to a browser Worker is that trusted bundle. */
export function startIsolatedTool(options: {
  root: HTMLElement
  workerSource: string
  source: string
  initialEnvironment: ToolEnvironment
  broker: ToolBroker
  /** Bounded engine diagnostics for the trusted host; never render as HTML. */
  fault: (detail?: string) => void
}): {
  close: () => void
  environment: (value: ToolEnvironment) => void
} {
  // Reject before allocating a worker or cloning authored input onto it.
  if (
    typeof options.source !== "string" ||
    options.source.length > TOOL_SOURCE_CHARACTERS
  )
    throw new Error("The tool source exceeds 512 KiB.")
  const initialEnvironment = toolEnvironment(options.initialEnvironment)
  const url = URL.createObjectURL(
    new Blob([options.workerSource], { type: "text/javascript" })
  )
  let worker: Worker
  try {
    worker = new Worker(url)
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
  // Keep the source alive until the worker has actually fetched and executed
  // it. Creating a Worker starts that load asynchronously.
  let closed = false
  let sequence = 0
  let active: Turn | undefined
  let queuedCharacters = 0
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let frame: number | undefined
  const queue: Turn[] = []
  const subscriptions = new Map<number, () => void>()
  const pending = new Set<number>()
  const renderer = createToolRenderer(options.root, ({ action, value }) =>
    enqueue({ type: "event", action, value })
  )
  let windowStarted = performance.now()
  let windowMessages = 0
  let windowRenders = 0

  function close(): void {
    if (closed) return
    closed = true
    clearTimeout(watchdog)
    if (frame !== undefined) cancelAnimationFrame(frame)
    worker.terminate()
    URL.revokeObjectURL(url)
    queue.length = 0
    queuedCharacters = 0
    pending.clear()
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear()
    renderer.clear()
  }
  function fault(detail?: string): void {
    if (!closed) {
      close()
      options.fault(detail?.slice(0, 256))
    }
  }
  function enqueue(value: unknown): void {
    if (closed) return
    const payload = JSON.stringify(value)
    if (
      payload.length > MESSAGE_CHARACTERS ||
      queue.length >= MAX_QUEUED_TURNS ||
      queuedCharacters + payload.length > QUEUED_CHARACTERS
    ) {
      fault()
      return
    }
    queue.push({ type: "receive", id: ++sequence, payload })
    queuedCharacters += payload.length
    advance()
  }
  function advance(): void {
    if (closed || active || !queue.length) return
    active = queue.shift()!
    queuedCharacters -= active.payload.length
    watchdog = setTimeout(
      () => fault("The tool worker timed out."),
      active.type === "start" ? 10_000 : 3_000
    )
    worker.postMessage(active)
  }
  function response(id: number, ok: boolean, value: unknown): void {
    if (!pending.delete(id) || closed) return
    enqueue(
      ok
        ? { type: "response", id, ok, value: value ?? null }
        : {
            type: "response",
            id,
            ok,
            code: "TOOL_REQUEST_FAILED",
            message: "The request failed. Try again.",
          }
    )
  }
  async function request(value: Record<string, unknown>): Promise<void> {
    const id = value.id as number
    if (
      typeof value.method !== "string" ||
      !Array.isArray(value.args) ||
      value.args.length > 3 ||
      pending.has(id) ||
      pending.size >= 40
    )
      throw new Error("Invalid tool request.")
    if (closed) return
    const args = value.args
    pending.add(id)
    try {
      if (value.method === "ui.render") {
        if (++windowRenders > 30) throw new Error("Too many view updates.")
        // One committed view per animation frame keeps the trusted thread free
        // for input. The request settles only after its view is committed.
        await new Promise<void>((resolve, reject) => {
          const draw = () => {
            frame = undefined
            try {
              if (!closed) renderer.render(args[0])
              resolve()
            } catch (error) {
              reject(error)
            }
          }
          // Rendering requests are serialized below, so only one frame exists.
          frame = requestAnimationFrame(draw)
        })
        response(id, true, null)
      } else if (METHODS.has(value.method)) {
        response(id, true, await options.broker.request(value.method, args))
      } else throw new Error("Unsupported tool request.")
    } catch {
      response(id, false, null)
    }
  }
  // Render requests are serialized, with a separate admission bound. Other
  // broker calls run concurrently so an awaited read cannot block an action.
  let rendering = Promise.resolve()
  let renderQueue = 0
  function accept(encoded: unknown): void {
    if (typeof encoded !== "string" || encoded.length > MESSAGE_CHARACTERS)
      throw new Error("Invalid tool message.")
    const value = JSON.parse(encoded) as Record<string, unknown>
    if (
      !value ||
      typeof value !== "object" ||
      !Number.isSafeInteger(value.id) ||
      (value.id as number) < 1
    )
      throw new Error("Invalid tool message.")
    if (value.type === "request") {
      if (value.method === "ui.render") {
        if (++renderQueue > 4) throw new Error("Too many pending views.")
        rendering = rendering
          .then(() => request(value))
          .finally(() => {
            renderQueue--
          })
        void rendering.catch(() => fault())
      } else void request(value).catch(() => fault())
    } else if (value.type === "subscribe") {
      if (
        typeof value.collection !== "string" ||
        subscriptions.has(value.id as number) ||
        subscriptions.size >= 40
      )
        throw new Error("Invalid subscription.")
      const id = value.id as number
      subscriptions.set(
        id,
        options.broker.subscribe(value.collection, value.query, (data) =>
          enqueue({ type: "subscription", id, value: data })
        )
      )
    } else if (value.type === "unsubscribe") {
      subscriptions.get(value.id as number)?.()
      subscriptions.delete(value.id as number)
    } else throw new Error("Unsupported tool message.")
  }
  worker.onmessage = (event) => {
    if (closed) return
    URL.revokeObjectURL(url)
    try {
      const value = event.data as Record<string, unknown>
      if (value?.type === "fault") {
        fault(typeof value.message === "string" ? value.message : undefined)
        return
      }
      if (
        !value ||
        value.type !== "result" ||
        !active ||
        value.id !== active.id ||
        !Array.isArray(value.messages) ||
        value.messages.length > 64
      )
        throw new Error("Invalid worker result.")
      clearTimeout(watchdog)
      if (performance.now() - windowStarted >= 1000) {
        windowStarted = performance.now()
        windowMessages = 0
        windowRenders = 0
      }
      windowMessages += value.messages.length
      if (windowMessages > 120)
        throw new Error("The tool is sending too many messages.")
      // Keep active set while accepting a batch so synchronous subscriptions
      // cannot start another turn midway through this result.
      for (const message of value.messages) accept(message)
      active = undefined
      advance()
    } catch {
      fault("The tool worker returned an invalid result.")
    }
  }
  worker.onerror = (event) =>
    fault(event.message || "The tool worker could not load.")
  worker.onmessageerror = () => fault("The worker returned an invalid message.")
  queue.push({
    type: "start",
    id: ++sequence,
    payload: options.source,
    environment: initialEnvironment,
  })
  queuedCharacters = options.source.length
  advance()
  return {
    close,
    environment: (value) =>
      enqueue({ type: "environment", value: toolEnvironment(value) }),
  }
}
