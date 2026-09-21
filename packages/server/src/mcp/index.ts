// ============================================================
// Worktable MCP shared module — re-exports for consumers.
// ============================================================

export { registerTools } from "./tools.ts"
export { createWorktableMcpServer } from "./server.ts"
export { SERVER_INSTRUCTIONS } from "./instructions.ts"
export { FORMAT_SPEC } from "./format-spec.ts"
// schemas and helpers are internal implementation details, not re-exported
