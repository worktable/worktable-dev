export const COMPANY_KNOWLEDGE_TOOL_NAMES = ["search", "fetch"] as const

export type CompanyKnowledgeToolName =
  (typeof COMPANY_KNOWLEDGE_TOOL_NAMES)[number]

export const WORKTABLE_TOOL_NAMES = [
  "worktable_discover",
  "worktable_spaces",
  "worktable_documents_read",
  "worktable_documents_write",
  "worktable_docs_read",
  "worktable_docs_write",
  "worktable_html_read",
  "worktable_html_write",
  "worktable_records_read",
  "worktable_records_write",
  "worktable_annotations_read",
  "worktable_annotations_write",
  "worktable_threads_read",
  "worktable_threads_write",
  "worktable_thread_delivery",
  "worktable_delete",
  "worktable_guidance",
  "worktable_mermaid",
] as const

export const PUBLIC_TOOL_NAMES = [
  ...COMPANY_KNOWLEDGE_TOOL_NAMES,
  ...WORKTABLE_TOOL_NAMES,
] as const

export type PublicToolName = (typeof PUBLIC_TOOL_NAMES)[number]
export type WorktableToolName = (typeof WORKTABLE_TOOL_NAMES)[number]
export type MutationClass = "none" | "workspace" | "records"
export type ResultLinkKind = "none" | "doc" | "renamed_doc" | "html"

export const OPERATION_DEFINITIONS = {
  "workspace.state": tool("search:read", "none"),
  "workspace.search": tool("search:read", "none"),
  "workspace.space_index": tool("docs:read", "none"),
  "spaces.create": tool("docs:write", "workspace"),
  "documents.list": tool("documents:read", "none"),
  "documents.read": tool("documents:read", "none"),
  "documents.read_source": tool("documents:read", "none"),
  "documents.versions": tool("documents:read", "none"),
  "documents.create": tool("documents:write", "workspace"),
  "documents.replace": tool("documents:write", "workspace"),
  "documents.checkpoint": tool("documents:write", "workspace"),
  "documents.restore_version": tool("documents:write", "workspace"),
  "documents.move": tool("documents:write", "workspace"),
  "documents.archive": tool("documents:write", "workspace"),
  "documents.restore": tool("documents:write", "workspace"),
  "documents.delete": tool("documents:write", "workspace"),
  "documents.move_folder": tool("documents:write", "workspace"),
  "documents.archive_folder": tool("documents:write", "workspace"),
  "documents.restore_folder": tool("documents:write", "workspace"),
  "documents.delete_folder": tool("documents:write", "workspace"),
  "docs.list": tool("docs:read", "none"),
  "docs.read": tool("docs:read", "none", "doc"),
  "docs.write": tool("docs:write", "workspace", "doc"),
  "docs.patch": tool("docs:write", "workspace", "doc"),
  "docs.rename": tool("docs:write", "workspace", "renamed_doc"),
  "docs.delete": tool("docs:write", "workspace"),
  "html.guide": tool(null, "none"),
  "html.list": tool("widgets:read", "none"),
  "html.read": tool("widgets:read", "none", "html"),
  "html.create": tool("widgets:write", "workspace", "html"),
  "html.update": tool("widgets:write", "workspace", "html"),
  "html.rename": tool("widgets:write", "workspace", "html"),
  "html.move": tool("widgets:write", "workspace", "html"),
  "html.archive": tool("widgets:write", "workspace", "html"),
  "html.restore": tool("widgets:write", "workspace", "html"),
  "html.delete": tool("widgets:write", "workspace"),
  "records.list_collections": tool("records:read", "none"),
  "records.query": tool("records:read", "none"),
  "records.read": tool("records:read", "none"),
  "records.upsert_collection": tool("records:write", "records"),
  "records.create": tool("records:write", "records"),
  "records.update": tool("records:write", "records"),
  "records.delete": tool("records:write", "records"),
  "annotations.list": tool("annotations:read", "none"),
  "annotations.read": tool("annotations:read", "none"),
  "annotations.context": tool("annotations:read", "none"),
  "annotations.create": tool("annotations:write", "workspace"),
  "annotations.reply": tool("annotations:write", "workspace"),
  "annotations.update": tool("annotations:write", "workspace"),
  "annotations.resolve": tool("annotations:write", "workspace"),
  "threads.participants": tool("threads:read", "none"),
  "threads.list": tool("threads:read", "none"),
  "threads.read": tool("threads:read", "none"),
  "threads.message": tool("threads:read", "none"),
  "threads.wait": tool("threads:read", "none"),
  "threads.post": tool("threads:write", "workspace"),
  "threads.assign_response": tool("threads:write", "workspace"),
  "thread_delivery.register_participant": tool("threads:participate", "none"),
  "thread_delivery.claim": tool("threads:participate", "none"),
  "thread_delivery.accept": tool("threads:participate", "none"),
  "thread_delivery.progress": tool("threads:participate", "none"),
  "thread_delivery.fail": tool("threads:participate", "none"),
  "guidance.format_spec": tool(null, "none"),
  "mermaid.validate": tool(null, "none"),
  "mermaid.preview": tool(null, "none"),
} as const

