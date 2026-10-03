import { takeResultMedia } from "./media.ts"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
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
  type WorktableToolName,
} from "./operations.ts"
import {
  DiscoverInput,
  SpacesInput,
  DocumentsReadInput,
  DocumentsWriteInput,
  DocsReadInput,
  DocsWriteInput,
  DrawingsReadInput,
  DrawingsWriteInput,
  HtmlReadInput,
  HtmlWriteInput,
  RecordsReadInput,
  RecordsWriteInput,
  AnnotationsReadInput,
  AnnotationsWriteInput,
  ThreadsReadInput,
  ThreadsWriteInput,
  ThreadDeliveryInput,
  DeleteInput,
  GuidanceInput,
  MermaidInput,
} from "./schemas.ts"
import { dispatchOperation } from "./dispatcher.ts"
import { registerCompanyKnowledgeTools } from "./company-knowledge.ts"
import {
  assertPublicOperationOutput,
  PublicOperationOutputError,
  WORKTABLE_OUTPUT_SCHEMAS,
} from "./output-schemas.ts"
import {
  installOpenAiToolDescriptorCompatibility,
  oauthToolMetadata,
} from "./openai-tool-auth.ts"

// ============================================================
// Public capability registry
// ============================================================

type CapabilityInput = { request: Record<string, unknown> }

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

/** The first scope this request needs but the token lacks, or null. */
export function missingMcpScope(
  toolName: WorktableToolName,
  request: Record<string, unknown>,
  scopes: string[]
): string | null {
  const { id } = resolvePublicOperation(toolName, request)
  const definition = OPERATION_DEFINITIONS[id]
  const required: string[] = definition.scope ? [definition.scope] : []
  if (
    (id === "html.create" || id === "html.update") &&
    request.preview !== undefined
  )
    required.push("widgets:read")
  if (id.startsWith("drawings.") && definition.mutation !== "none")
    required.push("documents:read")
  if (id === "spaces.update" && request.startHere !== undefined)
    required.push("documents:write")
  return required.find((scope) => !hasScope(scopes, scope)) ?? null
}

export function mcpToolAuthorized(
  toolName: WorktableToolName,
  request: Record<string, unknown>,
  scopes: string[]
): boolean {
  return missingMcpScope(toolName, request, scopes) === null
}

export const TOOL_DESCRIPTIONS: Record<WorktableToolName, string> = {
  worktable_discover:
    "Orient to the workspace or a Space, search scoped context, or inspect a Space index. A Space's state starts with its Start here pins: read those first.",
  worktable_spaces:
    "Create, update, archive, or restore a Worktable Space, including its pinned Start here documents.",
  worktable_documents_read:
    "List every document format, safely read source or versions, diff a document's text against an earlier revision, or render drawings and HTML as model-visible PNG previews with action render.",
  worktable_documents_write:
    "Create, replace, checkpoint, restore, move, archive, or restore registered documents and mixed-format folders through format-neutral actions. Every create chooses a lifetime (durable or temporary); set_lifetime and set_folder_lifetime change it later.",
  worktable_docs_read:
    "List, read, or grep Worktable Docs. grep finds exact text or a regex line by line and returns each match's Doc, line number, and revision, plus any Docs it could not search in skipped; use worktable_discover search to find Docs by meaning. read accepts offset and limit to read a long Doc in line ranges.",
  worktable_docs_write:
    "Create, replace, patch, or rename Worktable Docs. Creating a Doc requires a lifetime: durable or temporary.",
  worktable_drawings_read:
    "Inspect drawings as objects and PNG previews, query text/type/region, render PNG or SVG, or list reversible agent changes. Start with guidance action drawings. Shared document tools list, move, archive and version drawings.",
  worktable_drawings_write:
    "Create drawings or apply atomic typed edits, preview proposed edits, and undo/redo a specific batch. Requires documents:read and documents:write. Returns a saved-revision preview by default. Reuse requestId only when retrying the same request. Change a lifetime later with worktable_documents_write action set_lifetime.",
  worktable_html_read:
    "Return the HTML runtime contract, list or read HTML Docs, or render a read-only PNG preview. Rendering reports incomplete loads and requires Records read scope for Records data.",
  worktable_html_write:
    "Create, update, rename, move, archive, or restore Worktable HTML Docs. Create/update may request an opt-in PNG preview; preview failure never undoes a successful save. Change a lifetime later with worktable_documents_write action set_lifetime.",
  worktable_records_read:
    "List Record collections, query Records, or read one.",
  worktable_records_write:
    "Create or update Record collection schemas and Records.",
  worktable_annotations_read:
    "List annotations, read one, or return its target context.",
  worktable_annotations_write:
    "Create, reply to, update, or resolve Worktable annotations.",
  worktable_threads_read:
    "List participants and threads, read messages, or wait for replies and activity.",
  worktable_threads_write:
    "Post messages and manage reply assignments in Worktable threads.",
  worktable_thread_delivery:
    "Register the authenticated participant, claim addressed messages, acknowledge ingress, or report delivery progress and failures.",
  worktable_delete:
    "Permanently delete a Worktable document folder, one Doc, one HTML Doc, or one Record.",
  worktable_guidance:
    "Read the Worktable format specification or drawing authoring guide and examples.",
  worktable_mermaid: "Validate Mermaid source or render it as an SVG preview.",
}

