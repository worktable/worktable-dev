import { name as packageName, version as packageVersion } from "../package.json"
import { AGENT_PRESENTATION_HEADERS } from "./worktable-contract"
import type { WorktableAgentCredentialProvider } from "./agent-auth.js"
import type {
  ClaimedWorktableDelivery,
  WorktableClient,
  WorktableParticipant,
  WorktablePostResult,
  WorktableThreadSummary,
} from "./types.js"

export function worktableMcpEndpoint(server: string): URL {
  const url = new URL(server)
  const basePath = url.pathname.replace(/\/+$/, "")
  if (!basePath.endsWith("/mcp")) url.pathname = `${basePath}/mcp`
  return url
}

function textResult(result: unknown): Record<string, unknown> {
  const response = result as {
    isError?: boolean
    content?: Array<{ type: string; text?: string }>
  }
  const text = response.content?.find((item) => item.type === "text")?.text
  if (!text) throw new Error("Worktable MCP returned no text result")
  if (response.isError) {
    try {
      const parsed = JSON.parse(text) as { code?: string; error?: string }
      const error = new Error(parsed.error ?? text)
      Object.assign(error, { code: parsed.code })
      throw error
    } catch (error) {
      if (error instanceof Error && "code" in error) throw error
      throw new Error(text)
    }
  }
  return JSON.parse(text) as Record<string, unknown>
}

type ThreadDeliveryCall = (
  request: Record<string, unknown>
) => Promise<Record<string, unknown>>

export function claimWithThreadLocations(
  call: ThreadDeliveryCall,
  waitSeconds: number
): Promise<Record<string, unknown>> {
  return call({
    action: "claim",
    waitSeconds,
    threadLocationVersion: 2,
  })
}

function presentationHeaderValue(
  value: string,
  maxLength: number,
  fallback: string
): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return (normalized || fallback).slice(0, maxLength)
}

export function worktableAgentPresentationHeaders(input: {
  adapter: string
  installationId: string
  label: string
  machine?: string
}): Record<string, string> {
  return {
    [AGENT_PRESENTATION_HEADERS.ADAPTER]: presentationHeaderValue(
      input.adapter,
      64,
      "agent"
    ),
    [AGENT_PRESENTATION_HEADERS.INSTALLATION]: presentationHeaderValue(
      input.installationId,
      256,
      "unknown"
    ),
    [AGENT_PRESENTATION_HEADERS.LABEL]: presentationHeaderValue(
      input.label,
      160,
      "OpenClaw"
    ),
    ...(input.machine
      ? {
          [AGENT_PRESENTATION_HEADERS.MACHINE]: presentationHeaderValue(
            input.machine,
            160,
            "unknown"
          ),
        }
      : {}),
  }
}

// Worktable answers MCP POSTs with plain JSON (stateless, no sessions), so the
// adapter speaks JSON-RPC over fetch itself instead of bundling an MCP SDK.
// Streamed (SSE) responses are still read for servers that choose them.
const MCP_PROTOCOL_VERSION = "2025-11-25"
const REQUEST_TIMEOUT_MS = 35_000

type JsonRpcMessage = {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  result?: unknown
  error?: { code?: unknown; message?: unknown; data?: unknown }
}

function rpcError(error: NonNullable<JsonRpcMessage["error"]>): Error {
  const message =
    typeof error.message === "string" ? error.message : "Unknown error"
  return Object.assign(
    new Error(`MCP error ${String(error.code)}: ${message}`),
    {
      code: error.code,
      data: error.data,
    }
  )
}

function matchingResponse(
  value: unknown,
  id: number
): JsonRpcMessage | undefined {
  const messages = Array.isArray(value) ? value : [value]
  return messages.find(
    (message): message is JsonRpcMessage =>
      typeof message === "object" &&
      message !== null &&
      (message as JsonRpcMessage).id === id &&
      ("result" in message || "error" in message)
  )
}

