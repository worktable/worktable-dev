import {
  CLIENT_CAPABILITIES_META_KEY,
  createMcpHandler,
  isLegacyRequest,
  ProtocolError,
  Server,
  type ServerCapabilities,
  type ServerContext,
} from "@modelcontextprotocol/server"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type {
  CallToolResult,
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { PendingInput } from "./schemas.ts"
import { resolveParticipant } from "../participant-store.ts"
import { currentRequestIdentity } from "../team-policy.ts"
import {
  pendingIfReady,
  pendingRevision,
  type PendingEntry,
} from "../pending-list.ts"
import { noteWaiting, waitSince } from "../pending-wait.ts"
import {
  EventsError,
  listEvents,
  subscribe,
  unsubscribe,
  type EventsCaller,
} from "../mcp-events.ts"
import {
  createWorktableMcpServer,
  serverIdentity,
  type WorktableMcpServerOptions,
} from "./server.ts"

// ============================================================
// MCP 2026-07-28 ("modern" era) beside the initialize-based revisions
// ============================================================
//
// The SDK v2 handler owns the modern wire: server/discover, the per-request
// _meta envelope, header checks (-32020), unsupported versions (-32022) and
// resultType. The tools stay on the one server both eras share
// (createWorktableMcpServer): a modern tools/list or tools/call is handed to
// it as the same JSON-RPC request a legacy client sends, so both eras list
// and answer identically. Methods only the modern era has, such as the tasks
// extension's tasks/get or events/*, register on the modern Server below.

export interface ModernMcpExchange {
  /** The options the shared server is built with for this request. */
  server: WorktableMcpServerOptions
  /**
   * Relay progress notifications, which streams the response (SSE). Only for
   * local connections, as on the legacy path.
   */
  stream: boolean
}

/** Per-request exchanges, keyed by the request the handler hands its factory. */
const exchanges = new WeakMap<Request, ModernMcpExchange>()

// Stateless: a fresh Server per request, from the factory. "auto" answers
// with JSON unless a handler sends progress first, which only a streaming
// exchange relays.
const handler = createMcpHandler(
  ({ requestInfo }) => {
    const exchange = requestInfo && exchanges.get(requestInfo)
    if (!exchange) throw new Error("No MCP exchange for this request")
    return createModernServer(exchange)
  },
  { legacy: "reject", responseMode: "auto" }
)

/**
 * The parsed body of a modern-era request, or undefined when the request is
 * legacy: no JSON body, or no per-request _meta claim (initialize and every
 * 2025-era message). Classification is the SDK's own, so a request with a
 * malformed or mismatched claim still goes to the modern path, which answers
 * it with the right error.
 */
export async function modernMcpRequestBody(
  request: Request
): Promise<{ body: unknown } | undefined> {
  if (request.method !== "POST") return undefined
  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return undefined
  }
  // Passing the parsed body also keeps the SDK's 4 MiB read limit, which the
  // legacy path doesn't have, from classifying a large legacy call modern.
  return (await isLegacyRequest(request, body)) ? undefined : { body }
}

export async function handleModernMcpRequest(
  request: Request,
  body: unknown,
  exchange: ModernMcpExchange
): Promise<Response> {
  exchanges.set(request, exchange)
  try {
    return await handler.fetch(request, { parsedBody: body })
  } finally {
    exchanges.delete(request)
  }
}

function createModernServer(exchange: ModernMcpExchange): Server {
  const { info, instructions } = serverIdentity(exchange.server)
  // Pending waits are released. Both tool surfaces use the same task path.
  const server = new Server(info, {
    capabilities: {
      tools: {},
      events: {},
      extensions: { [TASKS_EXTENSION]: {} },
    } as ServerCapabilities,
    instructions,
  })
  server.setRequestHandler("tools/list", (request, ctx) =>
    relay(exchange, request, ctx)
  )
  server.setRequestHandler("tools/call", (request, ctx) => {
    const wait = runsTasks(ctx) ? pendingWait(request) : undefined
    return wait
      ? (startPendingWait(exchange, request, wait, ctx) as never)
      : relay(exchange, request, ctx)
  })
  server.setRequestHandler("tasks/get", { params: TaskParams }, (params, ctx) =>
    pendingWaitTask(exchange, params.taskId, ctx)
  )
  // A wait holds nothing on the server, so there is nothing to stop or
  // answer: the client just stops asking.
  server.setRequestHandler("tasks/cancel", { params: TaskParams }, () => ({}))
  server.setRequestHandler("tasks/update", { params: TaskParams }, () => ({}))
  server.setRequestHandler("events/list", { params: z.unknown() }, () =>
    listEvents()
  )
  server.setRequestHandler(
    "events/subscribe",
    { params: z.unknown() },
    (params) => eventsCall(exchange, (caller) => subscribe(caller, params))
  )
  server.setRequestHandler(
    "events/unsubscribe",
    { params: z.unknown() },
    (params) => eventsCall(exchange, (caller) => unsubscribe(caller, params))
  )
  return server
}

