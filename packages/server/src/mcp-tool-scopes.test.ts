import { describe, expect, it } from "bun:test"
import { mcpToolAuthorized } from "./mcp/tools.ts"
import type { WorktableToolName } from "./mcp/operations.ts"

const MANAGED = [
  "documents:read",
  "documents:write",
  "docs:*",
  "widgets:*",
  "records:*",
  "annotations:*",
  "threads:*",
  "search:read",
]

const ACTIONS: Array<{
  tool: WorktableToolName
  request: Record<string, unknown>
  scope: string | null
}> = [
  { tool: "worktable_discover", request: { action: "state" }, scope: "search:read" },
  { tool: "worktable_discover", request: { action: "search", query: "x" }, scope: "search:read" },
  { tool: "worktable_discover", request: { action: "space_index", spaceId: "s" }, scope: "docs:read" },
  { tool: "worktable_spaces", request: { action: "create", name: "S" }, scope: "docs:write" },
  { tool: "worktable_documents_read", request: { action: "list", spaceId: "s" }, scope: "documents:read" },
  { tool: "worktable_documents_read", request: { action: "read", spaceId: "s", path: "d" }, scope: "documents:read" },
  { tool: "worktable_documents_read", request: { action: "read_source", spaceId: "s", path: "d" }, scope: "documents:read" },
  { tool: "worktable_documents_write", request: { action: "move_folder", spaceId: "s", oldPath: "a", newPath: "b" }, scope: "documents:write" },
  { tool: "worktable_documents_write", request: { action: "archive_folder", spaceId: "s", path: "a" }, scope: "documents:write" },
  { tool: "worktable_documents_write", request: { action: "restore_folder", spaceId: "s", path: "a" }, scope: "documents:write" },
  { tool: "worktable_docs_read", request: { action: "list", spaceId: "s" }, scope: "docs:read" },
  { tool: "worktable_docs_read", request: { action: "read", spaceId: "s", docPath: "d" }, scope: "docs:read" },
  { tool: "worktable_docs_write", request: { action: "write", spaceId: "s", docPath: "d", content: "x" }, scope: "docs:write" },
  { tool: "worktable_docs_write", request: { action: "patch", spaceId: "s", docPath: "d", operations: [] }, scope: "docs:write" },
  { tool: "worktable_docs_write", request: { action: "rename", spaceId: "s", oldPath: "a", newPath: "b" }, scope: "docs:write" },
  { tool: "worktable_html_read", request: { action: "guide" }, scope: null },
  { tool: "worktable_html_read", request: { action: "list", spaceId: "s" }, scope: "widgets:read" },
  { tool: "worktable_html_read", request: { action: "read", spaceId: "s", htmlId: "h" }, scope: "widgets:read" },
  { tool: "worktable_html_write", request: { action: "create", spaceId: "s", name: "H", html: "<html></html>" }, scope: "widgets:write" },
  { tool: "worktable_html_write", request: { action: "update", spaceId: "s", htmlId: "h", html: "<html></html>" }, scope: "widgets:write" },
  { tool: "worktable_html_write", request: { action: "rename", spaceId: "s", htmlId: "h", name: "H" }, scope: "widgets:write" },
  { tool: "worktable_html_write", request: { action: "move", spaceId: "s", htmlId: "h", newPath: "folder/h" }, scope: "widgets:write" },
  { tool: "worktable_html_write", request: { action: "archive", spaceId: "s", htmlId: "h" }, scope: "widgets:write" },
  { tool: "worktable_html_write", request: { action: "restore", spaceId: "s", htmlId: "h" }, scope: "widgets:write" },
  { tool: "worktable_records_read", request: { action: "list_collections", spaceId: "s" }, scope: "records:read" },
  { tool: "worktable_records_read", request: { action: "query", spaceId: "s", collectionId: "c" }, scope: "records:read" },
  { tool: "worktable_records_read", request: { action: "read", spaceId: "s", collectionId: "c", recordId: "r" }, scope: "records:read" },
  { tool: "worktable_records_write", request: { action: "upsert_collection", spaceId: "s", collectionId: "c" }, scope: "records:write" },
  { tool: "worktable_records_write", request: { action: "create", spaceId: "s", collectionId: "c", data: {} }, scope: "records:write" },
  { tool: "worktable_records_write", request: { action: "update", spaceId: "s", collectionId: "c", recordId: "r" }, scope: "records:write" },
  { tool: "worktable_annotations_read", request: { action: "list", spaceId: "s" }, scope: "annotations:read" },
  { tool: "worktable_annotations_read", request: { action: "read", spaceId: "s", annotationId: "a" }, scope: "annotations:read" },
  { tool: "worktable_annotations_read", request: { action: "context", spaceId: "s", annotationId: "a" }, scope: "annotations:read" },
  { tool: "worktable_annotations_write", request: { action: "create", spaceId: "s", target: { type: "doc", docPath: "d" }, category: "comment", body: "x" }, scope: "annotations:write" },
  { tool: "worktable_annotations_write", request: { action: "reply", spaceId: "s", annotationId: "a", body: "x" }, scope: "annotations:write" },
  { tool: "worktable_annotations_write", request: { action: "update", spaceId: "s", annotationId: "a", patch: {} }, scope: "annotations:write" },
  { tool: "worktable_annotations_write", request: { action: "resolve", spaceId: "s", annotationId: "a" }, scope: "annotations:write" },
  { tool: "worktable_threads_read", request: { action: "participants" }, scope: "threads:read" },
  { tool: "worktable_threads_read", request: { action: "list", spaceId: "s" }, scope: "threads:read" },
  { tool: "worktable_threads_read", request: { action: "read", threadId: "thr_example" }, scope: "threads:read" },
  { tool: "worktable_threads_read", request: { action: "wait", threadId: "thr_example", after: 0 }, scope: "threads:read" },
  { tool: "worktable_threads_write", request: { action: "post", to: "ptc_atlas", body: "Hello", idempotencyKey: "scope-test" }, scope: "threads:write" },
  { tool: "worktable_thread_delivery", request: { action: "register_participant", name: "Scope Test" }, scope: "threads:participate" },
  { tool: "worktable_thread_delivery", request: { action: "claim" }, scope: "threads:participate" },
  { tool: "worktable_thread_delivery", request: { action: "accept", messageId: "msg_example", leaseId: "lease_example" }, scope: "threads:participate" },
  { tool: "worktable_thread_delivery", request: { action: "progress", messageId: "msg_example", leaseId: "lease_example", phase: "working" }, scope: "threads:participate" },
  { tool: "worktable_thread_delivery", request: { action: "fail", messageId: "msg_example", leaseId: "lease_example", retryable: false, code: "TEST", message: "test" }, scope: "threads:participate" },
  { tool: "worktable_delete", request: { action: "doc", spaceId: "s", docPath: "d" }, scope: "docs:write" },
  { tool: "worktable_delete", request: { action: "html", spaceId: "s", htmlId: "h" }, scope: "widgets:write" },
  { tool: "worktable_delete", request: { action: "document_folder", spaceId: "s", path: "folder" }, scope: "documents:write" },
  { tool: "worktable_delete", request: { action: "record", spaceId: "s", collectionId: "c", recordId: "r" }, scope: "records:write" },
  { tool: "worktable_guidance", request: { action: "format_spec" }, scope: null },
  { tool: "worktable_mermaid", request: { action: "validate", source: "graph TD; A-->B" }, scope: null },
  { tool: "worktable_mermaid", request: { action: "preview", source: "graph TD; A-->B" }, scope: null },
]

