import { AsyncLocalStorage } from "node:async_hooks"
import { PostHog } from "posthog-node"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js"
import {
  MCP_CLIENTS,
  type SupportedMcpClientId,
} from "@worktable/types/mcp-clients"
import {
  ANALYTICS_CLIENT_NAMES,
  ANALYTICS_GRANT_TTL_MS,
  ANALYTICS_HEADER,
  ANALYTICS_REPORT_HEADER,
  ANALYTICS_REPORT_MAX,
  ANALYTICS_SCHEMA_VERSION,
  isAnalyticsClient,
  type AnalyticsGrant,
  type AnalyticsReport,
  type ProductAnalyticsEvent,
  type ProductAnalyticsProperties,
} from "@worktable/hosted-contract"
import { gatewayAdmits, isHosted, trustedGatewayPrincipal } from "./hosted.ts"
import type { TokenIdentity } from "./token-store.ts"
import { isAccessRefusal } from "./mcp/helpers.ts"

/**
 * Marks a hosted app page as sending no product analytics of its own, so the
 * Cloud gateway counts the visit (`product:opened`) instead.
 */
export const PRODUCT_OPENED_HEADER = "x-worktable-product-opened"

function withHeader(response: Response, name: string, value: string): Response {
  try {
    response.headers.set(name, value)
    return response
  } catch {
    const copy = new Response(response.body, response)
    copy.headers.set(name, value)
    return copy
  }
}

export function countedByGateway(response: Response): Response {
  if (
    !isHosted() ||
    !(response.headers.get("Content-Type") ?? "").startsWith("text/html")
  )
    return response
  return withHeader(response, PRODUCT_OPENED_HEADER, "gateway")
}

export interface SaveAnalyticsContext {
  contributors: Array<AnalyticsGrant | null>
  protocolVersion?: string
  clientName?: string
  /**
   * An MCP request whose events the gateway sends: what it did so far. Gone
   * once the response carries it.
   */
  report?: AnalyticsReport
}
const context = new AsyncLocalStorage<SaveAnalyticsContext | null>()
let client: PostHog | null = null
let pending = 0
const deliveries = new Set<Promise<void>>()
// An account's consent, rechecked at most once a minute: the same window the
// gateway's grant allows, so a withdrawal still stops collection within it.
const CONSENT_TTL_MS = 60_000
/**
 * How far a hosted Worktable's clock may differ from the gateway's. A Sprite
 * resumed from sleep can run minutes behind; with no allowance it refused
 * every grant, which the gateway issues for exactly ANALYTICS_GRANT_TTL_MS.
 * The consent recheck at delivery still bounds how long a withdrawal takes.
 */
const GRANT_CLOCK_SKEW_MS = 15 * 60_000
const consents = new Map<string, { enabled: boolean; until: number }>()

function configuration() {
  const token = process.env["POSTHOG_PROJECT_TOKEN"]
  const host = process.env["POSTHOG_API_HOST"]
  const consentUrl = process.env["WORKTABLE_ANALYTICS_CONSENT_URL"]
  const runtimeId = process.env["WORKTABLE_ANALYTICS_RUNTIME_ID"]
  const worktableId = process.env["WORKTABLE_CLOUD_WORKSPACE_ID"]
  if (
    !isHosted() ||
    process.env["WORKTABLE_ANALYTICS_ENABLED"] !== "true" ||
    !token ||
    !host ||
    !consentUrl ||
    !runtimeId ||
    !worktableId
  )
    return null
  return { token, host, consentUrl, runtimeId, worktableId }
}

