import { AgentInstructions } from "@/components/agent-instructions"
import {
  APP_STEPS,
  CODING_PLUGIN_STEPS,
  addressStep,
  appValue,
  appsFor,
  claudeConnectorLink,
  connectCommand,
  isPluginApp,
  placeOf,
  sharedAddressLandsHere,
  skillsCommand,
  waysFor,
  type AgentApp,
  type AppId,
  type Place,
  type Way,
} from "@/lib/agent-app-steps"
import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import { ChevronRight, Loader2, Plug } from "lucide-react"
import {
  AGENT_PLATFORMS,
  agentConnectionOnCodexHost,
  DEFAULT_AGENT_ACCESS,
  platformForClient,
  type AgentAccess,
  type AgentConnection,
  type DirectAgentLabel,
} from "@worktable/types"
import { Button, buttonVariants } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"
import { Input } from "@worktable/ui/components/input"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"

import {
  AccessPills,
  AgentAccessFields,
} from "@/components/agents/agent-access-fields"
import { AgentAvatar } from "@/components/agents/agent-avatar"
import { AutoReplySetting } from "@/components/agents/auto-reply"
import {
  AddOfficialApp,
  LinkedAppSteps,
  OfficialAppSteps,
} from "@/components/agents/chat-app-ways"
import { GrokBotSetupPanel } from "@/components/agents/grok-bot-setup"
import {
  CommandBlock,
  ConnectedMark,
  ExternalButton,
  StatusLine,
} from "@/components/agents/setup-parts"
import { MoveHereButton } from "@/components/agents/works-in"
import {
  agentConnectionPlatform,
  connectAgentApp,
  getAppAgent,
  listAgentConnections,
  saveAgentChanges,
} from "@/lib/agent-connections-api"
import { HERMES, OPENCLAW, type AlwaysOnAgent } from "@/lib/always-on-agents"
import {
  appOfFamily,
  useAppChoices,
  useConnectionApp,
  worksElsewhere,
  worktableLabel,
  type AppChoice,
  type AppFamily,
} from "@/lib/app-choices"
import { desktopAgentConnectionDetails } from "@/lib/desktop-agent-connection"
import type { SetupRecord } from "@/lib/onboarding-setups"
import {
  createPairing,
  getPairing,
  latestPairingFailure,
  shouldPollPairing,
  type PairingCreated,
} from "@/lib/pairing-api"
import { useWorkspace } from "@/lib/queries"
import { getConnection, type ConnectionInfo } from "@/lib/system-api"
import { threadQueryKeys } from "@/lib/threads-queries"
import { listTokens } from "@/lib/tokens-api"
import { StepHeading } from "./onboarding-shared"

const ALWAYS_ON: Record<"openclaw" | "hermes", AlwaysOnAgent> = {
  openclaw: OPENCLAW,
  hermes: HERMES,
}

/** Apps Cloud tells us the Worktable of, by family. */
const FAMILY: Partial<Record<AppId, AppFamily>> = {
  claude: "claude",
  chatgpt: "chatgpt",
  "grok-bot": "grok",
}

/** Labels an app's credential carries, so the agent shows its platform. */
const TOKEN_LABEL: Partial<Record<Way["kind"], DirectAgentLabel>> = {
  extension: "claude-desktop",
  "chatgpt-local": "chatgpt-desktop",
}

/** What another way is called under Other Ways. */
const WAY_NAME: Record<Way["kind"], string> = {
  "claude-plugin": "Plugin",
  "chatgpt-app": "ChatGPT App",
  "coding-plugin": "Plugin",
  "app-plugin": "Plugin",
  address: "MCP Address",
  "claude-connector": "Connector",
  "cloud-command": "Connect Command",
  pairing: "Connect Command",
  "always-on": "Plugin",
  grok: "Grok Bot",
  extension: "Desktop Extension",
  "chatgpt-local": "Local Chats",
  token: "Access Token",
}

/** The page this setup is open in, which decides "On this computer". */
function thisPage() {
  return {
    hostname: window.location.hostname,
    desktop: document.documentElement.hasAttribute("data-worktable-desktop"),
  }
}

function shellLines(lines: Array<string | null | false>): string {
  return lines.filter(Boolean).join("\n")
}

