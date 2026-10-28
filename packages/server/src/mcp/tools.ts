import { takeResultMedia } from "./media.ts"
import { ambientNotices } from "../pending-ambient.ts"
import { currentRequestIdentity } from "../team-policy.ts"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { McpSurface } from "./surface.ts"
import { ok, mkAuthErr, mkErr } from "./helpers.ts"
import {
  hasScope,
  type RequestPrincipal,
  type TokenIdentity,
} from "../token-store.ts"
import { asHttpOrigin } from "../public-origin.ts"
import { resolveLocalWorkspaceOrigin } from "../workspace-origin.ts"
import { addUrlToSendInChat } from "./chat-links.ts"
import { MermaidDocumentValidationError } from "../mermaid-document.ts"
import {
  OPERATION_DEFINITIONS,
  resolvePublicOperation,
  type ResolvedOperation,
  type WorktableToolName,
} from "./operations.ts"
import { dispatchOperation } from "./dispatcher.ts"
import { registerCompanyKnowledgeTools } from "./company-knowledge.ts"
import {
  assertPublicOperationOutput,
  PublicOperationOutputError,
  withNotices,
} from "./output-schemas.ts"
import {
  installOpenAiToolDescriptorCompatibility,
  oauthToolMetadata,
} from "./openai-tool-auth.ts"
import { logError } from "../debug-log.ts"
import { isHosted } from "../hosted.ts"
import {
  CATALOG_TOOLS,
  ToolArgumentError,
  catalogOutputSchema,
  routeCatalogCall,
} from "./catalog.ts"
import { installLegacyCalls } from "./legacy-calls.ts"

// ============================================================
// Public capability registry
// ============================================================

function managedCredentialIdentity(
  identity:
    | Pick<TokenIdentity, "agent" | "credentialClass" | "principal">
    | undefined
): Pick<TokenIdentity, "agent" | "credentialClass" | "principal"> | undefined {
  if (!identity?.agent?.startsWith("managed:")) return identity
  const stableName = identity.agent.slice("managed:".length)
  if (!stableName) return identity
  const words = stableName
    .split("-")
    .filter((word) => word !== "mcp" && word !== "client")
  const displayName = words
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
    .join(" ")
  return {
    agent: `managed:${stableName}`,
    credentialClass: identity.credentialClass,
    principal: {
      ...identity.principal,
      displayName: displayName || identity.principal.displayName,
    },
  }
}

/** The first scope an operation needs but the token lacks, or null. */
export function missingOperationScope(
  { id, args }: ResolvedOperation,
  scopes: string[]
): string | null {
  const definition = OPERATION_DEFINITIONS[id]
  const required: string[] = definition.scope ? [definition.scope] : []
  if ((id === "html.create" || id === "html.update") && args.preview !== undefined)
    required.push("widgets:read")
  if (id.startsWith("drawings.") && definition.mutation !== "none")
    required.push("documents:read")
  if (id === "spaces.update" && args.pins !== undefined)
    required.push("documents:write")
  // A where filter reads record contents to choose the records it updates.
  if (id === "records.update_many" && args.where !== undefined)
    required.push("records:read")
  // An import reads a file in the Space: its proposal shows sample rows.
  if (id === "records.import") required.push("documents:read")
  return required.find((scope) => !hasScope(scopes, scope)) ?? null
}

/** The first scope an earlier-surface request needs but the token lacks. */
export function missingMcpScope(
  toolName: WorktableToolName,
  request: Record<string, unknown>,
  scopes: string[]
): string | null {
  return missingOperationScope(resolvePublicOperation(toolName, request), scopes)
}

export function mcpToolAuthorized(
  toolName: WorktableToolName,
  request: Record<string, unknown>,
  scopes: string[]
): boolean {
  return missingMcpScope(toolName, request, scopes) === null
}

/**
 * The request's full identity when it is this caller: Teams access needs
 * its binding, while a local connection's request runs as the owner and
 * its tools act as an agent.
 */
function sameCaller(identity: {
  principal: { id: string }
}): ReturnType<typeof currentRequestIdentity> | undefined {
  const full = currentRequestIdentity()
  return full?.principal.id === identity.principal.id ? full : undefined
}

function publicizeAnnotation(annotation: unknown): unknown {
  if (
    !annotation ||
    typeof annotation !== "object" ||
    Array.isArray(annotation)
  ) {
    return annotation
  }
  const output = { ...(annotation as Record<string, unknown>) }
  const target = output.target
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return output
  }
  const publicTarget = { ...(target as Record<string, unknown>) }
  if (
    publicTarget.type === "widget" &&
    typeof publicTarget.widgetId === "string"
  ) {
    publicTarget.type = "html"
    publicTarget.htmlId = publicTarget.widgetId
    delete publicTarget.widgetId
  }
  output.target = publicTarget
  return output
}

function publicizeAnnotationResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result
  }
  const output = { ...(result as Record<string, unknown>) }
  if (Array.isArray(output.annotations)) {
    output.annotations = output.annotations.map(publicizeAnnotation)
  }
  if ("annotation" in output) {
    output.annotation = publicizeAnnotation(output.annotation)
  }
  return output
}

function publicizeResult(
  operationId: keyof typeof OPERATION_DEFINITIONS,
  result: unknown
): unknown {
  if (operationId.startsWith("annotations.")) {
    return publicizeAnnotationResult(result)
  }
  if (
    (operationId === "spaces.update" || operationId === "workspace.state") &&
    result &&
    typeof result === "object" &&
    Array.isArray((result as Record<string, unknown>).pins)
  ) {
    const record = result as Record<string, unknown>
    return { ...record, startHere: record.pins }
  }
  if (
    !operationId.startsWith("html.") ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    return result
  }
  const record = { ...(result as Record<string, unknown>) }
  if ("widgets" in record) {
    record.htmlDocs = record.widgets
    delete record.widgets
  }
  if ("widget" in record) {
    record.htmlDoc = record.widget
    delete record.widget
  }
  if (typeof record.widgetId === "string") {
    record.htmlId = record.widgetId
    delete record.widgetId
  }
  return record
}

// Tool contracts are immutable, and a server is built for every request.
const CATALOG_OUTPUT_SCHEMAS = new Map(
  CATALOG_TOOLS.map((tool) => [tool.name, withNotices(catalogOutputSchema(tool))])
)

