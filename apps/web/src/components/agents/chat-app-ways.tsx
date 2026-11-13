import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useQuery } from "@tanstack/react-query"
import type { AgentConnectionInventory } from "@worktable/types"
import { Button, buttonVariants } from "@worktable/ui/components/button"
import {
  appOfFamily,
  useAppChoices,
  useUseHere,
  worktableLabel,
} from "@/lib/app-choices"
import { fetchJSON } from "@/lib/http"
import { AUTO_REPLY_PROMPT, CopyLine, WORK_CHAT_HINT } from "./auto-reply"
import { SetupStep } from "./setup-step"

type ChatApp = "chatgpt" | "claude"

const APP_NAME: Record<ChatApp, string> = { chatgpt: "ChatGPT", claude: "Claude" }

const OFFICIAL_APP: Record<ChatApp, string> = {
  chatgpt: "Add the official Worktable app in ChatGPT.",
  claude: "Add the official Worktable connector in Claude.",
}

const OPEN_APP: Record<ChatApp, { label: string; href: string }> = {
  chatgpt: { label: "Open ChatGPT", href: "https://chatgpt.com/" },
  claude: { label: "Open Claude", href: "https://claude.ai/" },
}

/**
 * The official app's steps once this Worktable is reachable through Cloud:
 * where the app works now, with Use Here when it works elsewhere, then, for
 * ChatGPT, the line that turns on auto-reply. Without word from Cloud they
 * read as before. `first` numbers the first of them.
 */
export function OfficialAppSteps({
  app,
  first,
  active = true,
}: {
  app: ChatApp
  first: number
  active?: boolean
}) {
  const choices = useAppChoices(active)
  const useHere = useUseHere()
  const official = appOfFamily(choices.data, app)
  const known = choices.data != null
  const here = official?.worktable?.here === true
  // Its row here, to show auto-reply on once the chat is watching.
  const connections = useQuery({
    queryKey: ["agent-connections", "official-app"],
    queryFn: () =>
      fetchJSON<AgentConnectionInventory>("/api/agent-connections"),
    enabled: active && here && app === "chatgpt",
  })
  const autoReply = connections.data?.connections.find(
    (connection) =>
      connection.target.kind === "mcp-client" &&
      connection.target.clientId === official?.clientId
  )?.autoReply
  const open = (
    <a
      href={OPEN_APP[app].href}
      target="_blank"
      rel="noreferrer"
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      {OPEN_APP[app].label}
    </a>
  )
  const name = APP_NAME[app]
  return (
    <>
      {!known || !official ? (
        <SetupStep number={first} title={OFFICIAL_APP[app]}>
          {known ? <div>{open}</div> : null}
        </SetupStep>
      ) : !official.worktable || official.worktable.here ? (
        <SetupStep number={first} title={`${name} works here`} complete />
      ) : (
        <SetupStep
          number={first}
          title={`${name} works in ${worktableLabel(official.worktable)}.`}
        >
          <div>
            <Button
              size="sm"
              disabled={useHere.isPending}
              onClick={() => useHere.mutate(official)}
            >
              Use Here
            </Button>
          </div>
        </SetupStep>
      )}
      {app === "chatgpt" &&
        (autoReply?.state === "on" ? (
          <SetupStep number={first + 1} title="Auto-reply is on" complete />
        ) : (
          <SetupStep
            number={first + 1}
            title={
              known && !here ? (
                <span className="text-muted-foreground">
                  Turn on auto-reply
                </span>
              ) : (
                "Turn on auto-reply"
              )
            }
          >
            {!known || here ? (
              <>
                <CopyLine text={AUTO_REPLY_PROMPT} />
                <p className="text-sm text-muted-foreground">
                  {WORK_CHAT_HINT}
                </p>
              </>
            ) : null}
          </SetupStep>
        ))}
      {known && choices.data ? (
        <li className="pt-1 pl-9">
          <a
            href={choices.data.appsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            All Apps
          </a>
        </li>
      ) : null}
    </>
  )
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
 * with the local address. Turning Link on from these steps tells Cloud the
 * app works in this Worktable. `local` holds the steps for this computer.
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
  // Turning Link on through Set Up here sends this app here on Cloud: the
  // one already connected and the next one added. Only a Set Up started
  // while Link was known to be off counts; viewing the steps, or opening
  // Set Up with Link already on, never does. Cloud's Apps page moves an
  // app otherwise.
  const setUpFor = useRef<ChatApp | null>(null)
  useEffect(() => {
    const setUp = setUpFor.current
    if (!setUp || !linkOn) return
    setUpFor.current = null
    void fetchJSON("/api/linked/app-intent", {
      method: "POST",
      body: JSON.stringify({ app: setUp }),
    }).catch(() => undefined)
  }, [linkSetup, linkOn])
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
                <Button
                  onClick={() => {
                    if (link.data && !linkOn) setUpFor.current = app
                    setLinkSetup(true)
                  }}
                >
                  Set Up
                </Button>
              </div>
            )}
          </SetupStep>
          <OfficialAppSteps app={app} first={2} active={active && linkOn} />
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
        {app === "chatgpt" ? (
          <p className="text-sm text-muted-foreground">
            For Local chats in the ChatGPT desktop app.
          </p>
        ) : null}
        {local}
      </section>
    </div>
  )
}
