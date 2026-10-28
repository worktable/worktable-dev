import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  AnnotationsReadInput,
  AnnotationsWriteInputPreview,
  DeleteInputPreview,
  DiscoverInputPreview,
  DocsReadInput,
  DocsWriteInput,
  DocumentsReadInput,
  DocumentsWriteInputPreview,
  DrawingsReadInput,
  DrawingsWriteInput,
  GuidanceInput,
  HtmlReadInput,
  HtmlWriteInputPreview,
  MermaidInput,
  RecordsReadInput,
  RecordsWriteInputPreview,
  SpacesInputPreview,
  ThreadDeliveryInput,
  ThreadsReadInput,
  ThreadsWriteInputPreview,
} from "./schemas.ts"
import { WORKTABLE_TOOL_NAMES, type WorktableToolName } from "./operations.ts"

// Calls in the shape of the earlier tool surface: grouped tools that took
// {request: {action, ...}}, and the individual Space tools. They are no longer
// listed, but installed plugins, pasted routines and older skills still make
// them, so they keep working: each is validated against its earlier schema and
// runs the same operation as the current tool. Delete this file and the
// grouped schemas once those callers have moved to the current tools.

/** The earlier input schema of each grouped tool, as last released. */
export const LEGACY_INPUT_SCHEMAS: Record<WorktableToolName, z.ZodType> = {
  worktable_discover: DiscoverInputPreview,
  worktable_spaces: SpacesInputPreview,
  worktable_documents_read: DocumentsReadInput,
  worktable_documents_write: DocumentsWriteInputPreview,
  worktable_docs_read: DocsReadInput,
  worktable_docs_write: DocsWriteInput,
  worktable_drawings_read: DrawingsReadInput,
  worktable_drawings_write: DrawingsWriteInput,
  worktable_html_read: HtmlReadInput,
  worktable_html_write: HtmlWriteInputPreview,
  worktable_records_read: RecordsReadInput,
  worktable_records_write: RecordsWriteInputPreview,
  worktable_annotations_read: AnnotationsReadInput,
  worktable_annotations_write: AnnotationsWriteInputPreview,
  worktable_threads_read: ThreadsReadInput,
  worktable_threads_write: ThreadsWriteInputPreview,
  worktable_thread_delivery: ThreadDeliveryInput,
  worktable_delete: DeleteInputPreview,
  worktable_guidance: GuidanceInput,
  worktable_mermaid: MermaidInput,
}

/** Earlier names for the file tools, which took the document tools' requests. */
const FILE_TOOL_ALIASES: Record<string, WorktableToolName> = {
  worktable_files_read: "worktable_documents_read",
  worktable_files_write: "worktable_documents_write",
}

/** The individual tools that preceded worktable_spaces_write and state's index. */
const INDIVIDUAL_TOOLS: Record<
  string,
  { tool: WorktableToolName; action: string }
> = {
  worktable_space_index: { tool: "worktable_discover", action: "space_index" },
  worktable_spaces_create: { tool: "worktable_spaces", action: "create" },
  worktable_spaces_update: { tool: "worktable_spaces", action: "update" },
  worktable_spaces_archive: { tool: "worktable_spaces", action: "archive" },
  worktable_spaces_restore: { tool: "worktable_spaces", action: "restore" },
}

export interface LegacyCall {
  tool: WorktableToolName
  request: Record<string, unknown>
  file?: Record<string, unknown>
  /** worktable_documents_read keeps returning file sources as base64. */
  legacyFileRead: boolean
}

export type LegacyCallMatch =
  | { ok: true; call: LegacyCall }
  | { ok: false; error: string }

const GROUPED_TOOLS = new Set<string>(WORKTABLE_TOOL_NAMES)

/**
 * The grouped tool whose earlier calls a listed name still accepts, so its
 * output schema also describes what those calls return.
 */
export function earlierToolFor(name: string): WorktableToolName | null {
  return (
    FILE_TOOL_ALIASES[name] ??
    (GROUPED_TOOLS.has(name) ? (name as WorktableToolName) : null)
  )
}

/**
 * The earlier-surface call this is, if it is one. Current tools never take a
 * `request` argument, so its presence identifies the earlier shape even where
 * a name carried over.
 */
export function matchLegacyCall(
  name: string,
  args: unknown
): LegacyCallMatch | null {
  const input =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {}
  const individual = INDIVIDUAL_TOOLS[name]
  if (individual) {
    return parseLegacy(individual.tool, name, {
      request: { ...input, action: individual.action },
    })
  }
  if (!("request" in input)) return null
  const tool =
    FILE_TOOL_ALIASES[name] ?? (GROUPED_TOOLS.has(name) ? name : null)
  if (!tool) return null
  return parseLegacy(tool as WorktableToolName, name, input)
}

function parseLegacy(
  tool: WorktableToolName,
  name: string,
  input: Record<string, unknown>
): LegacyCallMatch {
  const parsed = LEGACY_INPUT_SCHEMAS[tool].safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: describeIssues(name, parsed.error) }
  }
  const { request, file } = parsed.data as {
    request: Record<string, unknown>
    file?: Record<string, unknown>
  }
  return {
    ok: true,
    call: {
      tool,
      request,
      ...(file ? { file } : {}),
      legacyFileRead: name === "worktable_documents_read",
    },
  }
}

/** A readable summary of what a call got wrong, by argument. */
export function describeIssues(name: string, error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path
      .filter((part) => part !== "request")
      .map(String)
      .join(".")
    return path ? `${path}: ${issue.message}` : issue.message
  })
  return `Invalid arguments for ${name}: ${issues.join("; ")}`
}

type RequestHandler = (request: unknown, extra: unknown) => unknown

interface MutableRequestHandlerServer {
  setRequestHandler: (requestSchema: unknown, handler: RequestHandler) => void
}

/**
 * Answer earlier-surface calls before the SDK validates them against the
 * listed tools. Like installOpenAiToolDescriptorCompatibility, this wraps the
 * low-level handler registration while the high-level server installs
 * tools/call; every other call goes to the SDK unchanged.
 */
export function installLegacyCalls(
  server: McpServer,
  run: (name: string, match: LegacyCallMatch, extra: unknown) => Promise<unknown>
): () => void {
  const raw = (server as unknown as { server?: MutableRequestHandlerServer })
    .server
  if (!raw || typeof raw.setRequestHandler !== "function") return () => {}
  const originalSetRequestHandler = raw.setRequestHandler.bind(raw)
  raw.setRequestHandler = (requestSchema, handler) => {
    if (requestSchema !== CallToolRequestSchema) {
      originalSetRequestHandler(requestSchema, handler)
      return
    }
    originalSetRequestHandler(requestSchema, (request, extra) => {
      const params = (request as { params?: { name?: unknown; arguments?: unknown } })
        .params
      const name = typeof params?.name === "string" ? params.name : ""
      const match = matchLegacyCall(name, params?.arguments)
      return match ? run(name, match, extra) : handler(request, extra)
    })
  }
  return () => {
    raw.setRequestHandler = originalSetRequestHandler
  }
}
