import { lazy, Suspense, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Check } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { fetchJSON } from "@/lib/http"

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

const STEPS_CLASS =
  "list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-foreground/60"

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
  return app === "chatgpt" ? (
    <ol className={STEPS_CLASS}>
      <li>In ChatGPT, open Settings → MCP servers.</li>
      <li>Add Worktable with Streamable HTTP and paste this address.</li>
      {token ? <li>Create an access token and paste it too.</li> : null}
    </ol>
  ) : (
    <ol className={STEPS_CLASS}>
      <li>Download the Worktable extension and open it in Claude Desktop.</li>
      <li>Paste this address.</li>
      {token ? <li>Create an access token and paste it too.</li> : null}
      <li>Restart Claude.</li>
    </ol>
  )
}

/**
 * The two ways to use a chat app with this Worktable: on any device through
 * Worktable Link and the app's official Worktable app, or on this computer
 * with the local address. Link comes first: an app added before it is bound
 * to another Worktable. `local` holds the steps for this computer.
 */
export function ChatAppWays({
  app,
  active = true,
  local,
}: {
  app: ChatApp
  /** Whether the surface is showing, so Worktable Link checks its status. */
  active?: boolean
  local: ReactNode
}) {
  const [linkSetup, setLinkSetup] = useState(false)
  // Shares the Link settings' status; their polling keeps it current.
  const link = useQuery({
    queryKey: ["linked"],
    queryFn: () => fetchJSON<{ enabled: boolean | null }>("/api/linked"),
    enabled: active,
  })
  const linkOn = link.data?.enabled === true
  return (
    <div className="flex flex-col gap-5">
      <section
        aria-labelledby={`chat-anywhere-${app}`}
        className="flex flex-col gap-2 rounded-xl bg-surface-inset px-3.5 py-3"
      >
        <h3
          id={`chat-anywhere-${app}`}
          className="text-sm font-medium text-foreground"
        >
          Any device
        </h3>
        <ol className={STEPS_CLASS}>
          <li>
            {linkOn ? (
              <span className="inline-flex items-center gap-1.5 text-foreground">
                <Check aria-hidden className="size-4 text-success" />
                Worktable Link is on
              </span>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                Turn on Worktable Link here.
                {linkSetup ? null : (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => setLinkSetup(true)}
                  >
                    Set Up
                  </Button>
                )}
              </span>
            )}
          </li>
          <li>{OFFICIAL_APP[app]}</li>
        </ol>
        {linkSetup ? (
          <div className="pt-2">
            <Suspense
              fallback={
                <p role="status" className="text-sm text-muted-foreground">
                  Loading Worktable Link…
                </p>
              }
            >
              <WorktableLinkSetup active={active} />
            </Suspense>
          </div>
        ) : null}
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
