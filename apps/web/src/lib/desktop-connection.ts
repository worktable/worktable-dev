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

/** A Worktable on this Mac, as the Worktable menu lists it. */
export interface DesktopWorktable {
  id: string
  name: string
  /** Whether Worktable Link is on for it. */
  linked: boolean
  /** Whether this window shows it. */
  current: boolean
}

/**
 * The Worktables on this Mac. Null when this Desktop build can't list them or
 * this page may not ask, as on a self-hosted server; the menu then keeps
 * Switch Worktable.
 */
export async function desktopWorktables(): Promise<DesktopWorktable[] | null> {
  const call = invoke()
  if (!call) return null
  try {
    const listed = (await call("desktop_workspace_worktables")) as {
      schemaVersion?: unknown
      worktables?: unknown
    } | null
    if (listed?.schemaVersion !== 1 || !Array.isArray(listed.worktables)) return null
    return listed.worktables.flatMap((worktable: Partial<DesktopWorktable> | null) =>
      typeof worktable?.id === "string" && typeof worktable.name === "string"
        ? [
            {
              id: worktable.id,
              name: worktable.name,
              linked: worktable.linked === true,
              current: worktable.current === true,
            },
          ]
        : []
    )
  } catch {
    return null
  }
}

type DesktopOpen =
  | { kind: "local"; id: string }
  | { kind: "cloud"; id: string }
  | { kind: "folder" }

/**
 * Opens another Worktable in this window. The open drawing is saved first;
 * Desktop then shows its progress, and its recovery page if opening fails.
 * "cancelled" means the person closed the folder picker; "not-worktable"
 * that the folder holds no Worktable.
 */
export async function openInDesktop(
  target: DesktopOpen
): Promise<"switching" | "cancelled" | "not-worktable" | "unsaved" | "failed"> {
  const call = invoke()
  if (!call) return "failed"
  try {
    await saveOpenDrawing()
  } catch {
    return "unsaved"
  }
  try {
    if (target.kind === "folder") {
      return (await call("desktop_workspace_open_folder")) === false
        ? "cancelled"
        : "switching"
    }
    await call(
      target.kind === "local" ? "desktop_workspace_open_local" : "desktop_workspace_open_cloud",
      { workspaceId: target.id }
    )
    return "switching"
  } catch (error) {
    if (String(error).startsWith("not a worktable: ")) return "not-worktable"
    console.error("[desktop] Opening a Worktable failed:", error)
    return "failed"
  }
}
