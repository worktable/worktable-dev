import { saveOpenDrawing } from "./drawing-drafts"

type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

/** Desktop's native command bridge, when this page runs inside Desktop. */
export function invoke(): NativeInvoke | null {
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

/** Desktop's prefix for a switch that started and failed. */
const SWITCH_FAILED = "switch failed: "

/**
 * Opens Desktop's Worktable chooser, which closes this page. The open drawing
 * is saved first, and the switch waits if it can't be; Docs keep unsaved
 * edits for recovery. "unavailable" means this Desktop build has no such
 * command or refused this page; "failed" means the switch itself failed.
 */
export async function switchDesktopWorktable(): Promise<
  "switching" | "unsaved" | "unavailable" | "failed"
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
  } catch (error) {
    if (String(error).startsWith(SWITCH_FAILED)) {
      console.error("[desktop] Switch Worktable failed:", error)
      return "failed"
    }
    return "unavailable"
  }
}

