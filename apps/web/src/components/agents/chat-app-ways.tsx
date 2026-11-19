import { HelpIcon } from "@/components/help/help"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@worktable/ui/components/button"
import { appOfFamily, useAppChoices, type AppChoice } from "@/lib/app-choices"
import { listAgentConnections } from "@/lib/agent-connections-api"
import { CLAUDE_MARKETPLACE } from "@/lib/agent-app-steps"
import { fetchJSON } from "@/lib/http"
import { getConnection } from "@/lib/system-api"
import { AUTO_REPLY_PROMPT, CopyLine, WORK_CHAT_HINT } from "./auto-reply"
import { ExternalButton, StatusLine } from "./setup-parts"
import { SetupStep } from "./setup-step"

export type ChatApp = "chatgpt" | "claude"

const ADD_APP: Record<ChatApp, string> = {
  chatgpt: "Add the Worktable app in ChatGPT",
  claude: "Add the Worktable plugin in Claude",
}

const APP_NAME: Record<ChatApp, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
}

const OPEN_APP: Record<ChatApp, { label: string; href: string }> = {
  chatgpt: { label: "Open ChatGPT", href: "https://chatgpt.com/" },
  claude: { label: "Open Claude", href: "https://claude.ai/" },
}

/** How to add the official app, with a button that opens it. */
export function AddOfficialApp({
  app,
  waiting = false,
}: {
  app: ChatApp
  /** Shows that Worktable waits for the app to sign in. */
  waiting?: boolean
}) {
  return (
    <>
      {app === "claude" ? (
        <>
          <p className="text-sm text-muted-foreground">
            In Claude, go to Plugins, Add, Add marketplace, and paste this. Then
            add Worktable and sign in.
          </p>
          <CopyLine text={CLAUDE_MARKETPLACE} mono />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          In ChatGPT, find Worktable in Apps, connect it and sign in.
        </p>
      )}
      <div>
        <ExternalButton href={OPEN_APP[app].href}>
          {OPEN_APP[app].label}
        </ExternalButton>
      </div>
      {waiting ? (
        <StatusLine waiting className="mt-0">
          Waiting for {APP_NAME[app]}
        </StatusLine>
      ) : null}
    </>
  )
}

/**
 * Adding the official app, then, for ChatGPT, the line that turns on
 * auto-reply. Where the app works is shown with the setup, not here: adding
 * it is done once Cloud knows the app, wherever it works. `first` numbers
 * the first step.
 */
export function OfficialAppSteps({
  app,
  first,
  active = true,
  ready = true,
  waiting = false,
}: {
  app: ChatApp
  first: number
  active?: boolean
  /** False while an earlier step must come first: the steps wait, muted. */
  ready?: boolean
  /** Shows that Worktable waits for the app while it isn't added. */
  waiting?: boolean
}) {
  const choices = useAppChoices(active)
  const official = appOfFamily(choices.data, app)
  const added = Boolean(official?.worktable)
  const here = official?.worktable?.here === true
  // Its row here, to show auto-reply on once the chat is watching. The
  // agent list's own query, so live participant changes refresh it too.
  const system = useQuery({
    queryKey: ["system", "connection"],
    queryFn: getConnection,
    enabled: active && here && app === "chatgpt",
  })
  const cloud = system.data?.mcpAuthMode === "oauth"
  const connections = useQuery({
    queryKey: ["agent-connections", cloud],
    queryFn: () => listAgentConnections({ workspaceAgentsOnCloud: cloud }),
    enabled: active && here && app === "chatgpt" && system.isFetched,
  })
  // Only while it works here: a cached On from before a move says nothing now.
  const autoReply = !here
    ? undefined
    : connections.data?.connections.find(
        (connection) =>
          connection.target.kind === "mcp-client" &&
          connection.target.clientId === official?.clientId
      )?.autoReply
  return (
    <>
      <SetupStep
        number={first}
        title={
          ready ? (
            ADD_APP[app]
          ) : (
            <span className="text-muted-foreground">{ADD_APP[app]}</span>
          )
        }
        complete={added}
      >
        {added || !ready ? null : (
          <AddOfficialApp app={app} waiting={waiting} />
        )}
      </SetupStep>
      {app === "chatgpt" &&
        (autoReply?.state === "on" ? (
          <SetupStep number={first + 1} title="Auto-reply is on" complete />
        ) : (
          <SetupStep
            number={first + 1}
            title={
              here ? (
                "Turn on auto-reply"
              ) : (
                <span className="text-muted-foreground">
                  Turn on auto-reply
                </span>
              )
            }
          >
            {!here ? null : (
              <>
                <CopyLine text={AUTO_REPLY_PROMPT} />
                <p className="text-sm text-muted-foreground">
                  {WORK_CHAT_HINT}
                </p>
              </>
            )}
          </SetupStep>
        ))}
    </>
  )
}