function Instruction({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-sm leading-6 text-foreground/80">{children}</p>
}

/** The agent list Settings shows, which setups read and refresh. */
function connectionsQuery(cloud: boolean) {
  return {
    queryKey: ["agent-connections", cloud],
    queryFn: () => listAgentConnections({ workspaceAgentsOnCloud: cloud }),
  }
}

/** The agent list as it is now, for finding the agent that just connected. */
async function currentConnections(
  queryClient: QueryClient,
  cloud: boolean
): Promise<AgentConnection[]> {
  try {
    const inventory = await queryClient.fetchQuery({
      ...connectionsQuery(cloud),
      staleTime: 0,
    })
    return inventory.connections
  } catch {
    return []
  }
}

interface PanelProps {
  app: AgentApp
  way: Way
  place: Place
  connection: ConnectionInfo
  /** The agent this app already connected, if it did. */
  connected: SetupRecord | undefined
  onConnected: (setup: SetupRecord) => void
  /** An agent this card made that isn't set up yet, kept out of the list. */
  onPending: (connectionId: string) => void
  /** Pairings made here, kept per way so switching back reuses one. */
  pairings: Record<string, PairingCreated>
  onPairing: (key: string, pairing: PairingCreated | null) => void
  /** Tokens made here, kept like pairings: each is shown only once. */
  tokens: Record<string, MadeToken>
  onToken: (key: string, token: MadeToken) => void
  /** Agents already signed in to Cloud when this step opened. */
  baseline: Set<string>
  cloudConnections: AgentConnection[] | undefined
  /** Whether the surface is showing. */
  active: boolean
  /** The best way waits for the agent; the others only show how. */
  primary: boolean
  /** The card adds another agent: one connected before it opened isn't this one. */
  another: boolean
  /** Counts each pick of an app, so a panel that keeps its own setup starts over. */
  pick: number
}

function sourceOf(app: AgentApp): string {
  return `app:${app.id}`
}

function setupFor(
  app: AgentApp,
  id: string,
  name: string,
  connectionId?: string
): SetupRecord {
  return {
    id,
    name,
    harness: app.id === "other" ? "MCP agent" : app.name,
    mode: app.alwaysOn ? "always-on" : "on-demand",
    verified: true,
    platform: app.platform,
    source: sourceOf(app),
    ...(connectionId ? { connectionId } : {}),
  }
}

/** What an always-on agent is called until its owner renames it. */
function agentName(app: AgentApp): string {
  if (app.id === "other") return "My agent"
  if (app.id === "codex") return AGENT_PLATFORMS.codex.name
  return app.name
}

function waitingFor(app: AgentApp): string {
  return app.id === "other" ? "your agent" : app.name
}

/** Stands in for a pairing code until it arrives; codes look like ABCDE-FGHIJ. */
const CODE_PLACEHOLDER = "·····-·····"

/**
 * Agents on this computer or a server connect directly with a one-use code.
 * Coding agents get Worktable's skills from the same command.
 */
function PairingPanel({
  app,
  way,
  place,
  connection,
  connected,
  onConnected,
  onPending,
  pairings,
  onPairing,
  active,
  another,
}: PanelProps) {
  const queryClient = useQueryClient()
  const cloud = connection.mcpAuthMode === "oauth"
  const key = `${app.id}:${way.kind}`
  const pairing = pairings[key]
  // Where another agent is added, its access is chosen before the command is
  // made; a new choice makes a new command.
  const [access, setAccess] = useState(DEFAULT_AGENT_ACCESS)
  const agent = way.kind === "always-on" ? ALWAYS_ON[way.adapter] : null
  const client = way.kind === "pairing" ? way.client : null
  const create = useMutation({
    mutationFn: () =>
      agent
        ? createPairing({
            target: {
              kind: "agent-adapter",
              adapter: agent.adapter,
              participantName: agentName(app),
            },
            access,
          })
        : // Worktable names the agent, and tells two on one Worktable apart.
          createPairing({ client, access }),
    onSuccess: (created) => onPairing(key, created),
  })
  // The command is ready when the app is chosen. One request per command: a
  // render before the mutation reports pending must not make another.
  const requested = useRef(false)
  useEffect(() => {
    if (pairing || connected || requested.current) return
    requested.current = true
    create.mutate()
  }, [pairing, connected, create])
  const status = useQuery({
    queryKey: ["pairing", pairing?.id],
    queryFn: () => getPairing(pairing!.id),
    enabled: active && Boolean(pairing) && !connected,
    refetchInterval: (query) =>
      shouldPollPairing(query.state.data) ? 2_000 : false,
  })
  const session = status.data
  useEffect(() => {
    if (session?.status !== "verified" || !pairing || connected) return
    if (session.connectionId) onPending(session.connectionId)
    // A card that finished another way, or closed, takes nothing from this.
    let current = true
    void currentConnections(queryClient, cloud).then((connections) => {
      if (!current) return
      // The pairing names the agent it made or reconnected.
      const made = connections.find((item) => item.id === session.connectionId)
      onConnected(
        setupFor(
          app,
          `pairing:${pairing.id}`,
          made?.displayName ?? agentName(app),
          // The pairing names its agent even when the list can't be read.
          session.connectionId ?? made?.id
        )
      )
    })
    return () => {
      current = false
    }
    // Only the verified transition adds the agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.status, pairing?.id])

  // The command keeps its shape while its code is made, so nothing jumps.
  const origin =
    pairing?.serverOrigin ??
    new URL(desktopAgentConnectionDetails(connection).endpoint).origin
  const code = pairing?.code ?? CODE_PLACEHOLDER
  const command = agent
    ? shellLines([
        agent.installCommand,
        agent.restartBeforeConnect && agent.restartCommand,
        agent.localConnectCommand(origin, code),
        !agent.restartBeforeConnect && agent.restartCommand,
      ])
    : way.kind === "pairing"
      ? connectCommand(way, {
          connectScript: pairing
            ? new URL("/connect.sh", pairing.mcpUrl).href
            : `${origin}/connect.sh`,
          code,
        })
      : ""
  const ended = session?.status === "expired" || session?.status === "failed"
  const failure = session ? latestPairingFailure(session) : null
  const newCommand = () => {
    requested.current = false
    onPairing(key, null)
    create.reset()
  }

  return (
    <>
      <Instruction>
        {agent
          ? place === "computer"
            ? "Run this in your terminal."
            : `Run this where ${agent.name} runs.`
          : client
            ? "Run this in your terminal."
            : "Run this in your terminal. It adds Worktable to the agents it finds, such as OpenCode and VS Code."}
      </Instruction>
      {another ? (
        <div className="mb-3">
          <AccessPills
            value={access}
            alwaysOn={Boolean(agent)}
            // Once its code is used, the command's access is settled.
            disabled={!pairing || session?.status === "redeemed"}
            onChange={(next) => {
              setAccess(next)
              newCommand()
            }}
          />
        </div>
      ) : null}
      <CommandBlock value={command} pending={!pairing} />
      {create.isError ? (
        <Callout variant="danger" className="mt-3">
          Couldn’t make the command.{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => create.mutate()}
          >
            Try again
          </button>
        </Callout>
      ) : ended ? (
        <Callout variant="warning" className="mt-3">
          {session?.status === "expired"
            ? "This command expired."
            : `It didn’t connect${failure?.detail ? `: ${failure.detail}` : "."}`}{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={newCommand}
          >
            Make a new command
          </button>
        </Callout>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <StatusLine waiting className="mt-0">
            Waiting for {waitingFor(app)}
          </StatusLine>
          {/* A command that used its code and then stopped can't run again. */}
          {session?.status === "redeemed" ? (
            <Button variant="ghost" size="sm" onClick={newCommand}>
              New Command
            </Button>
          ) : null}
        </div>
      )}
    </>
  )
}

/** A token made for an app, and the agent it belongs to. */
interface MadeToken {
  value: string
  id: string
  agent: AgentConnection
}

/** The token's id, from its `wt_<id>_<secret>` form. */
function tokenId(token: string): string | null {
  return /^wt_([0-9a-f]{12})_/.exec(token)?.[1] ?? null
}

function tokenSteps(kind: Way["kind"]): string[] | null {
  if (kind === "extension")
    return [
      "Download the extension and open it in Claude Desktop.",
      "Approve it, paste this address and an access token, then restart Claude.",
    ]
  if (kind === "chatgpt-local")
    return [
      "In ChatGPT, open Settings, then MCP servers.",
      "Add Worktable with Streamable HTTP and paste this address and an access token.",
    ]
  return null
}

/**
 * Apps and other MCP agents on a computer or server connect with this
 * Worktable's address and an access token made here. The token is offered
 * even where a bare local call works: it gives the agent its own name and
 * access, and its first use is how this setup sees the agent arrive.
 */
function TokenPanel({
  app,
  way,
  connection,
  connected,
  onConnected,
  onPending,
  tokens: made,
  onToken,
  active,
  another,
}: PanelProps) {
  const queryClient = useQueryClient()
  const key = `${app.id}:${way.kind}`
  const token = made[key] ?? null
  const label = TOKEN_LABEL[way.kind] ?? null
  const { endpoint } = desktopAgentConnectionDetails(connection)
  // An app connected before is the same agent: keep its name and access.
  const existing = useQuery({
    queryKey: ["agent-connections", "app", label],
    queryFn: () => getAppAgent(label!),
    enabled: active && Boolean(label),
  })
  const name =
    existing.data?.connection?.displayName ??
    (label ? AGENT_PLATFORMS[platformForClient(label)].name : agentName(app))
  const [chosenAccess, setAccess] = useState<AgentAccess | null>(null)
  const access =
    chosenAccess ?? existing.data?.connection?.access ?? DEFAULT_AGENT_ACCESS
  const mint = useMutation({
    mutationFn: () =>
      connectAgentApp({
        client: label,
        displayName: name,
        access,
      }),
    onSuccess: ({ token: value, connection: agent }) => {
      const id = tokenId(value)
      if (id) onToken(key, { value, id, agent })
      // The agent is listed once it connects and the card is done.
      onPending(agent.id)
      void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    },
  })
  const tokens = useQuery({
    queryKey: ["tokens"],
    queryFn: listTokens,
    enabled: active && Boolean(token) && !connected,
    refetchInterval: 3_000,
  })
  const used = Boolean(
    token && tokens.data?.find((item) => item.id === token.id)?.lastUsedAt
  )
  useEffect(() => {
    if (!used || !token || connected) return
    onConnected(
      setupFor(
        app,
        `token:${token.id}`,
        token.agent.displayName,
        token.agent.id
      )
    )
    // Only the first use adds the agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [used, token?.id])

  const steps = tokenSteps(way.kind)
  return (
    <>
      {steps ? (
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm leading-6 text-foreground/80 marker:text-muted-foreground">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : (
        <Instruction>
          Add Worktable to your agent as an MCP server with this address and an
          access token.
        </Instruction>
      )}
      {another && !token ? (
        <div className="mb-3">
          <AccessPills
            value={access}
            disabled={mint.isPending}
            onChange={setAccess}
          />
        </div>
      ) : null}
      <div className="space-y-2">
        <CommandBlock value={endpoint} />
        {token && !connected ? (
          <>
            <CommandBlock value={token.value} />
            <p className="text-xs text-muted-foreground">
              Copy the token now. It isn’t shown again.
            </p>
          </>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {way.kind === "extension" ? (
          <a
            href="/integrations/claude-desktop.mcpb"
            download="worktable-claude-desktop.mcpb"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Download
          </a>
        ) : null}
        {token || connected ? null : (
          <Button
            variant="outline"
            size="sm"
            disabled={mint.isPending || (Boolean(label) && !existing.isSuccess)}
            onClick={() => mint.mutate()}
          >
            {mint.isPending ? "Creating…" : "Create Token"}
          </Button>
        )}
      </div>
      {mint.isError || existing.isError ? (
        <Callout variant="danger" className="mt-3">
          Couldn’t create the token. Try again.
        </Callout>
      ) : token ? (
        <StatusLine waiting>Waiting for {waitingFor(app)}</StatusLine>
      ) : null}
    </>
  )
}

/** Whether a Cloud connection is the one this app is waiting for. */
function signedInHere(
  app: AgentApp,
  way: Way,
  connection: AgentConnection
): boolean {
  if (
    way.kind === "always-on" &&
    ALWAYS_ON[way.adapter].cloudAuth === "approval"
  ) {
    return (
      connection.target.kind === "agent-adapter" &&
      connection.target.adapter === way.adapter
    )
  }
  if (connection.authKind !== "oauth") return false
  // A named app waits for itself; Other takes any that signs in.
  const platform = agentConnectionPlatform(connection)
  return (
    app.id === "other" ||
    platform === app.platform ||
    // These apps sign in under names we may not know yet, by plugin or address.
    ((isPluginApp(app.id) || app.id === "devin" || app.id === "junie") &&
      platform === "other") ||
    // Codex CLI signs in as the Codex client, which ChatGPT Desktop shares.
    (app.id === "codex" && agentConnectionOnCodexHost(connection))
  )
}

/** What a Cloud way has you do, and the value to copy. */
function cloudStep(
  app: AgentApp,
  way: Way,
  url: string
): { step: string; value: string; open?: { label: string; href: string } } {
  switch (way.kind) {
    case "coding-plugin":
      return {
        step: CODING_PLUGIN_STEPS[way.client].step,
        value: CODING_PLUGIN_STEPS[way.client].command,
      }
    case "app-plugin":
      return { step: APP_STEPS[way.app], value: appValue(way.app) }
    case "claude-connector":
      return {
        step: "Works on every Claude plan, Free included.",
        value: url,
        open: { label: "Add Connector", href: claudeConnectorLink(url) },
      }
    case "address":
      return addressStep(app.id, url)
    case "cloud-command":
      return {
        step:
          way.client === "cursor"
            ? "Run this in your terminal, then open Cursor and sign in."
            : way.client
              ? "Run this in your terminal, then choose Allow access when your browser opens."
              : "Run this in your terminal and sign in when asked. It adds Worktable to the agents it finds, such as OpenCode and VS Code.",
        value: connectCommand(way, { mcpUrl: url }),
      }
    case "always-on": {
      const agent = ALWAYS_ON[way.adapter]
      return {
        step: `Run this where ${agent.name} runs, then ${agent.cloudAuth === "oauth" ? "sign in" : "open the link it prints to approve it"}.`,
        value: shellLines([
          agent.installCommand,
          agent.restartBeforeConnect && agent.restartCommand,
          agent.cloudConnectCommand(url, agentName(app)),
          !agent.restartBeforeConnect && agent.restartCommand,
        ]),
      }
    }
    default:
      return { step: "", value: url }
  }
}

/** Waits for the app to sign in to Cloud, then adds it once. */
function useCloudArrival({
  app,
  way,
  connected,
  onConnected,
  onPending,
  baseline,
  cloudConnections,
}: PanelProps) {
  const arrived = cloudConnections?.find(
    (item) => !baseline.has(item.id) && signedInHere(app, way, item)
  )
  const accept = useMutation({
    mutationFn: async (selected: AgentConnection) => {
      // Saving shows a sign-in agent in this Worktable's Threads.
      if (selected.authKind === "oauth")
        await saveAgentChanges(selected, {
          name: selected.displayName,
          icon: selected.icon ?? null,
          access: selected.access,
        })
      return selected
    },
    onSuccess: (selected) =>
      onConnected(
        setupFor(app, selected.id, selected.displayName, selected.id)
      ),
  })
  const accepted = useRef<string | null>(null)
  useEffect(() => {
    if (!arrived || connected || accepted.current === arrived.id) return
    accepted.current = arrived.id
    onPending(arrived.id)
    accept.mutate(arrived)
  }, [arrived, connected, accept, onPending])
  return { arrived, accept }
}

function CloudStatus(props: PanelProps) {
  const { app } = props
  const { arrived, accept } = useCloudArrival(props)
  if (accept.isError)
    return (
      <Callout variant="danger" className="mt-3">
        {arrived?.displayName ?? "Your agent"} signed in, but couldn’t be added.{" "}
        <button
          type="button"
          className="font-medium underline underline-offset-2"
          onClick={() => arrived && accept.mutate(arrived)}
        >
          Try again
        </button>
      </Callout>
    )
  return <StatusLine waiting>Waiting for {waitingFor(app)}</StatusLine>
}

/** On Cloud, agents sign in with the Worktable's address or the plugin. */
function SignInPanel(props: PanelProps) {
  const { app, way, connection } = props
  const { step, value, open } = cloudStep(app, way, connection.remoteMcpUrl)
  const { skills } = way
  // An address brings no skills, so they are a step of their own.
  const skillsStep = skills.via === "files" || skills.via === "url"
  const back = props.primary ? " Then return to Worktable." : null
  return (
    <>
      <Instruction>
        {step}
        {skillsStep ? null : back}
      </Instruction>
      <CommandBlock value={value} />
      {open ? (
        <div className="mt-3">
          <ExternalButton href={open.href}>{open.label}</ExternalButton>
        </div>
      ) : null}
      {skills.via === "files" ? (
        <div className="mt-3">
          <Instruction>
            Then download the{" "}
            <a
              href={skills.href}
              className="font-medium text-primary-text hover:underline"
            >
              Worktable skill
            </a>
            , unpack it, and upload its worktable folder in Customize, then
            Skills.{back}
          </Instruction>
        </div>
      ) : skills.via === "url" ? (
        <div className="mt-3">
          <Instruction>Then run this for Worktable’s skills.{back}</Instruction>
          <CommandBlock value={skillsCommand(skills.target)} />
        </div>
      ) : null}
      {props.primary ? <CloudStatus {...props} /> : null}
    </>
  )
}

/** Claude and ChatGPT add their official Worktable plugin or app. */
function OfficialAppPanel(props: PanelProps) {
  const { app, way, active, connection, onConnected } = props
  const queryClient = useQueryClient()
  if (way.kind !== "claude-plugin" && way.kind !== "chatgpt-app") return null
  const chat = way.kind === "claude-plugin" ? "claude" : "chatgpt"
  if (way.link)
    return (
      <LinkedAppSteps
        app={chat}
        active={active}
        onConnected={(official: AppChoice) => {
          // Cloud signs the app in; it is listed here once it reaches this
          // Worktable through Link.
          void currentConnections(
            queryClient,
            connection.mcpAuthMode === "oauth"
          ).then((connections) => {
            const agent = connections.find(
              (item) =>
                item.target.kind === "mcp-client" &&
                item.target.clientId === official.clientId
            )
            onConnected(
              setupFor(
                app,
                agent?.id ?? `link:${official.clientId}`,
                agent?.displayName ?? official.name,
                agent?.id
              )
            )
          })
        }}
      />
    )
  return (
    <>
      {chat === "claude" ? (
        // One step reads as a sentence, not a list.
        <div className="flex flex-col gap-3">
          <AddOfficialApp app="claude" />
        </div>
      ) : (
        <ol className="space-y-1">
          <OfficialAppSteps app={chat} first={1} active={active} />
        </ol>
      )}
      <CloudStatus {...props} />
    </>
  )
}

function WayPanel(props: PanelProps) {
  const { way, connection } = props
  const cloud = connection.mcpAuthMode === "oauth"
  switch (way.kind) {
    case "grok":
      return (
        <GrokBotSetupPanel
          key={props.pick}
          connection={connection}
          open={props.active}
          newAccountOnly={props.another}
          onConnected={(candidate, saved) => {
            if (!props.connected)
              props.onConnected(
                setupFor(props.app, saved.connectionId, candidate.displayName)
              )
          }}
        />
      )
    case "claude-plugin":
    case "chatgpt-app":
      return <OfficialAppPanel {...props} />
    case "pairing":
      return <PairingPanel {...props} />
    case "always-on":
      // Cloud pairs always-on agents once its gateway can route them.
      return !cloud || connection.agentPairing ? (
        <PairingPanel {...props} />
      ) : (
        <SignInPanel {...props} />
      )
    case "extension":
    case "chatgpt-local":
    case "token":
      return <TokenPanel {...props} />
    default:
      return <SignInPanel {...props} />
  }
}

/** Ways that sign in at Cloud's shared address rather than this Worktable's own. */
function usesSharedAddress(way: Way): boolean {
  return (
    way.kind === "claude-plugin" ||
    way.kind === "chatgpt-app" ||
    way.kind === "coding-plugin" ||
    way.kind === "app-plugin"
  )
}

/**
 * Where the app will work, and how it gets there. On Cloud, an app that
 * Cloud knows says which Worktable it works in, with Move Here when that's
 * another one.
 */
function Destination({
  way,
  place,
  known,
  sharedHere,
}: {
  way: Way
  place: Place
  /** Where Cloud says the app works, when it can say. */
  known: AppChoice | undefined
  sharedHere: boolean
}) {
  const workspace = useWorkspace()
  const name = workspace.data?.name
  const link =
    (way.kind === "claude-plugin" || way.kind === "chatgpt-app") && way.link
  const how =
    place === "cloud"
      ? "Through Worktable Cloud"
      : link
        ? "Through Worktable Link"
        : place === "computer"
          ? "On this computer"
          : "Connects directly"
  const elsewhere =
    known?.worktable && !known.worktable.here ? known.worktable : null
  // Off Cloud, Link sends the app here. On Cloud, a way with this
  // Worktable's own address works here, and a plugin wherever Cloud sends it.
  const worksHere = place !== "cloud" || !usesSharedAddress(way) || sharedHere
  return (
    <p className="text-xs leading-5 text-muted-foreground">
      {elsewhere ? (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>Works in {worktableLabel(elsewhere)}</span>
          {known ? <MoveHereButton app={known} /> : null}
        </span>
      ) : worksHere && name ? (
        <>
          Works in <span className="text-foreground">{name}</span>
          {/* On a phone the route takes its own line, with no dot to strand. */}
          <span className="hidden sm:inline"> · </span>
          <span className="block whitespace-nowrap sm:inline">{how}</span>
        </>
      ) : (
        how
      )}
    </p>
  )
}

function OtherWays({
  ways,
  render,
}: {
  ways: Way[]
  render: (way: Way) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  if (!ways.length) return null
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mt-4 border-t border-border pt-3"
    >
      <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
        Other Ways
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 transition-transform motion-reduce:transition-none",
            open && "rotate-90"
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-5 pt-3">
          {ways.map((way) => (
            <section key={way.kind} aria-label={WAY_NAME[way.kind]}>
              <h4 className="mb-2 text-sm font-medium text-foreground">
                {WAY_NAME[way.kind]}
              </h4>
              {render(way)}
            </section>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** An app's mark; Other is any MCP agent, so it gets a plug. */
function AppMark({ app, className }: { app: AgentApp; className: string }) {
  if (app.id === "other")
    return (
      <span
        aria-hidden
        className={cn(
          "grid place-items-center rounded-lg bg-surface-tint text-muted-foreground",
          className
        )}
      >
        <Plug className="size-1/2" />
      </span>
    )
  return (
    <AgentAvatar
      name={app.name}
      platform={app.platform}
      className={cn("rounded-lg", className)}
    />
  )
}

function AppTile({
  app,
  connected,
  compact,
  onSelect,
}: {
  app: AgentApp
  connected: boolean
  compact: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex rounded-xl card-surface-interactive card-surface text-foreground transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        compact
          ? "min-h-11 items-center gap-2.5 px-3 py-2 text-left text-sm"
          : "min-h-20 flex-col items-center justify-center gap-2 px-1 py-3 text-center text-xs leading-tight"
      )}
    >
      <span aria-hidden className="relative">
        <AppMark app={app} className={compact ? "size-6" : "size-7"} />
        {connected ? (
          <ConnectedMark className="absolute -right-1 -bottom-1 size-3.5 ring-2 ring-card" />
        ) : null}
      </span>
      <span className={compact ? "min-w-0 truncate" : undefined}>
        {app.name}
      </span>
    </button>
  )
}

/**
 * The agent that just connected, set up where it connected: its name, what
 * it may do, and auto-reply where the app has it. The same changes as Edit
 * in Settings, saved as they are made.
 */
function ConnectedPanel({
  setup,
  cloud,
  active,
  onRenamed,
}: {
  setup: SetupRecord
  cloud: boolean
  active: boolean
  onRenamed: (name: string) => void
}) {
  const queryClient = useQueryClient()
  const list = useQuery({ ...connectionsQuery(cloud), enabled: active })
  const connection = list.data?.connections.find(
    (item) => item.id === setup.connectionId
  )
  const app = useConnectionApp(connection, active)
  const [name, setName] = useState(setup.name)
  const [access, setAccess] = useState<AgentAccess | null>(null)
  const shownAccess = access ?? connection?.access ?? null
  const save = useMutation({
    mutationFn: (changes: { name: string; access: AgentAccess | null }) =>
      saveAgentChanges(connection!, {
        name: changes.name,
        icon: connection!.icon ?? null,
        access: changes.access,
      }),
    onSuccess: (_result, changes) => {
      if (changes.name !== setup.name) onRenamed(changes.name)
      void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
      void queryClient.invalidateQueries({ queryKey: ["tokens"] })
      void queryClient.invalidateQueries({ queryKey: threadQueryKeys.root })
    },
    onError: (error) => {
      setAccess(null)
      toast.error(
        error instanceof Error ? error.message : "Couldn’t save the agent."
      )
    },
  })
  // Only a token made here or a sign-in with access is changed here; Cloud
  // holds a Link sign-in.
  const editable =
    connection !== undefined &&
    (connection.authKind === "local-token" ||
      (connection.authKind === "oauth" && connection.access != null))
  const saveName = () => {
    const trimmed = name.trim()
    if (!connection || !trimmed || trimmed.length > 100)
      return setName(setup.name)
    if (trimmed !== connection.displayName)
      save.mutate({ name: trimmed, access: shownAccess })
  }

  return (
    <div className="flex flex-col gap-5">
      {editable ? (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`agent-name-${setup.id}`}
            className="text-sm font-medium text-foreground"
          >
            Name
          </label>
          <Input
            id={`agent-name-${setup.id}`}
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            onBlur={saveName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur()
            }}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground">Name</span>
          <span className="text-sm text-foreground/80">
            {connection?.displayName ?? setup.name}
          </span>
        </div>
      )}
      {editable && shownAccess ? (
        <AgentAccessFields
          value={shownAccess}
          alwaysOn={connection.mode === "always-on"}
          disabled={save.isPending}
          onChange={(next) => {
            setAccess(next)
            save.mutate({
              name: name.trim() || connection.displayName,
              access: next,
            })
          }}
        />
      ) : null}
      {connection?.autoReply ? (
        <AutoReplySetting
          connection={connection}
          elsewhere={worksElsewhere(app)}
        />
      ) : null}
      {connection?.link ? (
        <div>
          <ExternalButton href={connection.link.manageUrl}>
            Manage in Cloud
          </ExternalButton>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The chosen app's setup: where it works, its one best way and the others,
 * then, once it connects, the agent itself.
 */
function SetupCard({
  app,
  info,
  place,
  connected,
  active,
  onChange,
  onDone,
  panelFor,
  onRenamed,
}: {
  app: AgentApp
  info: ConnectionInfo
  place: Place
  connected: SetupRecord | undefined
  active: boolean
  onChange: () => void
  onDone?: () => void
  panelFor: (way: Way, place: Place, primary?: boolean) => PanelProps
  onRenamed: (setup: SetupRecord, name: string) => void
}) {
  const cloud = info.mcpAuthMode === "oauth"
  const family = FAMILY[app.id]
  // Cloud says where its apps work; off Cloud it does only through Link.
  const asked =
    cloud ||
    ((app.id === "claude" || app.id === "chatgpt") && place !== "cloud")
  const choices = useAppChoices(active && asked && family !== undefined)
  const known = family ? appOfFamily(choices.data, family) : undefined
  const sharedHere = known?.worktable
    ? known.worktable.here
    : sharedAddressLandsHere(info.remoteMcpUrl)
  const ways = waysFor(app.id, { place, sharedHere })
  if (!ways) return null
  // Grok Bot keeps its own steps after it connects: the reply test follows.
  const settled = connected && ways.best.kind !== "grok"
  return (
    <section
      aria-label={`Connect ${app.name}`}
      className="rounded-xl card-surface p-4 sm:p-5"
    >
      <header className="mb-4 flex items-center gap-3">
        <AppMark app={app} className="size-8" />
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            {app.id === "other" ? "Other agents" : app.name}
            {settled ? (
              <span role="img" aria-label="Connected">
                <ConnectedMark />
              </span>
            ) : null}
          </h3>
          <Destination
            way={ways.best}
            place={place}
            known={known}
            sharedHere={sharedHere}
          />
        </div>
        {/* Once connected, Done brings the apps back where there is one. */}
        {settled && onDone ? null : (
          <Button variant="ghost" size="sm" onClick={onChange}>
            Change
          </Button>
        )}
      </header>
      {settled ? (
        <>
          <ConnectedPanel
            key={connected.id}
            setup={connected}
            cloud={cloud}
            active={active}
            onRenamed={(name) => onRenamed(connected, name)}
          />
          {/* Signing in can finish before the skills command was run. */}
          {ways.best.kind === "address" && ways.best.skills.via === "url" ? (
            <div className="mt-5">
              <Instruction>Run this for Worktable’s skills.</Instruction>
              <CommandBlock value={skillsCommand(ways.best.skills.target)} />
            </div>
          ) : null}
          {onDone ? (
            <div className="mt-5 flex justify-end">
              <Button onClick={onDone}>Done</Button>
            </div>
          ) : null}
        </>
      ) : (
        <div key={app.id}>
          <WayPanel {...panelFor(ways.best, place)} />
          <OtherWays
            ways={ways.others}
            render={(way) => <WayPanel {...panelFor(way, place, false)} />}
          />
        </div>
      )}
    </section>
  )
}

/**
 * Changes the agents set up here from the list as it is when the change
 * lands, so a late answer, like a rename saved after Done, never brings back
 * a setup that was cleared since.
 */
export type SetupsUpdate = (
  update: (current: SetupRecord[]) => SetupRecord[]
) => void

/**
 * An agent a card made before it connected, such as one whose token isn't
 * used yet. Like a setup, it joins the agent list when its card is done.
 */
export interface PendingAgent {
  source: string
  connectionId: string
}

export type PendingUpdate = (
  update: (current: PendingAgent[]) => PendingAgent[]
) => void

/**
 * Pick the app, then its one best setup for this Worktable. The apps fold
 * away into the setup's header, which changes the app. Each setup shows the
 * real command or address and waits for the agent; the other ways stay under
 * Other Ways. Once the agent connects, the same card names it and sets what
 * it may do.
 */
export function AgentConnectOptions({
  setups,
  onSetupsChange,
  onPendingChange,
  active = true,
  compact = false,
  done = false,
}: {
  setups: SetupRecord[]
  onSetupsChange: SetupsUpdate
  /** For a page that lists agents, which leaves these out until Done. */
  onPendingChange?: PendingUpdate
  /** Whether the surface is showing. */
  active?: boolean
  /** Row-sized app choices, for a page with other settings around them. */
  compact?: boolean
  /** A connected app's card ends with Done, which brings the apps back for another. */
  done?: boolean
}) {
  const [selected, setSelected] = useState<AppId | null>(null)
  const [pick, setPick] = useState(0)
  // The card keeps its app while it folds away.
  const [shown, setShown] = useState<AppId | null>(null)
  if (selected && selected !== shown) setShown(selected)
  // Cloud agents already signed in when this step loaded aren't new. Each
  // app matches its own platform, so one that connects while another app is
  // on show still counts when it's chosen.
  const [baseline, setBaseline] = useState<Set<string> | null>(null)
  const [pairings, setPairings] = useState<Record<string, PairingCreated>>({})
  const [tokens, setTokens] = useState<Record<string, MadeToken>>({})
  const connection = useQuery({
    queryKey: ["system", "connection"],
    queryFn: getConnection,
    staleTime: 30_000,
    enabled: active,
  })
  const cloud = connection.data?.mcpAuthMode === "oauth"
  const source = selected ? `app:${selected}` : null
  // On Cloud, agents sign in on their own; nothing tells this page, so it
  // looks while the chosen app hasn't connected yet.
  const waiting =
    source !== null &&
    selected !== "grok-bot" &&
    !setups.some((setup) => setup.source === source)
  const connections = useQuery({
    queryKey: ["agent-connections", Boolean(cloud)],
    queryFn: () => listAgentConnections({ workspaceAgentsOnCloud: cloud }),
    enabled: active && cloud,
    refetchInterval: active && cloud && waiting ? 3_000 : false,
  })

  const loaded = connections.data?.connections
  // A list cached from an earlier visit may predate agents signed in since.
  if (loaded && connections.isFetchedAfterMount && !baseline)
    setBaseline(new Set(loaded.map((item) => item.id)))

  if (connection.isPending || (cloud && connections.isPending)) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (connection.isError || (cloud && connections.isError)) {
    return (
      <Callout variant="danger">
        Couldn’t read the connection details.{" "}
        <button
          type="button"
          className="font-medium underline underline-offset-2"
          onClick={() => {
            void connection.refetch()
            void connections.refetch()
          }}
        >
          Try again
        </button>
      </Callout>
    )
  }

  const info = connection.data!
  const place = placeOf(info, thisPage())
  const apps = appsFor(place)
  const app = apps.find((item) => item.id === selected) ?? null
  const card = apps.find((item) => item.id === shown) ?? null
  const setupOf = (item: AgentApp) =>
    setups.find((setup) => setup.source === sourceOf(item))
  const cardActive = active && app !== null

  const panelFor = (way: Way, where: Place, primary = true): PanelProps => ({
    app: card!,
    way,
    place: where,
    connection: info,
    connected: setupOf(card!),
    onConnected: (setup) =>
      onSetupsChange((current) => [
        ...current.filter((item) => item.id !== setup.id),
        setup,
      ]),
    onPending: (connectionId) =>
      onPendingChange?.((current) =>
        current.some((item) => item.connectionId === connectionId)
          ? current
          : [...current, { source: sourceOf(card!), connectionId }]
      ),
    pairings,
    onPairing: (key, pairing) =>
      setPairings((current) => {
        const next = { ...current }
        if (pairing) next[key] = pairing
        else delete next[key]
        return next
      }),
    tokens,
    onToken: (key, token) =>
      setTokens((current) => ({ ...current, [key]: token })),
    // An agent one app accepted isn't another app's arrival.
    cloudConnections: baseline
      ? loaded?.filter((item) => !setups.some((setup) => setup.id === item.id))
      : undefined,
    baseline: baseline ?? new Set<string>(),
    another: done,
    pick,
    active: cardActive,
    primary,
  })

  return (
    <div className="flex flex-col">
      <Collapsible open={app === null}>
        <CollapsibleContent>
          <div
            role="group"
            aria-label="Apps"
            className={cn(
              "grid gap-2",
              compact ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-4"
            )}
          >
            {apps.map((item) => (
              <AppTile
                key={item.id}
                app={item}
                connected={setupOf(item) !== undefined}
                compact={compact}
                onSelect={() => {
                  setSelected(item.id)
                  setPick((count) => count + 1)
                }}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
      <Collapsible open={app !== null}>
        <CollapsibleContent>
          {card ? (
            <SetupCard
              key={card.id}
              app={card}
              info={info}
              place={place}
              connected={setupOf(card)}
              active={cardActive}
              onChange={() => setSelected(null)}
              onDone={
                done
                  ? () => {
                      // Picking the app again connects another one.
                      const prefix = `${card.id}:`
                      const unused = <T,>(current: Record<string, T>) =>
                        Object.fromEntries(
                          Object.entries(current).filter(
                            ([key]) => !key.startsWith(prefix)
                          )
                        )
                      setPairings(unused)
                      setTokens(unused)
                      // The agent that just connected is no longer new: the
                      // next pick waits for another one.
                      const finished = setups.flatMap((setup) =>
                        setup.source === sourceOf(card) && setup.connectionId
                          ? [setup.connectionId]
                          : []
                      )
                      if (finished.length)
                        setBaseline(
                          (current) =>
                            new Set([...(current ?? []), ...finished])
                        )
                      onSetupsChange((current) =>
                        current.filter(
                          (setup) => setup.source !== sourceOf(card)
                        )
                      )
                      // An agent another card found first is finished here too.
                      onPendingChange?.((current) =>
                        current.filter(
                          (item) =>
                            item.source !== sourceOf(card) &&
                            !finished.includes(item.connectionId)
                        )
                      )
                      setSelected(null)
                      // Gone at once: folding it would set the app up again.
                      setShown(null)
                    }
                  : undefined
              }
              panelFor={panelFor}
              onRenamed={(setup, name) =>
                onSetupsChange((current) =>
                  current.map((item) =>
                    item.id === setup.id ? { ...item, name } : item
                  )
                )
              }
            />
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export function ConnectAgentStep({
  setups,
  onSetupsChange,
  onContinue,
  onBack,
}: {
  setups: SetupRecord[]
  onSetupsChange: SetupsUpdate
  onContinue: () => void
  onBack?: () => void
}) {
  return (
    <>
      <StepHeading
        title="Connect your agent"
        description="Pick the app you use most. You can add more later."
      />
      <div className="mt-7">
        <AgentConnectOptions setups={setups} onSetupsChange={onSetupsChange} />
      </div>
      {setups.some((entry) => entry.verified) ? (
        <section
          aria-label="Agent rules"
          className="mt-6 space-y-3 border-t border-border pt-5"
        >
          <div>
            <h2 className="text-sm font-medium">
              Add Worktable to your agent’s rules
            </h2>
            <p className="text-xs text-muted-foreground">
              So your agents save here without being asked.
            </p>
          </div>
          <AgentInstructions
            actionVariant="outline"
            platforms={setups
              .filter((entry) => entry.verified)
              .map((entry) => entry.platform ?? "other")}
          />
        </section>
      ) : null}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {setups.length ? null : (
            <Button variant="ghost" onClick={onContinue}>
              Skip for now
            </Button>
          )}
          <Button disabled={!setups.length} onClick={onContinue}>
            Continue
          </Button>
        </div>
      </div>
    </>
  )
}
