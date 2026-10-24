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

/** Desktop offers to move agents on this Mac to the Worktable this page shows. */
export interface DesktopAgentOffer {
  /** The Worktable agents use now. */
  agentWorktable: string
  /** The Worktable this page shows. */
  worktable: string
}

/**
 * The offer waiting for this page, if any. Null outside Desktop, in a Desktop
 * build without the offer, and on pages other than the active local one.
 */
export async function desktopAgentOffer(): Promise<DesktopAgentOffer | null> {
  const call = invoke()
  if (!call) return null
  try {
    const offer = (await call("desktop_workspace_agent_offer")) as {
      agentWorktable?: unknown
      worktable?: unknown
    } | null
    if (
      typeof offer?.agentWorktable !== "string" ||
      typeof offer.worktable !== "string"
    ) {
      return null
    }
    return { agentWorktable: offer.agentWorktable, worktable: offer.worktable }
  } catch {
    return null
  }
}

/**
 * Keeps agents where they are, or moves them to this Worktable. Moving saves
 * the open drawing first; with the background service installed, Desktop
 * reopens this page.
 */
export async function answerDesktopAgentOffer(
  switchAgents: boolean
): Promise<void> {
  const call = invoke()
  if (!call) return
  if (switchAgents) await saveOpenDrawing()
  await call("desktop_workspace_answer_agent_offer", { switchAgents })
}