export const TOOL_TITLES: Record<WorktableToolName, string> = {
  worktable_discover: "Discover Worktable context",
  worktable_spaces: "Create a Worktable space",
  worktable_documents_read: "Read Worktable documents",
  worktable_documents_write: "Write Worktable documents",
  worktable_docs_read: "Read Worktable Docs",
  worktable_docs_write: "Write Worktable Docs",
  worktable_drawings_read: "Read Worktable drawings",
  worktable_drawings_write: "Edit Worktable drawings",
  worktable_html_read: "Read Worktable HTML Docs",
  worktable_html_write: "Write Worktable HTML Docs",
  worktable_records_read: "Read Worktable Records",
  worktable_records_write: "Write Worktable Records",
  worktable_annotations_read: "Read Worktable annotations",
  worktable_annotations_write: "Write Worktable annotations",
  worktable_threads_read: "Read Worktable threads",
  worktable_threads_write: "Write Worktable threads",
  worktable_thread_delivery: "Manage Worktable thread delivery",
  worktable_delete: "Delete Worktable content",
  worktable_guidance: "Read Worktable format specification",
  worktable_mermaid: "Validate Worktable diagrams",
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const

const ADDITIVE_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

function toolMetadata(
  toolName: WorktableToolName,
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
) {
  return {
    title: TOOL_TITLES[toolName],
    description: TOOL_DESCRIPTIONS[toolName],
    annotations,
    ...oauthToolMetadata(),
  }
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

export function registerTools(
  server: McpServer,
  options?: {
    scopes?: string[]
    urlOrigin?: string
    principal?: RequestPrincipal
    identity?: Pick<TokenIdentity, "agent" | "credentialClass" | "principal">
  }
): void {
  const scopes = options?.scopes ?? ["*"]
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
  const restoreRequestHandlerRegistration =
    installOpenAiToolDescriptorCompatibility(server)

  const handle =
    (toolName: WorktableToolName) =>
    async (
      { request }: CapabilityInput,
      extra: {
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
    ) => {
      const operation = resolvePublicOperation(toolName, request)
      const definition = OPERATION_DEFINITIONS[operation.id]
      const missingScope = missingMcpScope(toolName, request, scopes)
      if (missingScope) {
        const urlOrigin = configuredUrlOrigin ?? resolveLocalWorkspaceOrigin()
        return mkAuthErr(
          `Insufficient scope: ${toolName} action "${String(request.action)}" requires "${missingScope}". The workspace owner can grant it by reconnecting this agent with broader access.`,
          urlOrigin,
          missingScope
        )
      }
      try {
        const urlOrigin = configuredUrlOrigin ?? resolveLocalWorkspaceOrigin()
        const identity = managedCredentialIdentity(options?.identity)
        const result = await dispatchOperation(operation.id, operation.args, {
          principal: identity?.principal ?? options?.principal,
          identity,
          scopes,
          signal: extra?.signal,
          canReadRecords: hasScope(scopes, "records:read"),
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
        const { data, content } = takeResultMedia(result)
        const linked = addUrlToSendInChat(
          definition.resultLink,
          operation.args,
          data,
          urlOrigin
        )
        const publicResult = publicizeResult(operation.id, linked)
        assertPublicOperationOutput(operation.id, publicResult)
        const response = ok(publicResult)
        return { ...response, content: [...response.content, ...content] }
      } catch (error) {
        if (error instanceof PublicOperationOutputError) {
          console.error(`[mcp] ${error.message}`)
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
          return mkErr(
            JSON.stringify(
              {
                error: error.message,
                code: (error as { code: string }).code,
              },
              null,
              2
            )
          )
        }
        return mkErr(error instanceof Error ? error.message : String(error))
      }
    }

  registerCompanyKnowledgeTools(server, {
    scopes,
    urlOrigin: configuredUrlOrigin ?? resolveLocalWorkspaceOrigin(),
  })

  server.registerTool(
    "worktable_discover",
    {
      ...toolMetadata("worktable_discover", READ_ONLY_ANNOTATIONS),
      inputSchema: DiscoverInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_discover,
    },
    handle("worktable_discover")
  )
  server.registerTool(
    "worktable_spaces",
    {
      // update and archive can overwrite metadata or hide a whole Space.
      ...toolMetadata("worktable_spaces", WRITE_ANNOTATIONS),
      inputSchema: SpacesInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_spaces,
    },
    handle("worktable_spaces")
  )
  server.registerTool(
    "worktable_documents_read",
    {
      ...toolMetadata("worktable_documents_read", READ_ONLY_ANNOTATIONS),
      inputSchema: DocumentsReadInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_documents_read,
    },
    handle("worktable_documents_read")
  )
  server.registerTool(
    "worktable_documents_write",
    {
      ...toolMetadata("worktable_documents_write", WRITE_ANNOTATIONS),
      inputSchema: DocumentsWriteInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_documents_write,
    },
    handle("worktable_documents_write")
  )
  server.registerTool(
    "worktable_docs_read",
    {
      ...toolMetadata("worktable_docs_read", READ_ONLY_ANNOTATIONS),
      inputSchema: DocsReadInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_docs_read,
    },
    handle("worktable_docs_read")
  )
  server.registerTool(
    "worktable_docs_write",
    {
      ...toolMetadata("worktable_docs_write", WRITE_ANNOTATIONS),
      inputSchema: DocsWriteInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_docs_write,
    },
    handle("worktable_docs_write")
  )
  server.registerTool(
    "worktable_drawings_read",
    {
      ...toolMetadata("worktable_drawings_read", READ_ONLY_ANNOTATIONS),
      inputSchema: DrawingsReadInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_drawings_read,
    },
    handle("worktable_drawings_read")
  )
  server.registerTool(
    "worktable_drawings_write",
    {
      ...toolMetadata("worktable_drawings_write", {
        ...WRITE_ANNOTATIONS,
        idempotentHint: true,
      }),
      inputSchema: DrawingsWriteInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_drawings_write,
    },
    handle("worktable_drawings_write")
  )
  server.registerTool(
    "worktable_html_read",
    {
      ...toolMetadata("worktable_html_read", READ_ONLY_ANNOTATIONS),
      inputSchema: HtmlReadInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_html_read,
    },
    handle("worktable_html_read")
  )
  server.registerTool(
    "worktable_html_write",
    {
      ...toolMetadata("worktable_html_write", WRITE_ANNOTATIONS),
      inputSchema: HtmlWriteInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_html_write,
    },
    handle("worktable_html_write")
  )
  server.registerTool(
    "worktable_records_read",
    {
      ...toolMetadata("worktable_records_read", READ_ONLY_ANNOTATIONS),
      inputSchema: RecordsReadInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_records_read,
    },
    handle("worktable_records_read")
  )
  server.registerTool(
    "worktable_records_write",
    {
      ...toolMetadata("worktable_records_write", WRITE_ANNOTATIONS),
      inputSchema: RecordsWriteInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_records_write,
    },
    handle("worktable_records_write")
  )
  server.registerTool(
    "worktable_annotations_read",
    {
      ...toolMetadata("worktable_annotations_read", READ_ONLY_ANNOTATIONS),
      inputSchema: AnnotationsReadInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_annotations_read,
    },
    handle("worktable_annotations_read")
  )
  server.registerTool(
    "worktable_annotations_write",
    {
      ...toolMetadata("worktable_annotations_write", WRITE_ANNOTATIONS),
      inputSchema: AnnotationsWriteInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_annotations_write,
    },
    handle("worktable_annotations_write")
  )
  server.registerTool(
    "worktable_threads_read",
    {
      ...toolMetadata("worktable_threads_read", READ_ONLY_ANNOTATIONS),
      inputSchema: ThreadsReadInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_threads_read,
    },
    handle("worktable_threads_read")
  )
  server.registerTool(
    "worktable_threads_write",
    {
      ...toolMetadata("worktable_threads_write", {
        ...WRITE_ANNOTATIONS,
        openWorldHint: true,
      }),
      inputSchema: ThreadsWriteInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_threads_write,
    },
    handle("worktable_threads_write")
  )
  server.registerTool(
    "worktable_thread_delivery",
    {
      ...toolMetadata("worktable_thread_delivery", WRITE_ANNOTATIONS),
      inputSchema: ThreadDeliveryInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_thread_delivery,
    },
    handle("worktable_thread_delivery")
  )
  server.registerTool(
    "worktable_delete",
    {
      ...toolMetadata("worktable_delete", WRITE_ANNOTATIONS),
      inputSchema: DeleteInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_delete,
    },
    handle("worktable_delete")
  )
  server.registerTool(
    "worktable_guidance",
    {
      ...toolMetadata("worktable_guidance", READ_ONLY_ANNOTATIONS),
      inputSchema: GuidanceInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_guidance,
    },
    handle("worktable_guidance")
  )
  server.registerTool(
    "worktable_mermaid",
    {
      ...toolMetadata("worktable_mermaid", READ_ONLY_ANNOTATIONS),
      inputSchema: MermaidInput,
      outputSchema: WORKTABLE_OUTPUT_SCHEMAS.worktable_mermaid,
    },
    handle("worktable_mermaid")
  )
  restoreRequestHandlerRegistration()
}
