import { AsyncLocalStorage } from "node:async_hooks"
import { PostHog } from "posthog-node"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js"
import {
  MCP_CLIENTS,
  type SupportedMcpClientId,
} from "@worktable/types/mcp-clients"
import {
  ANALYTICS_HEADER,
  ANALYTICS_SCHEMA_VERSION,
  type AnalyticsGrant,
  type ProductAnalyticsEvent,
  type ProductAnalyticsProperties,
} from "@worktable/hosted-contract"
import { gatewayAdmits, isHosted, trustedGatewayPrincipal } from "./hosted.ts"
import type { TokenIdentity } from "./token-store.ts"

export interface SaveAnalyticsContext {
  contributors: Array<AnalyticsGrant | null>
  protocolVersion?: string
  clientName?: string
}
const context = new AsyncLocalStorage<SaveAnalyticsContext | null>()
let client: PostHog | null = null
let pending = 0
const deliveries = new Set<Promise<void>>()

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
      grant.expiresAt <= Date.now() ||
      grant.expiresAt > Date.now() + 60_000
    )
      return null
    const protocolVersion = request.headers.get("mcp-protocol-version")
    const clientId = identity.agent?.replace(/^managed:/, "")
    return {
      contributors: [grant],
      ...(protocolVersion &&
      SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)
        ? { protocolVersion }
        : {}),
      ...(clientId && Object.hasOwn(MCP_CLIENTS, clientId)
        ? { clientName: MCP_CLIENTS[clientId as SupportedMcpClientId].label }
        : {}),
    }
  } catch {
    return null
  }
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
  const grants = currentAnalyticsContext()?.contributors
  if (!grants || grants.length !== 1 || !grants[0]) return
  enqueue(
    "$mcp_tool_call",
    [grants[0]],
    {
      actor_type: grants[0].actorType,
      surface: "mcp",
      tool,
      operation,
      outcome,
      duration_ms: Math.max(0, Math.round(durationMs)),
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
        ? "_meta" in result &&
          result._meta &&
          typeof result._meta === "object" &&
          "mcp/www_authenticate" in result._meta
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
  const delivery = (async () => {
    try {
      // Recheck at delivery, including long-lived Yjs connections and account revocation.
      const response = await fetch(config.consentUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(1500),
        headers: {
          "Content-Type": "application/json",
          "X-Worktable-Runtime": config.runtimeId,
          Authorization: `Bearer ${process.env["WORKTABLE_GATEWAY_SECRET"]}`,
        },
        body: JSON.stringify({
          subjects: [...new Set(grants.map((grant) => grant.consentSubject))],
        }),
      })
      if (
        !response.ok ||
        ((await response.json()) as { enabled?: unknown }).enabled !== true ||
        !configuration()
      )
        return
      client ??= new PostHog(config.token, {
        host: config.host,
        flushAt: 1,
        flushInterval: 0,
        maxQueueSize: 100,
        fetchRetryCount: 0,
        requestTimeout: 2000,
        disableGeoip: true,
      })
      client.capture({
        distinctId,
        event,
        properties: {
          ...properties,
          analytics_schema_version: ANALYTICS_SCHEMA_VERSION,
          worktable_id: config.worktableId,
          environment: "production",
          ...(trafficType ? { traffic_type: trafficType } : {}),
          ...(process.env["WORKTABLE_VERSION"]?.match(/^\d[\w.+-]{0,63}$/)
            ? { release: process.env["WORKTABLE_VERSION"] }
            : {}),
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
      await client.flush()
    } catch {
      /* Optional telemetry cannot fail or log product content. */
    } finally {
      pending--
    }
  })()
  deliveries.add(delivery)
  void delivery.finally(() => deliveries.delete(delivery))
}

export async function flushAnalytics(): Promise<void> {
  await Promise.allSettled([...deliveries])
}
export async function shutdownAnalytics(): Promise<void> {
  await flushAnalytics()
  await client?.shutdown().catch(() => undefined)
  client = null
}
