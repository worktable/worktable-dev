import type { ToolBroker } from "./controller.ts"

export interface ToolHostConfig {
  mode: "member" | "share" | "preview"
  spaceId?: string
  widgetId?: string
  apiBase?: string
}

interface Reply {
  ok: boolean
  status: number
  body: Record<string, unknown>
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The response is invalid.")
  return value as Record<string, unknown>
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096)
    throw new Error("An identifier is required.")
  return encodeURIComponent(value)
}

/** Browser authority stays here, outside the VM. This broker constructs only
 * the document's existing Records/state paths. The parent independently
 * checks the frame identity and authorizes each operation on the server. */
export function createToolBroker(
  config: ToolHostConfig,
  diagnostic: (code: string, message: string) => void
): ToolBroker & { close: () => void; ready: () => void } {
  const post = parent.postMessage.bind(parent)
  const token = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) =>
    part.toString(16).padStart(8, "0")
  ).join("-")
  const identity =
    config.mode === "share"
      ? {}
      : { spaceId: config.spaceId, widgetId: config.widgetId }
  const base = config.mode === "share" ? "/link" : config.apiBase
  if (
    config.mode !== "share" &&
    (typeof config.spaceId !== "string" ||
      typeof config.widgetId !== "string" ||
      typeof base !== "string" ||
      !base.startsWith("/api/spaces/"))
  )
    throw new Error("The tool configuration is invalid.")
  let closed = false
  let sequence = 0
  const pending = new Map<
    string,
    { finish: (value: Reply) => void; cancel: () => void }
  >()
  const subscriptions = new Set<{
    collection: string
    load: () => void
    close: () => void
  }>()

  function send(message: Record<string, unknown>): void {
    if (!closed) post({ ...identity, ...message }, "*")
  }

  function receive(event: MessageEvent): void {
    if (closed || event.source !== parent) return
    const value = event.data
    if (!value || typeof value !== "object") return
    if (
      ["worktable.api.response", "worktable.navigation.response"].includes(
        value.type
      ) &&
      typeof value.id === "string"
    ) {
      const request = pending.get(value.id)
      if (!request) return
      pending.delete(value.id)
      request.finish(value)
    } else if (
      value.type === "worktable.records.changed" &&
      typeof value.collection === "string"
    ) {
      for (const subscription of subscriptions)
        if (subscription.collection === value.collection) subscription.load()
    }
  }

  function request(
    type: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (closed) return Promise.reject(new Error("This tool has closed."))
    if (pending.size >= 40)
      return Promise.reject(new Error("Too many requests. Try again."))
    return new Promise((resolve, reject) => {
      // A frame-specific prefix also rejects late answers from a prior tool
      // when an iframe navigation retains the same WindowProxy.
      const id = `${token}-${++sequence}`
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error("The request timed out. Try again."))
      }, 30_000)
      pending.set(id, {
        cancel: () => {
          clearTimeout(timer)
          reject(new Error("This tool has closed."))
        },
        finish: (result) => {
          clearTimeout(timer)
          try {
            const body = object(result.body)
            if (!result.ok) {
              diagnostic(
                typeof body.code === "string"
                  ? body.code
                  : "TOOL_REQUEST_FAILED",
                typeof body.error === "string"
                  ? body.error
                  : "The request failed. Try again."
              )
              reject(new Error("The request failed. Try again."))
            } else resolve(body)
          } catch (error) {
            reject(error)
          }
        },
      })
      try {
        send({ type, id, ...payload })
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  }

  function api(
    path: string,
    method = "GET",
    body?: unknown
  ): Promise<Record<string, unknown>> {
    return request("worktable.api.request", {
      path,
      method,
      body: body === undefined ? null : JSON.stringify(body),
    })
  }

  function query(collection: unknown, value: unknown) {
    return api(
      `${base}/records/${identifier(collection)}/query`,
      "POST",
      value ?? {}
    )
  }

  let stateQueue: Promise<unknown> = Promise.resolve()
  function writeState(method: string, args: unknown[]): Promise<unknown> {
    const write = stateQueue.then(async () => {
      if (config.mode === "preview")
        throw unavailable(
          "PREVIEW_READ_ONLY",
          "Persistent writes are disabled during preview."
        )
      const snapshot = await api(`${base}/state`)
      const state = object(snapshot.state)
      const own = object(snapshot.visitorState ?? snapshot.state)
      const [key, value] = args
      let next: Record<string, unknown>
      if (method === "state.update") {
        next = object(key)
        if (config.mode === "share") {
          // Keep unchanged published defaults out of the tab-local overlay,
          // so a later publisher update can still reach this visitor.
          next = Object.fromEntries(
            Object.entries(next).filter(
              ([name, entry]) =>
                Object.hasOwn(own, name) ||
                JSON.stringify(entry) !== JSON.stringify(state[name])
            )
          )
        }
      } else {
        next =
          typeof key === "string"
            ? { ...own, [key]: value }
            : key && typeof key === "object" && !Array.isArray(key)
              ? { ...own, ...key }
              : {}
      }
      await api(`${base}/state`, "PUT", { state: next })
      if (method === "state.set" && typeof key === "string") return value
      return config.mode === "share" ? { ...state, ...next } : next
    })
    stateQueue = write.catch(() => {})
    return write
  }

  async function operation(method: string, args: unknown[]): Promise<unknown> {
    if (closed) throw new Error("This tool has closed.")
    if (method === "records.query") return query(args[0], args[1])
    if (
      ["records.create", "records.update", "records.delete"].includes(method)
    ) {
      if (config.mode !== "member")
        throw unavailable(
          config.mode === "share" ? "LINK_READ_ONLY" : "PREVIEW_READ_ONLY",
          config.mode === "share"
            ? "This link is view only."
            : "Persistent writes are disabled during preview."
        )
      const path = `${base}/records/${identifier(args[0])}`
      if (method === "records.create") {
        const options = args[2] == null ? {} : object(args[2])
        return (
          await api(path, "POST", {
            data: args[1],
            id: options.id,
            metadata: options.metadata,
          })
        ).record
      }
      const record = `${path}/${identifier(args[1])}`
      return method === "records.update"
        ? (await api(record, "PATCH", { data: args[2] })).record
        : api(record, "DELETE")
    }
    if (method === "state.get") {
      const snapshot = await api(`${base}/state`)
      const state = object(snapshot.state)
      return typeof args[0] === "string" ? state[args[0]] : state
    }
    if (method === "state.set" || method === "state.update")
      return writeState(method, args)
    if (method === "ui.notify") {
      diagnostic("widget_notice", String(args[0]).slice(0, 1000))
      return null
    }
    if (method === "navigation.openDocument") {
      if (config.mode !== "member" || !navigator.userActivation?.isActive)
        throw new Error("Open documents from a user action.")
      const path = args[0]
      if (typeof path !== "string" || !path.trim() || path.length > 4096)
        throw new Error("A document path is required.")
      return (
        await request("worktable.navigation.open-document", {
          path,
          navigationToken: token,
        })
      ).target
    }
    throw new Error("This operation is not available.")
  }

  function unavailable(code: string, message: string): Error {
    diagnostic(code, message)
    return new Error(message)
  }

  function subscribe(
    collection: string,
    value: unknown,
    changed: (result: unknown) => void
  ): () => void {
    identifier(collection)
    let stopped = closed
    let requested = 0
    let delivered = 0
    const subscription = {
      collection,
      load: () => {
        if (stopped) return
        const current = ++requested
        void query(collection, value).then(
          (result) => {
            if (!stopped && current > delivered) {
              delivered = current
              changed(result)
            }
          },
          () => {
            if (!stopped)
              diagnostic(
                "record_subscribe_load_failed",
                "Could not refresh records."
              )
          }
        )
      },
      close: () => {
        if (stopped) return
        stopped = true
        subscriptions.delete(subscription)
        send({ type: "worktable.unsubscribe", collection })
      },
    }
    if (closed) return () => {}
    subscriptions.add(subscription)
    // Subscribe before the first query. The parent's existing change cursor
    // priming then closes the initial query/subscription race.
    send({ type: "worktable.subscribe", collection })
    subscription.load()
    return subscription.close
  }

  function interacted(event: Event): void {
    if (event.isTrusted)
      send({ type: "worktable.interaction", navigationToken: token })
  }
  function close(): void {
    if (closed) return
    for (const subscription of subscriptions) subscription.close()
    send({ type: "worktable.navigation.frame-leaving", navigationToken: token })
    closed = true
    removeEventListener("message", receive)
    removeEventListener("pagehide", close)
    for (const type of ["pointerdown", "click", "keydown"])
      removeEventListener(type, interacted, true)
    for (const request of pending.values()) request.cancel()
    pending.clear()
  }
  addEventListener("message", receive)
  addEventListener("pagehide", close, { once: true })
  for (const type of ["pointerdown", "click", "keydown"])
    addEventListener(type, interacted, { capture: true, passive: true })
  send({ type: "worktable.navigation.handshake", navigationToken: token })
  return {
    request: operation,
    subscribe,
    close,
    ready: () =>
      send({ type: "worktable.document.ready", navigationToken: token }),
  }
}