export function registerTools(
  server: McpServer,
  options?: {
    scopes?: string[]
    urlOrigin?: string
    principal?: RequestPrincipal
    identity?: Pick<TokenIdentity, "agent" | "credentialClass" | "principal">
    surface?: McpSurface
    fileLinkBase?: string | null
  }
): void {
  const scopes = options?.scopes ?? ["*"]
  const surface = options?.surface ?? "released"
  const callerIdentity = managedCredentialIdentity(options?.identity)
  const callerPrincipal = options?.principal
  let configuredUrlOrigin = options?.urlOrigin
    ? asHttpOrigin(options.urlOrigin)
    : null
  if (options?.urlOrigin) {
    const resource = new URL(options.urlOrigin)
    if (
      resource.protocol === "https:" &&
      !resource.username &&
      !resource.password &&
      !resource.search &&
      !resource.hash &&
      /^\/api\/mcp\/d\/[a-f0-9]{32}$/.test(resource.pathname)
    )
      configuredUrlOrigin = resource.href
  }
  if (options?.urlOrigin && !configuredUrlOrigin) {
    throw new Error("urlOrigin must be an absolute HTTP(S) URL")
  }
  // File links work where the tools run in this HTTP server, which keeps
  // their tickets, and the agent reaches it: directly, on Cloud where the
  // gateway says it forwards them, or through Worktable Link at the
  // device's own file-link address. Not from a stdio server in the agent's
  // own process.
  const fileLinkOrigin = isHosted()
    ? (options?.fileLinkBase ?? null)
    : !configuredUrlOrigin
      ? null
      : configuredUrlOrigin.replace(/\/api\/mcp\/d\/([a-f0-9]{32})$/, "/d/$1")
  const urlOriginFor = () => configuredUrlOrigin ?? resolveLocalWorkspaceOrigin()

  /**
   * Run a call's operations in order, as this caller, and answer with their
   * public results merged. Every operation's scope is checked before any runs.
   */
  const run = async (
    toolName: string,
    operations: ResolvedOperation[],
    extra: CallExtra,
    call: { file?: Record<string, unknown>; legacyFileRead?: boolean } = {}
  ) => {
    for (const operation of operations) {
      const missingScope = missingOperationScope(operation, scopes)
      if (missingScope) {
        return mkAuthErr(
          `Insufficient scope: ${toolName} requires "${missingScope}" here. The workspace owner can grant it by reconnecting this agent with broader access.`,
          urlOriginFor(),
          missingScope
        )
      }
    }
    try {
      const urlOrigin = urlOriginFor()
      const identity = callerIdentity
      let data: Record<string, unknown> = {}
      const media: Array<ReturnType<typeof takeResultMedia>["content"][number]> = []
      let last: { operation: ResolvedOperation; result: Record<string, unknown> } | null = null
      for (const resolved of operations) {
        // A file attached in ChatGPT goes with upload, the one operation that takes one.
        const operation =
          call.file !== undefined && resolved.id === "documents.upload"
            ? { ...resolved, args: { ...resolved.args, file: call.file } }
            : resolved
        const definition = OPERATION_DEFINITIONS[operation.id]
        const result = await dispatchOperation(operation.id, operation.args, {
          principal: identity?.principal ?? callerPrincipal,
          identity,
          scopes,
          signal: extra?.signal,
          canReadRecords: hasScope(scopes, "records:read"),
          surface,
          legacyFileRead: call.legacyFileRead ?? false,
          fileLinkOrigin,
          onThreadProgress: async ({ activity }) => {
            const progressToken = extra._meta?.progressToken
            if (progressToken === undefined) return
            const count = activity.receivedCharacters
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: count ?? activity.revision,
                message:
                  activity.state === "receiving" && count !== undefined
                    ? `Receiving response · ${count} characters`
                    : activity.state === "working"
                      ? "Agent is working"
                      : activity.state,
              },
            })
          },
        })
        const { data: resultData, content } = takeResultMedia(result)
        const linked = addUrlToSendInChat(
          definition.resultLink,
          operation.args,
          resultData,
          urlOrigin
        )
        const publicResult = publicizeResult(operation.id, linked)
        assertPublicOperationOutput(operation.id, publicResult)
        data = { ...data, ...publicResult }
        media.push(...content)
        last = { operation, result: publicResult }
      }
      const response = ok(data)
      // What waits on the agent rides beside the result.
      const notices =
        identity && last
          ? await ambientNotices(
              // The request's whole identity: Teams access needs its binding.
              { ...identity, ...sameCaller(identity), scopes },
              last.operation.id,
              last.operation.args,
              last.result
            )
          : null
      // Some clients show the model only the structured content, others
      // only the text, so the notices go in both.
      return {
        ...response,
        ...(notices && response.structuredContent
          ? { structuredContent: { ...response.structuredContent, notices } }
          : {}),
        content: [
          ...response.content,
          ...media,
          ...(notices ? [{ type: "text" as const, text: notices }] : []),
        ],
      }
    } catch (error) {
      return errorResult(error)
    }
  }

  // Calls in the earlier tool surface's shape keep working, unlisted.
  const restoreLegacyCalls = installLegacyCalls(server, (name, match, extra) => {
    if (!match.ok) return Promise.resolve(mkErr(match.error))
    const { tool, request, file, legacyFileRead } = match.call
    const operation = resolvePublicOperation(tool, request)
    if (file !== undefined && operation.id !== "documents.upload") {
      return Promise.resolve(mkErr("file goes with action upload."))
    }
    return run(name, [operation], extra as CallExtra, { file, legacyFileRead })
  })
  const restoreToolListing = installOpenAiToolDescriptorCompatibility(server)

  registerCompanyKnowledgeTools(server, {
    scopes,
    urlOrigin: urlOriginFor(),
  })

  for (const tool of CATALOG_TOOLS) {
    const metadata = oauthToolMetadata()
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Directory checks such as Anthropic's read the display name from
        // annotations.title, so it repeats the top-level title.
        annotations: { title: tool.title, ...tool.annotations },
        ...metadata,
        _meta: {
          ...metadata._meta,
          // ChatGPT passes a file the user attached as a link to it.
          ...(tool.fileParams ? { "openai/fileParams": tool.fileParams } : {}),
        },
        inputSchema: tool.inputSchema,
        outputSchema: CATALOG_OUTPUT_SCHEMAS.get(tool.name),
      },
      async (args: Record<string, unknown>, extra: CallExtra) => {
        let routed
        try {
          routed = routeCatalogCall(tool, args)
        } catch (error) {
          if (error instanceof ToolArgumentError) return mkErr(error.message)
          throw error
        }
        return run(tool.name, routed.operations, extra, { file: routed.file })
      }
    )
  }
  restoreToolListing()
  restoreLegacyCalls()
}

type CallExtra = {
  signal?: AbortSignal
  _meta?: { progressToken?: string | number }
  sendNotification: (notification: {
    method: "notifications/progress"
    params: {
      progressToken: string | number
      progress: number
      message?: string
    }
  }) => Promise<void>
}

function errorResult(error: unknown) {
  if (error instanceof PublicOperationOutputError) {
    console.error(
      `[mcp] invalid public output for ${error.operationId}:`,
      logError(error)
    )
    return mkErr(
      `Worktable could not return a valid result for ${error.operationId}.`
    )
  }
  if (error instanceof MermaidDocumentValidationError) {
    return mkErr(JSON.stringify(error.toJSON(), null, 2))
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    const details = (error as { details?: unknown }).details
    return mkErr(
      JSON.stringify(
        {
          error: error.message,
          code: (error as { code: string }).code,
          ...(details && typeof details === "object" ? details : {}),
        },
        null,
        2
      )
    )
  }
  return mkErr(error instanceof Error ? error.message : String(error))
}
