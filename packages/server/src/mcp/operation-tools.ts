import { z } from "zod"
import { DiscoverInputPreview, SpacesInputPreview } from "./schemas.ts"
import {
  PUBLIC_OPERATION_OUTPUT_VARIANTS,
  withNotices,
} from "./output-schemas.ts"
import { WORKTABLE_TOOL_ROUTES } from "./operations.ts"

// Keep the existing capability tools for cached definitions and installed
// clients. New clients can call each discovery/Space operation directly.
export const OPERATION_TOOLS = {
  worktable_state: {
    tool: "worktable_discover",
    action: "state",
    title: "Read Worktable state",
    description:
      "Orient to the workspace or a Space. Read its pinned docs first; they explain where to start.",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  worktable_search: {
    tool: "worktable_discover",
    action: "search",
    title: "Search Worktable context",
    description:
      "Search workspace context by meaning, optionally scoped to a Space or document path. Returns matching items with their sources.",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  worktable_space_index: {
    tool: "worktable_discover",
    action: "space_index",
    title: "Read a Worktable Space index",
    description:
      "Read a Space's document and Record index, optionally including archived items.",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  worktable_pending: {
    tool: "worktable_discover",
    action: "pending",
    title: "Check addressed Worktable items",
    description:
      "Check comments sent to you and thread messages assigned to you. The default returns a count; mode notices returns items and marks them shown. Use wait to listen for new items, then pass the returned revision as since to continue. Reply with worktable_annotations_write reply or worktable_threads_write post and responseTo. Mention unrelated work to your user rather than switching tasks.",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  worktable_spaces_create: {
    tool: "worktable_spaces",
    action: "create",
    title: "Create a Worktable Space",
    description:
      "Create a Space with a name and optional description, icon, color or workspace group.",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  worktable_spaces_update: {
    tool: "worktable_spaces",
    action: "update",
    title: "Update a Worktable Space",
    description:
      "Update a Space's name, description, icon, group or pinned docs. Pin only the one or two docs to read first; Space Home already lists every doc. Setting pins also requires documents:write.",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
  worktable_spaces_archive: {
    tool: "worktable_spaces",
    action: "archive",
    title: "Archive a Worktable Space",
    description:
      "Archive a Space, hiding it from active lists while preserving its content. Optionally record a reason.",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
  worktable_spaces_restore: {
    tool: "worktable_spaces",
    action: "restore",
    title: "Restore a Worktable Space",
    description:
      "Restore an archived Space to active lists with its preserved content.",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const

export type OperationToolName = keyof typeof OPERATION_TOOLS

function buildOperationToolContract(name: OperationToolName) {
  const definition = OPERATION_TOOLS[name]
  const input =
    definition.tool === "worktable_discover"
      ? DiscoverInputPreview
      : SpacesInputPreview
  const variant = input.shape.request.options.find(
    (option) => option.shape.action.value === definition.action
  )!
  const shape = Object.fromEntries(
    Object.entries(variant.shape).filter(([key]) => key !== "action")
  )
  const operation = WORKTABLE_TOOL_ROUTES[definition.tool][definition.action]!
  const variants = PUBLIC_OPERATION_OUTPUT_VARIANTS[operation]
  // MCP output schemas have an object root. State can return either a
  // workspace overview or one Space, so its variant fields are optional.
  const output =
    variants.length === 1
      ? variants[0]!
      : z.looseObject(
          Object.fromEntries(
            variants.flatMap((schema) =>
              Object.entries(schema.shape).map(([key, field]) => [
                key,
                field.optional(),
              ])
            )
          )
        )
  return {
    inputSchema: z.strictObject(shape),
    outputSchema: withNotices(output),
    // Validate the original variant too, including the pins/startHere
    // agreement refinement, before using the shared authorization path.
    parse: (args: Record<string, unknown>) =>
      input.parse({
        request: { ...args, action: definition.action },
      }),
  }
}

// Schemas are immutable and shared across stateless HTTP exchanges.
const contracts = Object.fromEntries(
  (Object.keys(OPERATION_TOOLS) as OperationToolName[]).map((name) => [
    name,
    buildOperationToolContract(name),
  ])
) as Record<OperationToolName, ReturnType<typeof buildOperationToolContract>>

export function operationToolContract(name: OperationToolName) {
  return contracts[name]
}
