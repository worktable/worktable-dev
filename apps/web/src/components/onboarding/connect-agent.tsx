import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Loader2 } from "lucide-react"
import {
  AGENT_PLATFORMS,
  DEFAULT_AGENT_ACCESS,
  type AgentConnection,
  type AgentPlatformId,
  type ConnectorInstallableMcpClientId,
  type DirectAgentLabel,
} from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { cn } from "@worktable/ui/lib/utils"

import {
  AGENT_SETUP_CATEGORIES,
  AgentSetupCategory,
  AgentSetupTabs,
} from "@/components/agents/agent-setup-category"
import { ChatAppWays } from "@/components/agents/chat-app-ways"
import { GrokBotSetupPanel } from "@/components/agents/grok-bot-setup"
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
import { desktopAgentConnectionDetails } from "@/lib/desktop-agent-connection"
import type { SetupRecord } from "@/lib/onboarding-setups"
import {
  createPairing,
  getPairing,
  latestPairingFailure,
  shouldPollPairing,
  type PairingCreated,
} from "@/lib/pairing-api"
import { getConnection, type ConnectionInfo } from "@/lib/system-api"
import { listTokens } from "@/lib/tokens-api"
import { StepHeading } from "./onboarding-shared"

type RowId = "code" | "chat" | "always" | "mcp"

/** One way to connect, shown as a tab in its row. */
type Option =
  | { kind: "cli"; tab: string; client: ConnectorInstallableMcpClientId | null }
  | { kind: "chat"; tab: string; app: "claude" | "chatgpt" }
  | { kind: "always-on"; tab: string; agent: AlwaysOnAgent }
  | { kind: "mcp"; tab: string }
  | { kind: "grok"; tab: string }

interface Row {
  id: RowId
  title: string
  description: string
  platforms: AgentPlatformId[]
  options: Option[]
}

const ON_DEMAND: Row[] = [
  {
    id: "code",
    ...AGENT_SETUP_CATEGORIES.code,
    options: [
      { kind: "cli", tab: "Claude Code", client: "claude-code" },
      { kind: "cli", tab: "Codex", client: "codex" },
      { kind: "cli", tab: "Cursor", client: "cursor" },
      { kind: "cli", tab: "Other", client: null },
    ],
  },
  {
    id: "chat",
    ...AGENT_SETUP_CATEGORIES.chat,
    options: [
      { kind: "chat", tab: "Claude", app: "claude" },
      { kind: "chat", tab: "ChatGPT", app: "chatgpt" },
    ],
  },
]

const ALWAYS_ON: Row = {
  id: "always",
  ...AGENT_SETUP_CATEGORIES.always,
  options: [
    { kind: "always-on", tab: "OpenClaw", agent: OPENCLAW },
    { kind: "always-on", tab: "Hermes", agent: HERMES },
    { kind: "grok", tab: "Grok Bot" },
  ],
}

const ANY_MCP: Option = { kind: "mcp", tab: "Other" }

/** Labels an app's credential carries, so the agent shows its platform. */
const CHAT_LABELS = {
  claude: "claude-desktop",
  chatgpt: "chatgpt-desktop",
} as const satisfies Record<string, DirectAgentLabel>

/** What the agent is called until its owner renames it. */
function agentName(option: Option): string {
  switch (option.kind) {
    case "cli":
      return option.client
        ? AGENT_PLATFORMS[option.client].name
        : "Agents on my computer"
    case "chat":
      return AGENT_PLATFORMS[option.app].name
    case "always-on":
      return option.agent.name
    case "grok":
      return "Grok Bot"
    case "mcp":
      return "My agent"
  }
}

/** How the waiting line names it. */
function waitingFor(option: Option): string {
  return option.tab === "Other" ? "your agent" : option.tab
}