async function responseFromEventStream(
  body: ReadableStream<Uint8Array>,
  id: number
): Promise<JsonRpcMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let data: string[] = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.search(/\r\n|\n|\r(?!$)/)) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(
          newline + (buffer.startsWith("\r\n", newline) ? 2 : 1)
        )
        if (line === "") {
          if (data.length > 0) {
            const response = matchingResponse(
              JSON.parse(data.join("\n")) as unknown,
              id
            )
            if (response) return response
          }
          data = []
        } else if (line.startsWith("data:")) {
          data.push(line.slice(line.startsWith("data: ") ? 6 : 5))
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  throw new Error("Worktable MCP stream ended without a response")
}

export class McpWorktableClient implements WorktableClient {
  readonly #endpoint: URL
  readonly #send: (init: RequestInit) => Promise<Response>
  readonly #closing = new AbortController()
  #initialized = false
  #initializing?: Promise<void>
  #protocolVersion?: string
  #sessionId?: string
  #nextId = 1

  constructor(
    server: string,
    auth:
      | string
      | {
          provider: WorktableAgentCredentialProvider
          adapter: string
          installationId: string
          label: string
          machine?: string
        }
  ) {
    this.#endpoint =
      typeof auth === "string"
        ? worktableMcpEndpoint(server)
        : new URL(auth.provider.resource)
    if (typeof auth === "string") {
      this.#send = (init) => {
        const headers = new Headers(init.headers)
        headers.set("Authorization", `Bearer ${auth}`)
        return fetch(this.#endpoint, { ...init, headers })
      }
      return
    }
    const presentationHeaders = worktableAgentPresentationHeaders(auth)
    this.#send = async (init) => {
      const run = async () => {
        const headers = new Headers(init.headers)
        headers.set(
          "Authorization",
          `Bearer ${await auth.provider.accessToken()}`
        )
        for (const [name, value] of Object.entries(presentationHeaders)) {
          headers.set(name, value)
        }
        return fetch(this.#endpoint, { ...init, headers })
      }
      const response = await run()
      if (response.status !== 401) return response
      const problem = (await response
        .clone()
        .json()
        .catch(() => null)) as { code?: unknown } | null
      if (problem?.code === "AGENT_DISCONNECTED") return response
      auth.provider.invalidate()
      return run()
    }
  }

