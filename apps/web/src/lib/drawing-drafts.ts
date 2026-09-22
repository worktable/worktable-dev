import { currentWorkspaceContentEpoch } from "./workspace-content-state"
// Drawings share the origin's storage, but drafts belong to a Worktable and
// durable document identity. Moving a path must not strand unsaved ink.
function draftPrefix(workspaceId: string) {
  return `worktable:drawing-draft:${workspaceId}/`
}

export function drawingDraftKey(workspaceId: string, documentId: string) {
  const epoch = currentWorkspaceContentEpoch()
  return `${draftPrefix(workspaceId)}${epoch ? `${epoch}/` : ""}${documentId}`
}

export function clearPersistedDrawingDrafts(
  workspaceId: string,
  oldEpoch?: string
) {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(draftPrefix(workspaceId))) continue
      const suffix = key.slice(draftPrefix(workspaceId).length)
      if (
        !oldEpoch ||
        suffix.startsWith(`${oldEpoch}/`) ||
        !suffix.includes("/")
      )
        localStorage.removeItem(key)
    }
  } catch {
    // Browser storage may be unavailable.
  }
}

export class DrawingUnsavedError extends Error {
  constructor() {
    super("Save this drawing before moving it.")
  }
}

// Only the mounted drawing can have live ink to flush. Rename dialogs already
// block canvas input while the save and move run; this is not a general editor API.
let activeDrawing: {
  spaceId: string
  path: string
  save: () => Promise<void>
} | null = null

export function registerDrawingSave(
  spaceId: string,
  path: string,
  save: () => Promise<void>
) {
  const current = { spaceId, path, save }
  activeDrawing = current
  return () => {
    if (activeDrawing === current) activeDrawing = null
  }
}

export async function flushDrawingBeforeMove(spaceId: string, path: string) {
  if (
    activeDrawing?.spaceId === spaceId &&
    (activeDrawing.path === path || activeDrawing.path.startsWith(`${path}/`))
  )
    await activeDrawing.save()
}