export type OperationId = keyof typeof OPERATION_DEFINITIONS

function tool(
  scope: string | null,
  mutation: MutationClass,
  resultLink: ResultLinkKind = "none"
) {
  return { scope, mutation, resultLink } as const
}

export interface ResolvedOperation {
  id: OperationId
  args: Record<string, unknown>
}

function withoutAction(
  request: Record<string, unknown>
): Record<string, unknown> {
  const args = { ...request }
  delete args.action
  return args
}

function htmlArgs(request: Record<string, unknown>): Record<string, unknown> {
  const args = withoutAction(request)
  if ("htmlId" in args) {
    args.widgetId = args.htmlId
    delete args.htmlId
  }
  return args
}

function annotationArgs(
  request: Record<string, unknown>
): Record<string, unknown> {
  const args = htmlArgs(request)
  const target = args.target
  if (target && typeof target === "object" && !Array.isArray(target)) {
    const record = { ...(target as Record<string, unknown>) }
    if (record.type === "html") {
      record.type = "widget"
      record.widgetId = record.htmlId
      delete record.htmlId
      args.target = record
    }
  }
  return args
}

export const WORKTABLE_TOOL_ROUTES: Record<
  WorktableToolName,
  Record<string, OperationId>
> = {
  worktable_discover: {
    state: "workspace.state",
    search: "workspace.search",
    space_index: "workspace.space_index",
  },
  worktable_spaces: { create: "spaces.create" },
  worktable_documents_read: {
    list: "documents.list",
    read: "documents.read",
    read_source: "documents.read_source",
    versions: "documents.versions",
  },
  worktable_documents_write: {
    create: "documents.create",
    replace: "documents.replace",
    checkpoint: "documents.checkpoint",
    restore_version: "documents.restore_version",
    move: "documents.move",
    archive: "documents.archive",
    restore: "documents.restore",
    move_folder: "documents.move_folder",
    archive_folder: "documents.archive_folder",
    restore_folder: "documents.restore_folder",
  },
  worktable_docs_read: { list: "docs.list", read: "docs.read" },
  worktable_docs_write: {
    write: "docs.write",
    patch: "docs.patch",
    rename: "docs.rename",
  },
  worktable_html_read: {
    guide: "html.guide",
    list: "html.list",
    read: "html.read",
  },
  worktable_html_write: {
    create: "html.create",
    update: "html.update",
    rename: "html.rename",
    move: "html.move",
    archive: "html.archive",
    restore: "html.restore",
  },
  worktable_records_read: {
    list_collections: "records.list_collections",
    query: "records.query",
    read: "records.read",
  },
  worktable_records_write: {
    upsert_collection: "records.upsert_collection",
    create: "records.create",
    update: "records.update",
  },
  worktable_annotations_read: {
    list: "annotations.list",
    read: "annotations.read",
    context: "annotations.context",
  },
  worktable_annotations_write: {
    create: "annotations.create",
    reply: "annotations.reply",
    update: "annotations.update",
    resolve: "annotations.resolve",
  },
  worktable_threads_read: {
    participants: "threads.participants",
    list: "threads.list",
    read: "threads.read",
    message: "threads.message",
    wait: "threads.wait",
  },
  worktable_threads_write: {
    post: "threads.post",
    assign_response: "threads.assign_response",
  },
  worktable_thread_delivery: {
    register_participant: "thread_delivery.register_participant",
    claim: "thread_delivery.claim",
    accept: "thread_delivery.accept",
    progress: "thread_delivery.progress",
    fail: "thread_delivery.fail",
  },
  worktable_delete: {
    document: "documents.delete",
    doc: "docs.delete",
    html: "html.delete",
    document_folder: "documents.delete_folder",
    record: "records.delete",
  },
  worktable_guidance: {
    format_spec: "guidance.format_spec",
  },
  worktable_mermaid: {
    validate: "mermaid.validate",
    preview: "mermaid.preview",
  },
}

export function resolvePublicOperation(
  toolName: WorktableToolName,
  request: Record<string, unknown>
): ResolvedOperation {
  const action = request.action
  if (typeof action !== "string") throw new Error("request.action is required")
  const id = WORKTABLE_TOOL_ROUTES[toolName][action]
  if (!id) throw new Error(`Unknown action '${action}' for ${toolName}`)

  if (id.startsWith("html.")) return { id, args: htmlArgs(request) }
  if (id.startsWith("annotations."))
    return { id, args: annotationArgs(request) }
  return { id, args: withoutAction(request) }
}
