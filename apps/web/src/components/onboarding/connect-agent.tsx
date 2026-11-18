import { AgentInstructions } from "@/components/agent-instructions"
import {
  APP_STEPS,
  CODING_PLUGIN_STEPS,
  GEMINI_SKILL_DOWNLOAD,
  appValue,
  appsFor,
  claudeConnectorLink,
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronRight, Loader2 } from "lucide-react"
import {
  AGENT_PLATFORMS,
  agentConnectionOnCodexHost,
  DEFAULT_AGENT_ACCESS,
  platformForClient,
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
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { cn } from "@worktable/ui/lib/utils"

import { AgentAvatar } from "@/components/agents/agent-avatar"
import {
  AddOfficialApp,
  LinkedAppSteps,
  OfficialAppSteps,
} from "@/components/agents/chat-app-ways"
import { GrokBotSetupPanel } from "@/components/agents/grok-bot-setup"
import { MoveHereButton } from "@/components/agents/works-in"
import {
  agentConnectionPlatform,
  connectAgentApp,
  getAppAgent,
  listAgentConnections,
  saveAgentChanges,
} from "@/lib/agent-connections-api"
import {
  cloudConnectorCommand,
  HERMES,
  OPENCLAW,
  type AlwaysOnAgent,
} from "@/lib/always-on-agents"
import {
  appOfFamily,
  useAppChoices,
  worktableLabel,
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
  address: "Connector",
  "claude-connector": "Connector",
  "cloud-command": "Connect Command",
  pairing: "Connect Command",
  "always-on": "Plugin",
  grok: "Grok Bot",
  extension: "Desktop Extension",
  "chatgpt-local": "Local Chats",
  token: "Access Token",
}

function shellLines(lines: Array<string | null | false>): string {
  return lines.filter(Boolean).join("\n")
}

function CommandBlock({
  value,
  pending = false,
}: {
  value: string
  /** Shown in its final shape while the real value is on its way. */
  pending?: boolean
}) {
  const copy = useCopy()
  return (
    <div className="relative rounded-xl border border-border bg-surface-inset py-2.5 pr-20 pl-3">
      <code
        className={cn(
          "block font-mono text-xs leading-5 break-all whitespace-pre-wrap transition-colors duration-200",
          pending ? "text-muted-foreground" : "text-foreground"
        )}
      >
        {value}
      </code>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        className="absolute top-1.5 right-1.5 h-7 px-2.5 text-xs"
        onClick={() => void copy.copy(value)}
      >
        {copy.copied ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

function Instruction({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-sm leading-6 text-foreground/80">{children}</p>
}

function StatusLine({
  connected,
  waiting,
  children,
}: {
  connected?: boolean
  waiting?: boolean
  children: ReactNode
}) {
  return (
    <p
      role="status"
      className={cn(
        "mt-3 flex min-h-5 items-center gap-2 text-sm",
        connected ? "text-foreground" : "text-muted-foreground"
      )}
    >
      {connected ? (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-success text-background">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
      ) : waiting ? (
        <span
          aria-hidden
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-warning"
        />
      ) : null}
      <span>{children}</span>
    </p>
  )
}

function connectedLine(name: string, alwaysOn: boolean): string {
  return alwaysOn
    ? `${name} is connected. Ask it for work in Threads.`
    : `${name} is connected.`
}

function OpenLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      {children}
    </a>
  )
}

interface PanelProps {
  app: AgentApp
  way: Way
  connection: ConnectionInfo
  /** The agent this app already connected, if it did. */
  connected: SetupRecord | undefined
  onConnected: (setup: SetupRecord) => void
  /** Pairings made here, kept per way so switching back reuses one. */
  pairings: Record<string, PairingCreated>
  onPairing: (key: string, pairing: PairingCreated | null) => void
  /** Agents already signed in to Cloud when this step opened. */
  baseline: Set<string>
  cloudConnections: AgentConnection[] | undefined
  /** Whether the surface is showing. */
  active: boolean
  /** The best way waits for the agent; the others only show how. */
  primary: boolean
}

function sourceOf(app: AgentApp): string {
  return `app:${app.id}`
}

function setupFor(app: AgentApp, id: string, name: string): SetupRecord {
  return {
    id,
    name,
    harness: app.id === "other" ? "MCP agent" : app.name,
    mode: app.alwaysOn ? "always-on" : "on-demand",
    verified: true,
    platform: app.platform,
    source: sourceOf(app),
  }
}

/** What the agent is called until its owner renames it. */
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
 * Coding agents get Worktable's skills from the same paste.
 */
function PairingPanel({
  app,
  way,
  connection,
  connected,
  onConnected,
  pairings,
  onPairing,
}: PanelProps) {
  const queryClient = useQueryClient()
  const key = `${app.id}:${way.kind}`
  const pairing = pairings[key]
  const name = agentName(app)
  const agent = way.kind === "always-on" ? ALWAYS_ON[way.adapter] : null
  const client = way.kind === "pairing" ? way.client : null
  const create = useMutation({
    mutationFn: () =>
      agent
        ? createPairing({
            target: {
              kind: "agent-adapter",
              adapter: agent.adapter,
              participantName: name,
            },
            access: DEFAULT_AGENT_ACCESS,
          })
        : createPairing({
            client,
            displayName: name,
            access: DEFAULT_AGENT_ACCESS,
          }),
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
    enabled: Boolean(pairing) && !connected,
    refetchInterval: (query) =>
      shouldPollPairing(query.state.data) ? 2_000 : false,
  })
  const session = status.data
  useEffect(() => {
    if (session?.status !== "verified" || !pairing || connected) return
    onConnected(setupFor(app, `pairing:${pairing.id}`, name))
    void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
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
    : shellLines([
        `curl -fsSL ${pairing ? new URL("/connect.sh", pairing.mcpUrl).href : `${origin}/connect.sh`} | sh -s -- ${code}${client ? ` --client ${client}` : ""}`,
        way.kind === "pairing" && way.skills && skillsCommand(way.skills),
      ])
  const ended = session?.status === "expired" || session?.status === "failed"
  const failure = session ? latestPairingFailure(session) : null

  return (
    <>
      <Instruction>
        {agent
          ? `Run this where ${agent.name} runs.`
          : client
            ? "Run this in your terminal."
            : "Run this in your terminal. It adds Worktable to the agents it finds, such as OpenCode and VS Code."}
      </Instruction>
      <CommandBlock value={command} pending={!pairing} />
      {connected ? (
        <StatusLine connected>
          {connectedLine(connected.name, connected.mode === "always-on")}
        </StatusLine>
      ) : create.isError ? (
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
            onClick={() => {
              requested.current = false
              onPairing(key, null)
              create.reset()
            }}
          >
            Make a new command
          </button>
        </Callout>
      ) : (
        <StatusLine waiting>Waiting for {waitingFor(app)}</StatusLine>
      )}
    </>
  )
}

/** The token's id, from its `wt_<id>_<secret>` form. */
function tokenId(token: string): string | null {
  return /^wt_([0-9a-f]{12})_/.exec(token)?.[1] ?? null
}

function tokenSteps(kind: Way["kind"], needsToken: boolean): string[] | null {
  const paste = needsToken
    ? "paste this address and an access token"
    : "paste this address"
  if (kind === "extension")
    return [
      "Download the extension and open it in Claude Desktop.",
      `Approve it, ${paste}, then restart Claude.`,
    ]
  if (kind === "chatgpt-local")
    return [
      "In ChatGPT, open Settings, then MCP servers.",
      `Add Worktable with Streamable HTTP and ${paste}.`,
    ]
  return null
}

/**
 * Apps and other MCP agents on a computer or server connect with this
 * Worktable's address and an access token made here.
 */
function TokenPanel({ app, way, connection, connected, onConnected }: PanelProps) {
  const queryClient = useQueryClient()
  const [token, setToken] = useState<{ value: string; id: string } | null>(null)
  const label = TOKEN_LABEL[way.kind] ?? null
  const { endpoint, needsToken } = desktopAgentConnectionDetails(connection)
  // An app connected before is the same agent: keep its name and access.
  const existing = useQuery({
    queryKey: ["agent-connections", "app", label],
    queryFn: () => getAppAgent(label!),
    enabled: Boolean(label),
  })
  const name =
    existing.data?.connection?.displayName ??
    (label ? AGENT_PLATFORMS[platformForClient(label)].name : agentName(app))
  const mint = useMutation({
    mutationFn: async () =>
      (
        await connectAgentApp({
          client: label,
          displayName: name,
          access: existing.data?.connection?.access ?? DEFAULT_AGENT_ACCESS,
        })
      ).token,
    onSuccess: (value) => {
      const id = tokenId(value)
      if (id) setToken({ value, id })
      void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    },
  })
  const tokens = useQuery({
    queryKey: ["tokens"],
    queryFn: listTokens,
    enabled: Boolean(token) && !connected,
    refetchInterval: token && !connected ? 3_000 : false,
  })
  const used = Boolean(
    token && tokens.data?.find((item) => item.id === token.id)?.lastUsedAt
  )
  useEffect(() => {
    if (!used || !token || connected) return
    onConnected(setupFor(app, `token:${token.id}`, name))
    // Only the first use adds the agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [used, token?.id])

  const steps = tokenSteps(way.kind, needsToken)
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
          Add Worktable to your agent as an MCP server with this address
          {needsToken ? " and an access token" : ""}.
        </Instruction>
      )}
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
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Download
          </a>
        ) : null}
        {token || connected || !needsToken ? null : (
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
      {connected ? (
        <StatusLine connected>
          {connectedLine(connected.name, connected.mode === "always-on")}
        </StatusLine>
      ) : mint.isError || existing.isError ? (
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
function signedInHere(app: AgentApp, way: Way, connection: AgentConnection): boolean {
  if (way.kind === "always-on" && ALWAYS_ON[way.adapter].cloudAuth === "approval") {
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
    // These apps sign in under names we may not know yet.
    (way.kind === "app-plugin" && platform === "other") ||
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
        step: "On Claude’s Free plan, add Worktable as a connector. Skills need the plugin.",
        value: url,
        open: { label: "Add Connector", href: claudeConnectorLink(url) },
      }
    case "address":
      return {
        step:
          app.id === "gemini"
            ? "In Gemini, open Customize, then Connectors, and choose Custom. Paste this address and sign in."
            : "Add this address as a custom connector or MCP server, then sign in.",
        value: url,
      }
    case "cloud-command":
      return {
        step:
          way.client === "cursor"
            ? "Run this in your terminal, then open Cursor and sign in."
            : way.client
              ? "Run this in your terminal, then choose Allow access when your browser opens."
              : "Run this in your terminal and sign in when asked. It adds Worktable to the agents it finds, such as OpenCode and VS Code.",
        value: cloudConnectorCommand(url, way.client ?? "auto"),
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
      onConnected(setupFor(app, selected.id, selected.displayName)),
  })
  const accepted = useRef<string | null>(null)
  useEffect(() => {
    if (!arrived || connected || accepted.current === arrived.id) return
    accepted.current = arrived.id
    accept.mutate(arrived)
  }, [arrived, connected, accept])
  return { arrived, accept }
}

function CloudStatus(props: PanelProps) {
  const { app, connected } = props
  const { arrived, accept } = useCloudArrival(props)
  if (connected)
    return (
      <StatusLine connected>
        {connectedLine(connected.name, connected.mode === "always-on")}
      </StatusLine>
    )
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
  return (
    <>
      <Instruction>{step}{props.connected ? null : " Then return to Worktable."}</Instruction>
      <CommandBlock value={value} />
      {open ? (
        <div className="mt-3">
          <OpenLink href={open.href}>{open.label}</OpenLink>
        </div>
      ) : null}
      {way.kind === "address" && app.id === "gemini" ? (
        <p className="mt-3 text-sm text-muted-foreground">
          For skills, upload the{" "}
          <a
            href={GEMINI_SKILL_DOWNLOAD}
            className="font-medium text-primary-text hover:underline"
          >
            Worktable skill
          </a>{" "}
          in Gemini.
        </p>
      ) : null}
      {props.primary ? <CloudStatus {...props} /> : null}
    </>
  )
}

/** Claude and ChatGPT add their official Worktable plugin or app. */
function OfficialAppPanel(props: PanelProps) {
  const { way, active } = props
  if (way.kind !== "claude-plugin" && way.kind !== "chatgpt-app") return null
  const chat = way.kind === "claude-plugin" ? "claude" : "chatgpt"
  if (way.link) return <LinkedAppSteps app={chat} active={active} />
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
          connection={connection}
          open={props.active}
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

/**
 * Where the app will work, and how it gets there. On Cloud, an app that
 * Cloud knows says which Worktable it works in, with Move Here when that's
 * another one.
 */
function Destination({
  app,
  way,
  place,
  connection,
  active,
}: {
  app: AgentApp
  way: Way
  place: Place
  connection: ConnectionInfo
  active: boolean
}) {
  const workspace = useWorkspace()
  const family = FAMILY[app.id]
  const viaCloud =
    place === "cloud" ||
    ((way.kind === "claude-plugin" || way.kind === "chatgpt-app") && way.link)
  const choices = useAppChoices(active && viaCloud && family !== undefined)
  const known = family ? appOfFamily(choices.data, family) : undefined
  const name = workspace.data?.name
  // The plugins use Cloud's shared address; the others use this Worktable's own.
  const shared =
    way.kind === "claude-plugin" ||
    way.kind === "chatgpt-app" ||
    way.kind === "coding-plugin" ||
    way.kind === "app-plugin"
  const how =
    place === "cloud"
      ? "Through Worktable Cloud"
      : viaCloud
        ? "Through Worktable Link"
        : place === "computer"
          ? "On this computer"
          : "Connects directly"
  const elsewhere = known?.worktable && !known.worktable.here ? known.worktable : null
  const worksHere =
    known?.worktable?.here === true ||
    place !== "cloud" ||
    !shared ||
    sharedAddressLandsHere(connection.remoteMcpUrl)
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      {elsewhere ? (
        <>
          <span>Works in {worktableLabel(elsewhere)}</span>
          {known ? <MoveHereButton app={known} /> : null}
        </>
      ) : (
        <>
          {worksHere && name ? (
            <span>
              Works in <span className="text-foreground">{name}</span>
            </span>
          ) : null}
          {worksHere && name ? <span aria-hidden>·</span> : null}
          <span>{how}</span>
        </>
      )}
    </span>
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
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4 border-t border-border pt-3">
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

function AppTile({
  app,
  selected,
  connected,
  onSelect,
}: {
  app: AgentApp | null
  selected: boolean
  connected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl px-1 py-3 text-center text-xs leading-tight text-foreground transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        selected
          ? "border border-primary bg-surface-selected"
          : "card-surface card-surface-interactive"
      )}
    >
      <span className="relative">
        {app ? (
          <AgentAvatar
            name={app.name}
            platform={app.id === "other" ? undefined : app.platform}
            className="size-7 rounded-lg"
          />
        ) : (
          <span className="grid size-7 place-items-center rounded-lg bg-surface-tint text-muted-foreground">
            ···
          </span>
        )}
        {connected ? (
          <span className="absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-full bg-success text-background ring-2 ring-card">
            <Check className="size-2" strokeWidth={3.5} aria-hidden />
          </span>
        ) : null}
      </span>
      <span>{app ? app.name : "More"}</span>
    </button>
  )
}

/**
 * Pick the app, then its one best setup for this Worktable. Each setup shows
 * the real command or address and waits for the agent; the other ways stay
 * under Other Ways.
 */
export function AgentConnectOptions({
  setups,
  onSetupsChange,
  active = true,
}: {
  setups: SetupRecord[]
  onSetupsChange: (setups: SetupRecord[]) => void
  /** Whether the surface is showing. */
  active?: boolean
}) {
  const [selected, setSelected] = useState<AppId | null>(null)
  const [more, setMore] = useState(false)
  // Cloud agents already signed in when this step loaded aren't new. Each
  // app matches its own platform, so one that connects while another app is
  // on show still counts when it's chosen.
  const [baseline, setBaseline] = useState<Set<string> | null>(null)
  const [pairings, setPairings] = useState<Record<string, PairingCreated>>({})
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
  const place = placeOf(info)
  const apps = appsFor(place)
  const app = apps.find((item) => item.id === selected) ?? null
  const showAll = more || (app !== null && !app.featured)
  const shown = showAll ? apps : apps.filter((item) => item.featured)
  const connectedApp = (item: AgentApp) =>
    setups.some((setup) => setup.source === sourceOf(item))

  const panelFor = (way: Way, primary = true): PanelProps | null =>
    app
      ? {
          app,
          way,
          connection: info,
          connected: setups.find((setup) => setup.source === sourceOf(app)),
          onConnected: (setup) =>
            onSetupsChange([
              ...setups.filter((item) => item.id !== setup.id),
              setup,
            ]),
          pairings,
          onPairing: (key, pairing) =>
            setPairings((current) => {
              const next = { ...current }
              if (pairing) next[key] = pairing
              else delete next[key]
              return next
            }),
          // An agent one app accepted isn't another app's arrival.
          cloudConnections: baseline
            ? loaded?.filter(
                (item) => !setups.some((setup) => setup.id === item.id)
              )
            : undefined,
          baseline: baseline ?? new Set<string>(),
          active,
          primary,
        }
      : null
  const ways = app ? waysFor(app.id, place) : null

  return (
    <div className="flex flex-col gap-4">
      <div
        role="group"
        aria-label="Apps"
        className="grid grid-cols-4 gap-2"
      >
        {shown.map((item) => (
          <AppTile
            key={item.id}
            app={item}
            selected={item.id === selected}
            connected={connectedApp(item)}
            onSelect={() => setSelected(item.id === selected ? null : item.id)}
          />
        ))}
        {showAll ? null : (
          <AppTile
            app={null}
            selected={false}
            connected={false}
            onSelect={() => setMore(true)}
          />
        )}
      </div>
      {app && ways ? (
        <section
          aria-label={`Connect ${app.name}`}
          className="rounded-xl card-surface p-4 sm:p-5"
        >
          <header className="mb-4 flex items-center gap-3">
            <AgentAvatar
              name={app.name}
              platform={app.id === "other" ? undefined : app.platform}
              className="size-8 rounded-lg"
            />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-foreground">
                {app.id === "other" ? "Other agents" : app.name}
              </h3>
              <Destination
                app={app}
                way={ways.best}
                place={place}
                connection={info}
                active={active}
              />
            </div>
          </header>
          <div key={app.id}>
            <WayPanel {...panelFor(ways.best)!} />
            <OtherWays
              ways={ways.others}
              render={(way) => <WayPanel {...panelFor(way, false)!} />}
            />
          </div>
        </section>
      ) : null}
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
  onSetupsChange: (setups: SetupRecord[]) => void
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
        <section aria-label="Agent rules" className="mt-6 space-y-3 border-t border-border pt-5">
          <div>
            <h2 className="text-sm font-medium">Add Worktable to your agent’s rules</h2>
            <p className="text-xs text-muted-foreground">So your agents save here without being asked.</p>
          </div>
          <AgentInstructions actionVariant="outline" platforms={setups.filter((entry) => entry.verified).map((entry) => entry.platform ?? "other")} />
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
