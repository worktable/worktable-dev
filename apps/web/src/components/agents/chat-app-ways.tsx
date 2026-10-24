import { lazy, Suspense, useEffect, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@worktable/ui/components/button"
import { fetchJSON } from "@/lib/http"
import { SetupStep } from "./setup-step"

type ChatApp = "chatgpt" | "claude"

const OFFICIAL_APP: Record<ChatApp, string> = {
  chatgpt: "Add the official Worktable app in ChatGPT.",
  claude: "Add the official Worktable connector in Claude.",
}

// Loaded when asked for, as Grok Bot's setup does.
const WorktableLinkSetup = lazy(() =>
  import("@/components/settings/sections/cloud").then((module) => ({
    default: module.CloudSection,
  }))
)

/**
 * Steps for using a chat app with this Worktable on this computer, through the
 * local address. `token` adds the access token step.
 */
export function LocalChatSteps({
  app,
  token = true,
}: {
  app: ChatApp
  token?: boolean
}) {
  const steps =
    app === "chatgpt"
      ? [
          "In ChatGPT, open Settings → MCP servers.",
          "Add Worktable with Streamable HTTP and paste this address.",
          ...(token ? ["Create an access token and paste it too."] : []),
        ]
      : [
          "Download the Worktable extension and open it in Claude Desktop.",
          "Paste this address.",
          ...(token ? ["Create an access token and paste it too."] : []),
          "Restart Claude.",
        ]
  return (
    <ol className="space-y-1">
      {steps.map((step, index) => (
        <SetupStep key={step} number={index + 1} title={step} />
      ))}
    </ol>
  )
}

/**
 * The two ways to use a chat app with this Worktable: on any device through
 * Worktable Link and the app's official Worktable app, or on this computer
 * with the local address. With Link on, following the steps here tells Cloud
 * the app works in this Worktable. `local` holds the steps for this computer.
 */
export function ChatAppWays({
  app,
  active = true,
  local,
}: {
  app: ChatApp
  /** Whether the steps are showing, so Worktable Link checks its status. */
  active?: boolean
  local: ReactNode
}) {
  const [linkSetup, setLinkSetup] = useState(false)
  const [linkStepOpen, setLinkStepOpen] = useState(false)
  // Shares the Link settings' status; their polling keeps it current.
  const link = useQuery({
    queryKey: ["linked"],
    queryFn: () =>
      fetchJSON<{ enabled: boolean | null; state: string }>("/api/linked"),
    enabled: active,
  })
  // On but locked or failing doesn't let an app in, so the step isn't done.
  const linkOn =
    link.data?.enabled === true &&
    !["locked", "error"].includes(link.data.state)
  // Once Link is on, Cloud sends this app here: the one already connected
  // and the next one added. The server asks Cloud at most every few minutes.
  useEffect(() => {
    if (!active || !linkOn) return
    void fetchJSON("/api/linked/app-intent", {
      method: "POST",
      body: JSON.stringify({ app }),
    }).catch(() => undefined)
  }, [active, linkOn, app])
  return (
    <div className="flex flex-col gap-5">
      <section
        aria-labelledby={`chat-anywhere-${app}`}
        className="flex flex-col gap-1"
      >
        <h3
          id={`chat-anywhere-${app}`}
          className="text-sm font-medium text-foreground"
        >
          Any device
        </h3>
        <ol className="space-y-1">
          <SetupStep
            number={1}
            title={
              linkOn ? "Worktable Link is on" : "Turn on Worktable Link here."
            }
            complete={linkOn}
            // Until Link is on, the step shows how to turn it on.
            {...(linkOn
              ? {
                  open: linkStepOpen,
                  onOpenChange: () => setLinkStepOpen(!linkStepOpen),
                }
              : {})}
          >
            {linkSetup ? (
              <Suspense
                fallback={
                  <p role="status" className="text-sm text-muted-foreground">
                    Loading Worktable Link…
                  </p>
                }
              >
                <WorktableLinkSetup active={active} />
              </Suspense>
            ) : (
              <div>
                <Button onClick={() => setLinkSetup(true)}>Set Up</Button>
              </div>
            )}
          </SetupStep>
          <SetupStep number={2} title={OFFICIAL_APP[app]} />
        </ol>
      </section>
      <section
        aria-labelledby={`chat-local-${app}`}
        className="flex flex-col gap-3"
      >
        <h3
          id={`chat-local-${app}`}
          className="text-sm font-medium text-foreground"
        >
          On this computer
        </h3>
        {local}
      </section>
    </div>
  )
}
