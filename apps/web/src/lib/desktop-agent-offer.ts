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
export interface AgentOffer {
  /** The Worktable agents use now. */
  agentWorktable: string
  /** The Worktable this page shows. */
  worktable: string
}

/**
 * The offer waiting for this page, if any. Null in a Desktop build without
 * the offer and on pages other than the active local one.
 */
export async function desktopAgentOffer(): Promise<AgentOffer | null> {
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

interface OfferToasts {
  info: typeof toast.info
  success: typeof toast.success
  error: typeof toast.error
}

/**
 * Shows the offer as a toast. Its action switches agents; closing it keeps
 * them. A second answer waits for the first, and a failed switch shows the
 * offer again so the person can retry. `rename` follows this Worktable's
 * name, which setup may change while the offer shows.
 */
export function presentAgentOffer(
  offer: AgentOffer,
  answer: (switchAgents: boolean) => Promise<void> = answerDesktopAgentOffer,
  toasts: OfferToasts = toast
): { rename: (worktable: string) => void } {
  let { worktable } = offer
  let answering = false
  const show = () =>
    toasts.info(`Your agents still use ${offer.agentWorktable}.`, {
      id: "desktop-agent-offer",
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
      action: {
        label: `Switch them to ${worktable}`,
        onClick: () => {
          if (answering) return
          answering = true
          answer(true).then(
            () => {
              toasts.success(`Agents now use ${worktable}.`)
            },
            (error: unknown) => {
              console.error("[desktop] Switching agents failed:", error)
              answering = false
              toasts.error("Couldn’t switch agents.")
              show()
            }
          )
        },
      },
      onDismiss: () => {
        if (answering) return
        answering = true
        answer(false).catch(() => {
          // Keeping agents where they are needs nothing to succeed.
        })
      },
    })
  show()
  return {
    rename: (name) => {
      if (name === worktable) return
      worktable = name
      // Only an offer still waiting for an answer is shown again.
      if (!answering) show()
    },
  }
}