  async registerParticipant(name: string): Promise<WorktableParticipant> {
    const result = await this.#call("worktable_thread_delivery", {
      action: "register_participant",
      name,
    })
    return result.participant as WorktableParticipant
  }

  async #post(
    message: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Response> {
    if (this.#closing.signal.aborted)
      throw new Error("Worktable client is closed")
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    }
    if (this.#protocolVersion)
      headers["mcp-protocol-version"] = this.#protocolVersion
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId
    const signals = [
      this.#closing.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]
    if (signal) signals.push(signal)
    try {
      const response = await this.#send({
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", ...message }),
        signal: AbortSignal.any(signals),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => "")
        throw Object.assign(
          new Error(
            `Worktable MCP returned HTTP ${response.status}${text ? `: ${text}` : ""}`
          ),
          { status: response.status }
        )
      }
      return response
    } catch (error) {
      if (this.#closing.signal.aborted)
        throw new Error("Worktable client is closed", { cause: error })
      throw error
    }
  }

  async #request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ result: unknown; response: Response }> {
    const id = this.#nextId++
    const response = await this.#post({ id, method, params }, signal)
    let message: JsonRpcMessage | undefined
    try {
      message = response.headers
        .get("content-type")
        ?.includes("text/event-stream")
        ? response.body
          ? await responseFromEventStream(response.body, id)
          : undefined
        : matchingResponse(await response.json(), id)
    } catch (error) {
      if (this.#closing.signal.aborted)
        throw new Error("Worktable client is closed", { cause: error })
      throw error
    }
    if (!message)
      throw new Error(`Worktable MCP returned no response to ${method}`)
    if (message.error) throw rpcError(message.error)
    return { result: message.result, response }
  }

  async #initialize(): Promise<void> {
    const { result, response } = await this.#request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: packageName, version: packageVersion },
    })
    const negotiated = (result as { protocolVersion?: unknown } | undefined)
      ?.protocolVersion
    if (typeof negotiated !== "string")
      throw new Error(
        "Worktable MCP initialization returned no protocol version"
      )
    this.#protocolVersion = negotiated
    this.#sessionId = response.headers.get("mcp-session-id") ?? undefined
    const notified = await this.#post({ method: "notifications/initialized" })
    await notified.body?.cancel()
  }

  async #ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (this.#closing.signal.aborted)
      throw new Error("Worktable client is closed")
    if (this.#initialized) return
    // One shared handshake; a failed attempt is cleared so the connector's
    // bounded retry starts a fresh one. A caller's signal only abandons its
    // own wait, not the handshake other callers share.
    this.#initializing ??= this.#initialize().then(
      () => {
        this.#initialized = true
        this.#initializing = undefined
      },
      (error: unknown) => {
        this.#protocolVersion = undefined
        this.#sessionId = undefined
        this.#initializing = undefined
        throw error
      }
    )
    const initializing = this.#initializing
    if (!signal) return initializing
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      initializing.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", abort)
      })
    })
  }

  async #call(
    name: string,
    request: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    await this.#ensureInitialized(signal)
    const { result } = await this.#request(
      "tools/call",
      { name, arguments: { request } },
      signal
    )
    return textResult(result)
  }

  async close(): Promise<void> {
    // Aborts in-flight requests, including an unfinished initialization.
    this.#closing.abort()
    this.#initialized = false
  }

  async participants(signal?: AbortSignal): Promise<WorktableParticipant[]> {
    const result = await this.#call(
      "worktable_threads_read",
      {
        action: "participants",
      },
      signal
    )
    return result.participants as WorktableParticipant[]
  }

  async listThreads(spaceId?: string): Promise<WorktableThreadSummary[]> {
    const result = await this.#call("worktable_threads_read", {
      action: "list",
      ...(spaceId ? { spaceId } : {}),
    })
    return result.threads as WorktableThreadSummary[]
  }

  async claim(
    waitSeconds = 25,
    signal?: AbortSignal
  ): Promise<ClaimedWorktableDelivery | null> {
    const result = await claimWithThreadLocations(
      (request) => this.#call("worktable_thread_delivery", request, signal),
      waitSeconds
    )
    return (result.delivery as ClaimedWorktableDelivery | null) ?? null
  }

  async accept(messageId: string, leaseId: string): Promise<void> {
    await this.#call("worktable_thread_delivery", {
      action: "accept",
      messageId,
      leaseId,
    })
  }

  async progress(
    messageId: string,
    leaseId: string,
    phase: "working" | "receiving",
    receivedCharacters?: number
  ): Promise<void> {
    await this.#call("worktable_thread_delivery", {
      action: "progress",
      messageId,
      leaseId,
      phase,
      receivedCharacters,
    })
  }

  async fail(
    messageId: string,
    leaseId: string,
    retryable: boolean,
    code: string,
    message: string
  ): Promise<void> {
    await this.#call("worktable_thread_delivery", {
      action: "fail",
      messageId,
      leaseId,
      retryable,
      code,
      message,
    })
  }

  async reply(input: {
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
    return (await this.#call("worktable_threads_write", {
      action: "post",
      ...input,
      ...(input.responseTo
        ? { notifyIdentityIds: [], responseIdentityId: null }
        : { expectsReply: false }),
      waitSeconds: 0,
    })) as unknown as WorktablePostResult
  }

  async post(input: {
    to?: string
    threadId?: string
    location?: import("./types.js").WorktableThreadLocation
    spaceId?: string
    body: string
    idempotencyKey: string
  }): Promise<WorktablePostResult> {
    return (await this.#call("worktable_threads_write", {
      action: "post",
      ...input,
      waitSeconds: 0,
    })) as unknown as WorktablePostResult
  }
}