describe("MCP action-level scope enforcement", () => {
  it("allows owner and managed agent scopes for every action", () => {
    for (const item of ACTIONS) {
      expect(mcpToolAuthorized(item.tool, item.request, ["*"])).toBe(true)
      expect(mcpToolAuthorized(item.tool, item.request, MANAGED)).toBe(true)
    }
  })

  it("requires exactly the operation's domain scope", () => {
    for (const item of ACTIONS) {
      const withoutScope = item.scope ? [] : ["docs:read"]
      expect(mcpToolAuthorized(item.tool, item.request, withoutScope)).toBe(
        item.scope === null
      )
      if (item.scope) {
        expect(mcpToolAuthorized(item.tool, item.request, [item.scope])).toBe(true)
      }
    }
  })

  it("keeps mixed capability tools action-aware", () => {
    expect(
      mcpToolAuthorized("worktable_discover", { action: "state" }, ["search:read"])
    ).toBe(true)
    expect(
      mcpToolAuthorized(
        "worktable_discover",
        { action: "space_index", spaceId: "s" },
        ["search:read"]
      )
    ).toBe(false)
    expect(
      mcpToolAuthorized("worktable_html_read", { action: "guide" }, [])
    ).toBe(true)
    expect(
      mcpToolAuthorized(
        "worktable_html_read",
        { action: "read", spaceId: "s", htmlId: "h" },
        []
      )
    ).toBe(false)
  })
})