export function requestAnalyticsContext(
  request: Request,
  identity: TokenIdentity
): SaveAnalyticsContext | null {
  if (!configuration() || !gatewayAdmits(request)) return null
  const principal = trustedGatewayPrincipal(request)
  // Team authorization resolves external credentials to local actors. Bind the
  // grant to the credential proof retained by that resolution, not provenance.
  const credentialPrincipalId = identity.team
    ? identity.principal.type === "human" && identity.cloudIdentity
      ? `workos:${identity.cloudIdentity.subject}`
      : identity.principal.type === "agent"
        ? identity.team.credentialKey
        : undefined
    : identity.principal.id
  if (
    !principal ||
    principal.type !== identity.principal.type ||
    principal.id !== credentialPrincipalId
  )
    return null
  const value = request.headers.get(ANALYTICS_HEADER)
  if (!value || value.length > 2048) return null
  try {
    const grant = JSON.parse(value) as AnalyticsGrant
    const subject =
      principal.type === "human" ? principal.id : principal.authorizedBy
    const expectedId =
      principal.type === "human"
        ? principal.id
        : `${principal.id}:worktable:${configuration()!.worktableId}`
    if (
      grant.distinctId !== expectedId ||
      !subject?.startsWith("workos:") ||
      grant.consentSubject !== subject.slice(7) ||
      grant.actorType !== principal.type ||
      !["web", "desktop_cloud", "mcp", "api"].includes(grant.surface) ||
      (grant.trafficType !== undefined &&
        grant.trafficType !== "internal" &&
        grant.trafficType !== "verification") ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= Date.now() - GRANT_CLOCK_SKEW_MS ||
      grant.expiresAt > Date.now() + ANALYTICS_GRANT_TTL_MS + GRANT_CLOCK_SKEW_MS
    )
      return null
    const protocolVersion = request.headers.get("mcp-protocol-version")
    const clientId = identity.agent?.replace(/^managed:/, "")
    // The gateway names the app from the verified OAuth client.
    const clientName = isAnalyticsClient(grant.client)
      ? ANALYTICS_CLIENT_NAMES[grant.client]
      : clientId && Object.hasOwn(MCP_CLIENTS, clientId)
        ? MCP_CLIENTS[clientId as SupportedMcpClientId].label
        : undefined
    return {
      contributors: [grant],
      ...(protocolVersion &&
      SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)
        ? { protocolVersion }
        : {}),
      ...(clientName ? { clientName } : {}),
    }
  } catch {
    return null
  }
}

/**
 * An MCP request's context. A hosted Worktable sleeps within a second of its
 * answer, before an event sent after it can leave, so when the gateway's
 * grant says the gateway sends them, the request's events are gathered for
 * the response instead.
 */
export function mcpAnalyticsContext(
  request: Request,
  identity: TokenIdentity
): SaveAnalyticsContext | null {
  const value = requestAnalyticsContext(request, identity)
  if (value?.contributors[0]?.sender === "gateway")
    value.report = { calls: [], saved: [] }
  return value
}

/** Hands the gateway what the request did. Anything later is sent from here. */
export function reportedToGateway(
  response: Response,
  value: SaveAnalyticsContext | null
): Response {
  const report = value?.report
  if (!value || !report) return response
  delete value.report
  if (report.calls.length === 0 && report.saved.length === 0) return response
  const release = configuredRelease()
  return withHeader(
    response,
    ANALYTICS_REPORT_HEADER,
    JSON.stringify({
      ...report,
      ...(value.protocolVersion
        ? { protocolVersion: value.protocolVersion }
        : {}),
      ...(release ? { release } : {}),
    } satisfies AnalyticsReport)
  )
}

function configuredRelease(): string | undefined {
  const release = process.env["WORKTABLE_VERSION"]
  return release?.match(/^\d[\w.+-]{0,63}$/) ? release : undefined
}

export function withAnalyticsContext<T>(
  value: SaveAnalyticsContext | null,
  action: () => T
): T {
  return context.run(value, action)
}
export function currentAnalyticsContext(): SaveAnalyticsContext | null {
  return context.getStore() ?? null
}

export function isAnalyticsMaintenance(source?: string, actor?: string): boolean {
  return [source, actor].some((value) => value === "system" || value?.startsWith("system:"))
}