/**
 * Run an events method as the calling agent. Subscriptions belong to an agent's
 * sign-in, so the local owner, who has none, cannot subscribe.
 */
async function eventsCall<T>(
  exchange: ModernMcpExchange,
  run: (caller: EventsCaller) => Promise<T>
): Promise<T> {
  const partial = exchange.server.identity
  if (!partial) {
    throw new ProtocolError(-32600, "Subscribe with an agent's sign-in")
  }
  // The request's whole identity when it is this caller's: on Teams,
  // deliveries check access with its team binding.
  const full = currentRequestIdentity()
  const identity =
    full && full.principal.id === partial.principal.id
      ? full
      : { ...partial, scopes: exchange.server.scopes ?? [] }
  try {
    return await run({ identity, origin: exchange.server.urlOrigin ?? "" })
  } catch (error) {
    if (error instanceof EventsError)
      throw new ProtocolError(error.code, error.message, error.data)
    throw error
  }
}

// ============================================================
// Waiting for pending items as an MCP task
// ============================================================
//
// worktable_pending with wait: true answers a task-capable
// client at once with a task. Each tasks/get asks the pending read, as the
// caller, for items after the revision the wait started from; the first answer
// with items completes the task with exactly what that read returned, and
// marks those items delivered. The task id carries the whole wait (scope and
// revision), so the server keeps no task state and a restart loses nothing.
// As with every wait (pending-wait.ts), polls select by revision only, so a
// poll repeated after a lost answer gets the same items again.
// Whoever asks reads only their own pending items, so a copied id reveals
// nothing.

const TASKS_EXTENSION = "io.modelcontextprotocol/tasks"
/** How often a waiting client should ask; also how long items batch. */
const WAIT_POLL_MS = 5_000

const TaskParams = z.object({ taskId: z.string().min(1) })

const WaitTask = z.object({
  v: z.literal(1),
  at: z.string(),
  since: z.number().int().nonnegative(),
  scope: z
    .object({
      spaceId: z.string().optional(),
      docPath: z.string().optional(),
      threadId: z.string().optional(),
    })
    .optional(),
})
type WaitTask = z.infer<typeof WaitTask>
type WaitArgs = Omit<WaitTask, "v" | "at" | "since"> & { since?: number }

/** Whether this request's client declared the tasks extension. */
function runsTasks(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    | { extensions?: Record<string, unknown> }
    | undefined
  return Boolean(capabilities?.extensions?.[TASKS_EXTENSION])
}

/** The wait a tools/call asks for, when it is a pending read with wait. */
function pendingWait(request: {
  params?: Record<string, unknown>
}): WaitArgs | undefined {
  const args = request.params?.["arguments"] as
    | Record<string, unknown>
    | undefined
  const name = request.params?.["name"]
  const legacy = args?.request as Record<string, unknown> | undefined
  const read = name === "worktable_pending" ? args : legacy
  if (
    !(
      name === "worktable_pending" ||
      (name === "worktable_discover" && legacy?.["action"] === "pending")
    ) ||
    read?.["wait"] !== true
  )
    return undefined
  const legacyArgs = Object.fromEntries(
    Object.entries(legacy ?? {}).filter(([key]) => key !== "action")
  )
  const parsed = PendingInput.strict().safeParse(
    name === "worktable_pending" ? args : legacyArgs
  )
  return parsed.success
    ? { since: parsed.data.since, scope: parsed.data.scope }
    : undefined
}

function pendingCall(read: Record<string, unknown>) {
  return {
    method: "tools/call",
    params: {
      name: "worktable_pending",
      arguments: read,
    },
  }
}

function taskStatus(task: WaitTask, taskId: string, now: string) {
  return {
    taskId,
    createdAt: task.at,
    lastUpdatedAt: now,
    ttlMs: null,
    pollIntervalMs: WAIT_POLL_MS,
  }
}

async function startPendingWait(
  exchange: ModernMcpExchange,
  request: { method: string; params?: Record<string, unknown> },
  wait: WaitArgs,
  ctx: ServerContext
) {
  let since = wait.since
  if (since === undefined) {
    // Wait for what arrives from now on: the count read gives the revision.
    const counted = await relay<CallToolResult>(
      exchange,
      pendingCall({ mode: "count" }),
      ctx
    )
    if (counted.isError) return counted
    since = Number(
      (counted.structuredContent as { revision?: unknown } | undefined)
        ?.revision ?? 0
    )
  }
  const at = new Date().toISOString()
  const task: WaitTask = {
    v: 1,
    at,
    since,
    ...(wait.scope ? { scope: wait.scope } : {}),
  }
  const taskId = Buffer.from(JSON.stringify(task)).toString("base64url")
  return {
    resultType: "task",
    status: "working",
    ...taskStatus(task, taskId, at),
  }
}

