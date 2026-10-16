import { saveOpenDrawing } from "./drawing-drafts"

type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

function invoke(): NativeInvoke | null {
  return (
    (globalThis as typeof globalThis & {
      __TAURI__?: { core?: { invoke?: NativeInvoke } }
    }).__TAURI__?.core?.invoke ?? null
  )
}

/** Whether this page runs inside Worktable Desktop, which can switch Worktables. */
export function insideDesktop(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute("data-worktable-desktop") &&
    invoke() !== null
  )
}

/**
 * Opens Desktop's Worktable chooser, which closes this page. The open drawing
 * is saved first, and the switch waits if it can't be; Docs keep unsaved
 * edits for recovery. "unavailable" means this Desktop build has no such
 * command or refused this page.
 */
export async function switchDesktopWorktable(): Promise<
  "switching" | "unsaved" | "unavailable"
> {
  const call = invoke()
  if (!call) return "unavailable"
  try {
    await saveOpenDrawing()
  } catch {
    return "unsaved"
  }
  try {
    await call("desktop_workspace_show_chooser")
    return "switching"
  } catch {
    return "unavailable"
  }
}