/** Inspect locally only. Neither values nor hashes leave the runtime. */
export function hasAuthoredContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.some(hasAuthoredContent)
  if (!value || typeof value !== "object") return false
  const block = value as Record<string, unknown>
  return (
    hasAuthoredContent(block.text) ||
    hasAuthoredContent(block.content) ||
    hasAuthoredContent(block.children) ||
    Object.entries(block).some(
      ([key, entry]) =>
        ["url", "src", "code", "rows", "cells"].includes(key) &&
        hasAuthoredContent(entry)
    ) ||
    (block.type === "mermaid" &&
      !!block.props &&
      typeof block.props === "object" &&
      hasAuthoredContent((block.props as Record<string, unknown>).data)) ||
    (typeof block.type === "string" &&
      ["image", "video", "audio", "file", "table", "mermaid"].includes(
        block.type
      ) &&
      hasAuthoredContent(block.props))
  )
}

export function hasAuthoredHtml(html: string): boolean {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html
  return (
    body
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]*>/g, "")
      .trim().length > 0 ||
    /<(?:img|svg|canvas|input|button|iframe|video|audio)\b/i.test(body)
  )
}

/** Runs after the owning content commit, never in request or projection wrappers. */
export function captureWorkSaved(
  contentType: "document" | "html" | "record"
): void {
  const value = currentAnalyticsContext()
  if (
    !value ||
    value.contributors.length === 0 ||
    value.contributors.some((grant) => !grant)
  )
    return
  const unique = [
    ...new Map(
      value.contributors.map((grant) => [grant!.distinctId, grant!])
    ).values(),
  ]
  if (value.report) {
    if (value.report.saved.length < ANALYTICS_REPORT_MAX)
      value.report.saved.push(contentType)
    return
  }
  const multiple = unique.length > 1
  enqueue(
    "product:work_saved",
    unique,
    {
      actor_type: multiple ? "multiple" : unique[0]!.actorType,
      surface: multiple ? undefined : unique[0]!.surface,
      content_type: contentType,
    },
    multiple ? `commit:${crypto.randomUUID()}` : unique[0]!.distinctId
  )
}

export function captureMcpCall(
  tool: string,
  operation: string,
  outcome: "success" | "error" | "denied",
  durationMs: number
): void {
  const value = currentAnalyticsContext()
  const grants = value?.contributors
  if (!grants || grants.length !== 1 || !grants[0]) return
  const duration = Math.max(0, Math.round(durationMs))
  if (value?.report) {
    if (value.report.calls.length < ANALYTICS_REPORT_MAX)
      value.report.calls.push({ tool, operation, outcome, durationMs: duration })
    return
  }
  enqueue(
    "$mcp_tool_call",
    [grants[0]],
    {
      actor_type: grants[0].actorType,
      surface: "mcp",
      tool,
      operation,
      outcome,
      duration_ms: duration,
    },
    grants[0].distinctId
  )
}

export async function measureMcpCall<T>(
  tool: string,
  operation: string,
  action: () => Promise<T>
): Promise<T> {
  const start = performance.now()
  try {
    const result = await action()
    const outcome =
      result &&
      typeof result === "object" &&
      "isError" in result &&
      result.isError
        ? isAccessRefusal(result)
          ? "denied"
          : "error"
        : "success"
    captureMcpCall(tool, operation, outcome, performance.now() - start)
    return result
  } catch (error) {
    captureMcpCall(tool, operation, "error", performance.now() - start)
    throw error
  }
}