// Loaded when asked for, as Grok Bot's setup does.
const WorktableLinkSetup = lazy(() =>
  import("@/components/settings/sections/cloud").then((module) => ({
    default: module.CloudSection,
  }))
)

/** Worktable Link's status, shared with the Link settings, whose polling keeps it current. */
function useLinkOn(active: boolean) {
  const link = useQuery({
    queryKey: ["linked"],
    queryFn: () =>
      fetchJSON<{ enabled: boolean | null; state: string }>("/api/linked"),
    enabled: active,
  })
  // On but locked or failing doesn't let an app in, so the step isn't done.
  const on =
    link.data?.enabled === true &&
    !["locked", "error"].includes(link.data.state)
  return { on, known: link.isSuccess, data: link.data }
}

/**
 * A chat app on a Worktable outside Cloud: Worktable Link lets Cloud reach
 * it, then the app's official plugin works as it does on Cloud. Turning Link
 * on from here tells Cloud the app works in this Worktable. Once Cloud says
 * it does, the app is connected here.
 */
export function LinkedAppSteps({
  app,
  active = true,
  onConnected,
}: {
  app: ChatApp
  /** Whether the surface is showing, so Worktable Link checks its status. */
  active?: boolean
  /** Called once, when Cloud says the app works in this Worktable. */
  onConnected?: (official: AppChoice) => void
}) {
  const [linkSetup, setLinkSetup] = useState(false)
  const [linkStepOpen, setLinkStepOpen] = useState(false)
  const link = useLinkOn(active)
  // Cloud's answer, which the app's own steps read too. It reads again when
  // the person comes back from the app.
  const choices = useAppChoices(active && link.on)
  const official = appOfFamily(choices.data, app)
  const here = link.on && official?.worktable?.here === true
  const reported = useRef(false)
  useEffect(() => {
    if (!here || !official || reported.current) return
    reported.current = true
    onConnected?.(official)
  }, [here, official, onConnected])
  // Turning Link on through Set Up here sends this app here on Cloud: the
  // one already connected and the next one added. Only a Set Up started
  // while Link was known to be off counts; viewing the steps, or opening
  // Set Up with Link already on, never does. Cloud's Apps page moves an
  // app otherwise.
  const setUpFor = useRef<ChatApp | null>(null)
  useEffect(() => {
    const setUp = setUpFor.current
    if (!setUp || !link.on) return
    setUpFor.current = null
    void fetchJSON("/api/linked/app-intent", {
      method: "POST",
      body: JSON.stringify({ app: setUp }),
    }).catch(() => undefined)
  }, [linkSetup, link.on])
  return (
    <ol className="space-y-1">
      <SetupStep
        number={1}
        title={
          <span className="flex items-center gap-1.5">
            {link.on ? "Worktable Link is on" : "Turn on Worktable Link"}
            <HelpIcon entry="worktableLink" label="About Worktable Link" />
          </span>
        }
        complete={link.on}
        // Until Link is on, the step shows how to turn it on.
        {...(link.on
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
              variant="outline"
              size="sm"
              onClick={() => {
                if (link.data && !link.on) setUpFor.current = app
                setLinkSetup(true)
              }}
            >
              Set Up
            </Button>
          </div>
        )}
      </SetupStep>
      <OfficialAppSteps
        app={app}
        first={2}
        active={active && link.on}
        ready={link.on}
        waiting={link.on}
      />
    </ol>
  )
}