/**
 * The caller's identity, as the pending read uses it: the request's whole
 * identity when it is this caller's (on Teams it carries the team binding),
 * else the partial one the server is built with. A local connection's
 * request runs as the owner while its tools act as its agent.
 */
function callerIdentity(exchange: ModernMcpExchange) {
  const partial = exchange.server.identity
  const full = currentRequestIdentity()
  return full && partial && full.principal.id === partial.principal.id
    ? full
    : partial
}

/**
 * The caller's pending revision, and its open items when the list is ready,
 * without a read where the caller is known.
 */
async function callerPending(
  exchange: ModernMcpExchange,
  ctx: ServerContext
): Promise<{ revision: number; entries: PendingEntry[] | null }> {
  const identity = callerIdentity(exchange)
  if (identity) {
    const { participant } = await resolveParticipant(identity)
    noteWaiting(participant.id)
    return {
      revision: await pendingRevision(participant.id),
      entries: pendingIfReady(participant.id),
    }
  }
  const counted = await relay<CallToolResult>(
    exchange,
    pendingCall({ mode: "count" }),
    ctx
  )
  return {
    revision: Number(
      (counted.structuredContent as { revision?: unknown } | undefined)
        ?.revision ?? 0
    ),
    entries: null,
  }
}

async function pendingWaitTask(
  exchange: ModernMcpExchange,
  taskId: string,
  ctx: ServerContext
) {
  let task: WaitTask
  try {
    task = WaitTask.parse(
      JSON.parse(Buffer.from(taskId, "base64url").toString("utf8"))
    )
  } catch {
    throw new ProtocolError(-32602, "Unknown task")
  }
  const now = new Date().toISOString()
  // Nothing new in scope since the wait started: answer without building a
  // read. Items elsewhere move the revision, so they are filtered here too,
  // or every later poll would run a full read.
  const { revision, entries } = await callerPending(exchange, ctx)
  if (revision === task.since) {
    return { status: "working", ...taskStatus(task, taskId, now) }
  }
  const since = waitSince(task.since, revision)
  const scope = task.scope ?? {}
  if (
    entries &&
    !entries.some(
      (entry) =>
        entry.revision > since &&
        (!scope.spaceId || entry.scope.spaceId === scope.spaceId) &&
        (!scope.threadId || entry.scope.threadId === scope.threadId)
    )
  ) {
    return { status: "working", ...taskStatus(task, taskId, now) }
  }
  const read = await relay<CallToolResult>(
    exchange,
    pendingCall({
      mode: "notices",
      since,
      ...(task.scope ? { scope: task.scope } : {}),
    }),
    ctx
  )
  const items = (read.structuredContent as { items?: unknown[] } | undefined)
    ?.items
  if (!read.isError && !items?.length) {
    return { status: "working", ...taskStatus(task, taskId, now) }
  }
  return { status: "completed", ...taskStatus(task, taskId, now), result: read }
}

/**
 * Hand one modern request to a fresh shared server as its legacy form and
 * resolve with that server's result. Its progress goes to the modern client
 * when the exchange streams; a cancelled modern request closes the server,
 * which aborts the call.
 */
async function relay<T>(
  exchange: ModernMcpExchange,
  request: { method: string; params?: Record<string, unknown> },
  ctx: ServerContext
): Promise<T> {
  const { id, signal } = ctx.mcpReq
  const server = createWorktableMcpServer(exchange.server)
  let transport!: Transport
  const response = new Promise<JSONRPCMessage>((resolve, reject) => {
    transport = {
      async start() {},
      async send(message) {
        if ("id" in message && message.id === id) {
          if ("result" in message || "error" in message) resolve(message)
        } else if (
          exchange.stream &&
          "method" in message &&
          !("id" in message)
        ) {
          await ctx.mcpReq.notify(message)
        }
      },
      async close() {
        reject(new Error("The MCP request was cancelled"))
        transport.onclose?.()
      },
    }
  })
  const cancel = () => void server.close()
  signal.addEventListener("abort", cancel, { once: true })
  try {
    await server.connect(transport)
    transport.onmessage?.({
      jsonrpc: "2.0",
      id,
      method: request.method,
      // The envelope's io.modelcontextprotocol/* keys are lifted out of
      // ctx.mcpReq._meta; what remains (progressToken) is legacy-shaped.
      params: { ...request.params, _meta: ctx.mcpReq._meta },
    })
    const message = await response
    if ("error" in message) {
      throw new ProtocolError(
        message.error.code,
        message.error.message,
        message.error.data
      )
    }
    return (message as { result: T }).result
  } finally {
    signal.removeEventListener("abort", cancel)
    void server.close()
  }
}