function enqueue(
  event: ProductAnalyticsEvent,
  grants: AnalyticsGrant[],
  properties: ProductAnalyticsProperties,
  distinctId: string
): void {
  const config = configuration()
  if (!config || pending >= 100 || grants.length > 20) return
  pending++
  const mcpContext =
    event === "$mcp_tool_call" ? currentAnalyticsContext() : null
  const trafficType =
    grants.find((grant) => grant.trafficType === "verification")?.trafficType ??
    grants.find((grant) => grant.trafficType === "internal")?.trafficType
  const release = configuredRelease()
  const delivery = (async () => {
    try {
      // Recheck at delivery, including long-lived Yjs connections and account revocation.
      if (
        !(await consented(config, [
          ...new Set(grants.map((grant) => grant.consentSubject)),
        ])) ||
        !configuration()
      )
        return
      // Each event is sent as it happens, never held for a batch: a hosted
      // Worktable sleeps soon after its last request, and events waiting in
      // memory were lost.
      client ??= new PostHog(config.token, {
        host: config.host,
        fetchRetryCount: 1,
        fetchRetryDelay: 500,
        requestTimeout: 3000,
        disableGeoip: true,
      })
      await client.captureImmediate({
        distinctId,
        event,
        properties: {
          ...properties,
          analytics_schema_version: ANALYTICS_SCHEMA_VERSION,
          worktable_id: config.worktableId,
          environment: "production",
          ...(trafficType ? { traffic_type: trafficType } : {}),
          ...(release ? { release } : {}),
          $process_person_profile: properties.actor_type === "human",
          ...(event === "$mcp_tool_call"
            ? {
                $mcp_source: "posthog_mcp_analytics",
                $mcp_interface: "mcp",
                $mcp_server_name: "worktable",
                $mcp_tool_name: properties.tool,
                $mcp_resource_name: properties.tool,
                $mcp_duration_ms: properties.duration_ms,
                ...(mcpContext?.protocolVersion
                  ? { $mcp_protocol_version: mcpContext.protocolVersion }
                  : {}),
                ...(mcpContext?.clientName
                  ? { $mcp_client_name: mcpContext.clientName }
                  : {}),
                $mcp_is_error: properties.outcome !== "success",
                ...(properties.outcome !== "success"
                  ? {
                      $mcp_error_type:
                        properties.outcome === "denied"
                          ? "permission"
                          : "tool_error",
                    }
                  : {}),
              }
            : {}),
          ...(properties.actor_type === "human"
            ? {
                $set: {
                  actor_type: "human",
                  traffic_type: trafficType ?? "customer",
                },
              }
            : {}),
        },
      })
    } catch {
      /* Optional telemetry cannot fail or log product content. */
    } finally {
      pending--
    }
  })()
  deliveries.add(delivery)
  void delivery.finally(() => deliveries.delete(delivery))
}

async function consented(
  config: NonNullable<ReturnType<typeof configuration>>,
  subjects: string[]
): Promise<boolean> {
  const key = [...subjects].sort().join(",")
  const cached = consents.get(key)
  const asked = Date.now()
  if (cached && cached.until > asked) return cached.enabled
  const response = await fetch(config.consentUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(1500),
    headers: {
      "Content-Type": "application/json",
      "X-Worktable-Runtime": config.runtimeId,
      Authorization: `Bearer ${process.env["WORKTABLE_GATEWAY_SECRET"]}`,
    },
    body: JSON.stringify({ subjects }),
  })
  // An unavailable preference service drops analytics; it is asked again next time.
  if (!response.ok) return false
  const enabled =
    ((await response.json()) as { enabled?: unknown }).enabled === true
  if (consents.size >= 1000) consents.clear()
  // The minute counts from the question, so a reply can't extend it.
  consents.set(key, { enabled, until: asked + CONSENT_TTL_MS })
  return enabled
}

export async function flushAnalytics(): Promise<void> {
  // Deliveries that start while earlier ones settle are waited for too.
  while (deliveries.size > 0) await Promise.allSettled([...deliveries])
  await client?.flush().catch(() => undefined)
}
export async function shutdownAnalytics(): Promise<void> {
  await flushAnalytics()
  await client?.shutdown().catch(() => undefined)
  client = null
  consents.clear()
}