function platformOf(option: Option): AgentPlatformId {
  switch (option.kind) {
    case "cli":
      return option.client ?? "other"
    case "chat":
      return option.app
    case "always-on":
      return option.agent.adapter
    case "grok":
      return "grok-bot"
    case "mcp":
      return "other"
  }
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

function Instruction({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-sm leading-6 text-foreground/80">{children}</p>
}

function StatusLine({
  connected,
  waiting,
  children,
}: {
  connected?: boolean
  waiting?: boolean
  children: React.ReactNode
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

interface PanelProps {
  option: Option
  connection: ConnectionInfo
  /** The agent this tab already connected, if it did. */
  connected: SetupRecord | undefined
  onConnected: (setup: SetupRecord) => void
  /** Pairings made here, kept per tab so switching back reuses one. */
  pairings: Record<string, PairingCreated>
  onPairing: (key: string, pairing: PairingCreated | null) => void
  /** Agents already signed in to Cloud when this tab opened. */
  baseline: Set<string>
  cloudConnections: AgentConnection[] | undefined
  rowId: RowId
}

/** Which tab an agent was connected from. */
function sourceOf(rowId: RowId, option: Option): string {
  return `${rowId}:${option.tab}`
}

function setupFor(
  rowId: RowId,
  option: Option,
  id: string,
  name: string
): SetupRecord {
  return {
    id,
    name,
    harness: option.tab === "Other" ? "MCP agent" : option.tab,
    mode:
      option.kind === "always-on" || option.kind === "grok"
        ? "always-on"
        : "on-demand",
    verified: true,
    platform: platformOf(option),
    source: sourceOf(rowId, option),
  }
}

/** Local CLI agents and always-on agents connect with a pairing code. */
/** Stands in for a pairing code until it arrives; codes look like ABCDE-FGHIJ. */
const CODE_PLACEHOLDER = "·····-·····"

function PairingPanel({
  option,
  rowId,
  connection,
  connected,
  onConnected,
  pairings,
  onPairing,
}: PanelProps) {
  const queryClient = useQueryClient()
  const key = sourceOf(rowId, option)
  const pairing = pairings[key]
  const name = agentName(option)
  const create = useMutation({
    mutationFn: () =>
      option.kind === "always-on"
        ? createPairing({
            target: {
              kind: "agent-adapter",
              adapter: option.agent.adapter,
              participantName: name,
            },
            access: DEFAULT_AGENT_ACCESS,
          })
        : createPairing({
            client: option.kind === "cli" ? option.client : null,
            displayName: name,
            access: DEFAULT_AGENT_ACCESS,
          }),
    onSuccess: (created) => onPairing(key, created),
  })
  // The command is ready when the tab opens. One request per command: a
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
    onConnected(setupFor(rowId, option, `pairing:${pairing.id}`, name))
    void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    // Only the verified transition adds the agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.status, pairing?.id])

  // The command keeps its shape while its code is made, so nothing jumps.
  const origin =
    pairing?.serverOrigin ??
    new URL(desktopAgentConnectionDetails(connection).endpoint).origin
  const code = pairing?.code ?? CODE_PLACEHOLDER
  const command =
    option.kind === "always-on"
      ? shellLines([
          option.agent.installCommand,
          option.agent.restartBeforeConnect && option.agent.restartCommand,
          option.agent.localConnectCommand(origin, code),
          !option.agent.restartBeforeConnect && option.agent.restartCommand,
        ])
      : `curl -fsSL ${pairing ? new URL("/connect.sh", pairing.mcpUrl).href : `${origin}/connect.sh`} | sh -s -- ${code}${option.kind === "cli" && option.client ? ` --client ${option.client}` : ""}`
  const ended = session?.status === "expired" || session?.status === "failed"
  const failure = session ? latestPairingFailure(session) : null

  return (
    <>
      <Instruction>
        {option.kind === "always-on"
          ? `Run this on the machine where ${option.agent.name} runs.`
          : option.kind === "cli" && !option.client
            ? "Run this in your terminal. It adds Worktable to the coding agents it finds, such as OpenCode and VS Code."
            : "Run this in your terminal."}
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
        <StatusLine waiting>Waiting for {waitingFor(option)}</StatusLine>
      )}
    </>
  )
}

/** The token's id, from its `wt_<id>_<secret>` form. */
function tokenId(token: string): string | null {
  return /^wt_([0-9a-f]{12})_/.exec(token)?.[1] ?? null
}

/**
 * Apps and other MCP agents on a self-hosted Worktable connect with an
 * address and an access token made here.
 */
function TokenPanel({
  option,
  rowId,
  connection,
  connected,
  onConnected,
}: PanelProps) {
  const queryClient = useQueryClient()
  const [token, setToken] = useState<{ value: string; id: string } | null>(null)
  const label = option.kind === "chat" ? CHAT_LABELS[option.app] : null
  // An app connected before is the same agent: keep its name and access.
  const existing = useQuery({
    queryKey: ["agent-connections", "app", label],
    queryFn: () => getAppAgent(label!),
    enabled: Boolean(label),
  })
  const name = existing.data?.connection?.displayName ?? agentName(option)
  const mint = useMutation({
    mutationFn: async () => {
      if (label) {
        const result = await connectAgentApp({
          client: label,
          displayName: name,
          access: existing.data?.connection?.access ?? DEFAULT_AGENT_ACCESS,
        })
        return result.token
      }
      return (
        await connectAgentApp({
          client: null,
          displayName: name,
          access: DEFAULT_AGENT_ACCESS,
        })
      ).token
    },
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
    onConnected(setupFor(rowId, option, `token:${token.id}`, name))
    // Only the first use adds the agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [used, token?.id])

  const endpoint = desktopAgentConnectionDetails(connection).endpoint
  const instruction =
    option.kind === "chat"
      ? option.app === "claude"
        ? "Download the Worktable extension for Claude Desktop and open it. Paste this address and the access token, then restart Claude."
        : "In ChatGPT desktop, open Settings, then MCP servers, and add Worktable with Streamable HTTP. Paste this address and the access token."
      : "Add Worktable to your agent as an MCP server with this address and an access token."

  const steps = (
    <>
      <Instruction>{instruction}</Instruction>
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
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {option.kind === "chat" && option.app === "claude" ? (
          <a
            href="/integrations/claude-desktop.mcpb"
            download="worktable-claude-desktop.mcpb"
            className="text-sm font-medium text-primary-text hover:underline"
          >
            Download the extension
          </a>
        ) : null}
        {token || connected ? null : (
          <Button
            variant="outline"
            size="sm"
            disabled={mint.isPending || (Boolean(label) && !existing.isSuccess)}
            onClick={() => mint.mutate()}
          >
            {mint.isPending ? "Creating…" : "Create access token"}
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
        <StatusLine waiting>Waiting for {waitingFor(option)}</StatusLine>
      ) : null}
    </>
  )
  if (option.kind !== "chat") return steps
  return (
    <>
      <ChatAppWays app={option.app} local={<div>{steps}</div>} />
    </>
  )
}

/** Whether a Cloud connection is the one this tab is waiting for. */
function signedInHere(option: Option, connection: AgentConnection): boolean {
  if (
    option.kind === "always-on" &&
    option.agent.cloudAuth === "agent-registration"
  ) {
    return (
      connection.target.kind === "agent-adapter" &&
      connection.target.adapter === option.agent.adapter
    )
  }
  if (connection.authKind !== "oauth") return false
  // An agent another tab started signing in isn't this tab's agent.
  const expected = platformOf(option)
  const actual = agentConnectionPlatform(connection)
  return expected === "other" || actual === "other" || actual === expected
}

/** On Cloud, agents sign in with the Worktable's address. */
function SignInPanel({
  option,
  rowId,
  connection,
  connected,
  onConnected,
  baseline,
  cloudConnections,
}: PanelProps) {
  const url = connection.remoteMcpUrl
  const arrived = cloudConnections?.find(
    (item) => !baseline.has(item.id) && signedInHere(option, item)
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
      onConnected(setupFor(rowId, option, selected.id, selected.displayName)),
  })
  // Each agent that signs in is added once.
  const accepted = useRef<string | null>(null)
  useEffect(() => {
    if (!arrived || connected || accepted.current === arrived.id) return
    accepted.current = arrived.id
    accept.mutate(arrived)
  }, [arrived, connected, accept])

  const instruction =
    option.kind === "cli"
      ? option.client
        ? `Run this in your terminal, then open ${option.tab} and sign in.`
        : "Run this in your terminal, then open your agent and sign in. It adds Worktable to the coding agents it finds, such as OpenCode and VS Code."
      : option.kind === "chat"
        ? option.app === "claude"
          ? "In Claude, open Settings, then Connectors, and add a custom connector. Paste this address and sign in."
          : "In ChatGPT on the web, open Settings, then Apps, and create an app. Paste this address and sign in."
        : option.kind === "always-on"
          ? `Run this on the machine where ${option.agent.name} runs${option.agent.cloudAuth === "oauth" ? ", then sign in" : ""}.`
          : "Add this address as a custom connector or MCP server, then sign in."
  const value =
    option.kind === "cli"
      ? cloudConnectorCommand(url, option.client ?? "auto")
      : option.kind === "always-on"
        ? shellLines([
            option.agent.installCommand,
            option.agent.restartBeforeConnect && option.agent.restartCommand,
            option.agent.cloudConnectCommand(url, agentName(option)),
            !option.agent.restartBeforeConnect && option.agent.restartCommand,
          ])
        : url

  return (
    <>
      <Instruction>{instruction}</Instruction>
      <CommandBlock value={value} />
      {connected ? (
        <StatusLine connected>
          {connectedLine(connected.name, connected.mode === "always-on")}
        </StatusLine>
      ) : accept.isError ? (
        <Callout variant="danger" className="mt-3">
          {arrived?.displayName ?? "Your agent"} signed in, but couldn’t be
          added.{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => arrived && accept.mutate(arrived)}
          >
            Try again
          </button>
        </Callout>
      ) : (
        <StatusLine waiting>Waiting for {waitingFor(option)}</StatusLine>
      )}
    </>
  )
}

function OptionPanel(props: PanelProps) {
  const cloud = props.connection.mcpAuthMode === "oauth"
  const { option } = props
  if (option.kind === "grok")
    return (
      <GrokBotSetupPanel
        connection={props.connection}
        open
        onConnected={(candidate, saved) => {
          if (!props.connected)
            props.onConnected(
              setupFor(
                props.rowId,
                option,
                saved.connectionId,
                candidate.displayName
              )
            )
        }}
      />
    )
  if (!cloud) {
    return option.kind === "cli" || option.kind === "always-on" ? (
      <PairingPanel {...props} />
    ) : (
      <TokenPanel {...props} />
    )
  }
  // Cloud pairs always-on agents once its gateway can route them.
  if (option.kind === "always-on" && props.connection.agentPairing)
    return <PairingPanel {...props} />
  return <SignInPanel {...props} />
}

function RowItem({
  row,
  open,
  onOpenChange,
  onTabChange,
  connected,
  ...panel
}: Omit<PanelProps, "option" | "rowId" | "connected"> & {
  row: Row
  open: boolean
  onOpenChange: (open: boolean, source: string) => void
  onTabChange: (source: string) => void
  connected: SetupRecord[]
}) {
  const [tab, setTab] = useState(() =>
    Math.max(
      0,
      row.options.findIndex((item) =>
        connected.some((setup) => setup.source === sourceOf(row.id, item))
      )
    )
  )
  const option = row.options[tab]!
  const done = connected.find((setup) => setup.source?.startsWith(`${row.id}:`))
  return (
    <AgentSetupCategory
      {...row}
      open={open}
      onOpenChange={(next) => onOpenChange(next, sourceOf(row.id, option))}
      connectedName={done?.name}
    >
      <AgentSetupTabs
        value={tab}
        onValueChange={(value) => {
          onTabChange(sourceOf(row.id, row.options[value]!))
          setTab(value)
        }}
        options={row.options.map((item, index) => ({
          value: index,
          label: item.tab,
          ...(item.tab === "Other" ? {} : { platform: platformOf(item) }),
        }))}
      />
      <div key={tab}>
        <OptionPanel
          {...panel}
          option={option}
          rowId={row.id}
          connected={connected.find(
            (setup) => setup.source === sourceOf(row.id, option)
          )}
        />
      </div>
    </AgentSetupCategory>
  )
}

/**
 * The ways to connect an agent, grouped by how they work. Each tab shows
 * the real command or address for this Worktable and waits for the agent.
 */
export function AgentConnectOptions({
  setups,
  onSetupsChange,
}: {
  setups: SetupRecord[]
  onSetupsChange: (setups: SetupRecord[]) => void
}) {
  const [open, setOpen] = useState<RowId | null>(null)
  // The tab on show in the open row, which is what the page waits for.
  const [active, setActive] = useState<string | null>(null)
  // Cloud agents already signed in when a row or tab opened aren't new.
  const [baseline, setBaseline] = useState<Set<string>>(new Set())
  const [pairings, setPairings] = useState<Record<string, PairingCreated>>({})
  const connection = useQuery({
    queryKey: ["system", "connection"],
    queryFn: getConnection,
    staleTime: 30_000,
  })
  const cloud = connection.data?.mcpAuthMode === "oauth"
  // On Cloud, agents sign in on their own; nothing tells this page, so it
  // looks while the tab on show hasn't connected yet.
  const openWaiting =
    active !== null && !setups.some((setup) => setup.source === active)
  const connections = useQuery({
    queryKey: ["agent-connections", Boolean(cloud)],
    queryFn: () => listAgentConnections({ workspaceAgentsOnCloud: cloud }),
    enabled: cloud,
    refetchInterval:
      cloud && openWaiting && active !== "always:Grok Bot" ? 3_000 : false,
  })

  function addSetup(setup: SetupRecord) {
    onSetupsChange([...setups.filter((item) => item.id !== setup.id), setup])
  }

  const panel = {
    connection: connection.data!,
    onConnected: addSetup,
    pairings,
    onPairing: (key: string, pairing: PairingCreated | null) =>
      setPairings((current) => {
        const next = { ...current }
        if (pairing) next[key] = pairing
        else delete next[key]
        return next
      }),
    cloudConnections: connections.data?.connections,
    baseline,
  }
  function snapshot() {
    setBaseline(
      new Set((connections.data?.connections ?? []).map((item) => item.id))
    )
  }
  function openRow(row: RowId, next: boolean, source: string) {
    if (next) snapshot()
    setOpen(next ? row : null)
    setActive(next ? source : null)
  }
  const rowProps = (row: Row) => ({
    ...panel,
    connected: setups,
    row,
    open: open === row.id,
    onOpenChange: (next: boolean, source: string) =>
      openRow(row.id, next, source),
    onTabChange: (source: string) => {
      snapshot()
      setActive(source)
    },
  })

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
  return (
    <div>
      <div className="overflow-hidden rounded-xl card-surface">
        {ON_DEMAND.map((row) => (
          <RowItem key={row.id} {...rowProps(row)} />
        ))}
        <RowItem {...rowProps(ALWAYS_ON)} />
      </div>
      <Collapsible
        open={open === "mcp"}
        onOpenChange={(next) => openRow("mcp", next, sourceOf("mcp", ANY_MCP))}
      >
        <CollapsibleTrigger className="mt-5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          Using something else?{" "}
          <span className="text-primary-text">Connect any MCP agent</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pt-3">
            <OptionPanel
              {...panel}
              option={ANY_MCP}
              rowId="mcp"
              connected={setups.find(
                (setup) => setup.source === sourceOf("mcp", ANY_MCP)
              )}
            />
          </div>
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
  onSetupsChange: (setups: SetupRecord[]) => void
  onContinue: () => void
  onBack?: () => void
}) {
  return (
    <>
      <StepHeading
        title="Connect your agent"
        description="You can add more later."
      />
      <div className="mt-7">
        <AgentConnectOptions setups={setups} onSetupsChange={onSetupsChange} />
      </div>
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
