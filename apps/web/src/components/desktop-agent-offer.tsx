import { useEffect } from "react"
import { toast } from "@worktable/ui/components/sonner"
import { saveOpenDrawing } from "@/lib/drawing-drafts"

type NativeInvoke = (
  command: string,
  args?: Record<string, unknown>
) => Promise<unknown>

function invoke(): NativeInvoke | null {
  return (
    (
      globalThis as typeof globalThis & {
        __TAURI__?: { core?: { invoke?: NativeInvoke } }
      }
    ).__TAURI__?.core?.invoke ?? null
  )
}

/** Desktop's offer to move agents on this Mac to the Worktable this page shows. */
interface AgentOffer {
  /** The Worktable agents use now. */
  agentWorktable: string
  /** The Worktable this page shows. */
  worktable: string
}

/**
 * The offer waiting for this page, if any. Null in a Desktop build without
 * the offer and on pages other than the active local one.
 */
async function desktopAgentOffer(): Promise<AgentOffer | null> {
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
async function answerDesktopAgentOffer(switchAgents: boolean): Promise<void> {
  const call = invoke()
  if (!call) return
  if (switchAgents) await saveOpenDrawing()
  await call("desktop_workspace_answer_agent_offer", { switchAgents })
}

/**
 * After Worktable Desktop opens a Worktable other than the one agents on this
 * Mac use, offers to move them here. Closing the toast keeps them where they
 * are. Renders nothing; the app shell loads it only inside Desktop.
 */
export function DesktopAgentOffer() {
  useEffect(() => {
    let cancelled = false
    void desktopAgentOffer().then((offer) => {
      if (cancelled || !offer) return
      let answered = false
      const answer = (switchAgents: boolean) => {
        if (answered) return
        answered = true
        answerDesktopAgentOffer(switchAgents).then(
          () => {
            if (switchAgents)
              toast.success(`Agents now use ${offer.worktable}.`)
          },
          (error: unknown) => {
            if (switchAgents) {
              console.error("[desktop] Switching agents failed:", error)
              toast.error("Couldn’t switch agents.")
            }
          }
        )
      }
      toast.info(`Your agents still use ${offer.agentWorktable}.`, {
        id: "desktop-agent-offer",
        duration: Number.POSITIVE_INFINITY,
        closeButton: true,
        action: {
          label: `Switch them to ${offer.worktable}`,
          onClick: () => answer(true),
        },
        onDismiss: () => answer(false),
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  return null
}
