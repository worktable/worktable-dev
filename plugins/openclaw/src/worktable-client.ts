import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { AGENT_PRESENTATION_HEADERS } from "./worktable-contract"
import type { WorktableAgentCredentialProvider } from "./agent-auth.js"
import type {
  ClaimedWorktableDelivery,
  ThreadProgress,
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

export class McpWorktableClient implements WorktableClient {
  readonly #client = new Client({
    name: "@worktable/openclaw",
    version: "0.0.12",
  })
  readonly #transport: StreamableHTTPClientTransport
  #connected = false

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
    const endpoint =
      typeof auth === "string"
        ? worktableMcpEndpoint(server)
        : new URL(auth.provider.resource)
    const authenticatedFetch =
      typeof auth === "string"
        ? fetch
        : async (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1]
          ) => {
            const presentationHeaders = worktableAgentPresentationHeaders(auth)
            const run = async () => {
              const headers = new Headers(init?.headers)
              headers.set(
                "Authorization",
                `Bearer ${await auth.provider.accessToken()}`
              )
              for (const [name, value] of Object.entries(presentationHeaders)) {
                headers.set(name, value)
              }
              return fetch(input, { ...init, headers })
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
    this.#transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        ...(typeof auth === "string"
          ? { headers: { Authorization: `Bearer ${auth}` } }
          : {}),
      },
      fetch: authenticatedFetch as typeof fetch,
      reconnectionOptions: {
        initialReconnectionDelay: 500,
        maxReconnectionDelay: 10_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 3,
      },
    })
  }

  async registerParticipant(name: string): Promise<WorktableParticipant> {
    const result = await this.#call("worktable_threads_write", {
      action: "register_participant",
      name,
    })
    return result.participant as WorktableParticipant
  }

  async #ensureConnected(): Promise<void> {
    if (this.#connected) return
    await this.#client.connect(this.#transport)
    this.#connected = true
  }

  async #call(
    name: string,
    request: Record<string, unknown>,
    onProgress?: (progress: ThreadProgress) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    await this.#ensureConnected()
    const result = await this.#client.callTool(
      { name, arguments: { request } },
      undefined,
      {
        timeout: 35_000,
        resetTimeoutOnProgress: true,
        signal,
        onprogress: onProgress
          ? async (notification) => {
              await onProgress({
                state: notification.message ?? "working",
                receivedCharacters:
                  typeof notification.progress === "number"
                    ? notification.progress
                    : undefined,
              })
            }
          : undefined,
      }
    )
    return textResult(result)
  }

  async close(): Promise<void> {
    if (!this.#connected) return
    this.#connected = false
    await this.#client.close()
  }

  async participants(): Promise<WorktableParticipant[]> {
    const result = await this.#call("worktable_threads_read", {
      action: "participants",
    })
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
      (request) =>
        this.#call("worktable_thread_delivery", request, undefined, signal),
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
    to: string
    inReplyTo: string
    body: string
    idempotencyKey: string
  }): Promise<WorktablePostResult> {
    return (await this.#call("worktable_threads_write", {
      action: "post",
      ...input,
      expectsReply: false,
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
