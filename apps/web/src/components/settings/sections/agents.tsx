import { fetchJSON } from "@/lib/http"
import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@worktable/ui/components/sonner"
import {
  Check,
  ChevronDown,
  CircleAlert,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react"
import {
  AGENT_PLATFORMS,
  DEFAULT_AGENT_ACCESS,
  CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  MCP_CLIENTS,
  type AgentAccess,
  type AgentConnection,
  type ConnectorInstallableMcpClientId,
} from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Badge } from "@worktable/ui/components/badge"
import { Callout } from "@worktable/ui/components/callout"
import { Card, CardContent } from "@worktable/ui/components/card"
import { SettingRow } from "@worktable/ui/components/setting-row"
import { Switch } from "@worktable/ui/components/switch"
import { useServerSettings } from "@/hooks/use-server-settings"
import { useSettingsPatch } from "../use-settings-patch"
import { Checkbox } from "@worktable/ui/components/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { Input } from "@worktable/ui/components/input"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  useResponsiveDialog,
} from "@worktable/ui/components/responsive-dialog"
import { SecretReveal } from "@worktable/ui/components/secret-reveal"
import { Snippet } from "@worktable/ui/components/snippet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@worktable/ui/components/table"
import { cn } from "@worktable/ui/lib/utils"
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { getConnection, type ConnectionInfo } from "@/lib/system-api"
import { desktopAgentConnectionDetails } from "@/lib/desktop-agent-connection"
import {
  createPairing,
  getPairing,
  latestPairingFailure,
  shouldPollPairing,
  type PairingCreated,
  type PairingSession,
} from "@/lib/pairing-api"
import {
  listTokens,
  mintToken,
  revokeToken,
  type TokenMetadata,
} from "@/lib/tokens-api"
import {
  agentConnectionPlatform,
  disconnectAgentConnection,
  listAgentConnections,
} from "@/lib/agent-connections-api"
import {
  PLUGIN_DOWNLOAD,
  PLUGIN_REPOSITORY,
  SKILLS_GUIDE,
} from "@/lib/agent-app-steps"
import { AgentConnectOptions } from "@/components/onboarding/connect-agent"
import type { SetupRecord } from "@/lib/onboarding-setups"
import { timeAgo } from "@/lib/time"
import { AgentAccessFields } from "@/components/agents/agent-access-fields"
import { AgentAvatar } from "@/components/agents/agent-avatar"
import { AgentEditDialog } from "@/components/agents/agent-edit-dialog"
import { AutoReplyDot } from "@/components/agents/auto-reply"
import { DesktopAgentSkillsGroup } from "./desktop-agent-skills"
import { GrokBotSetupPanel } from "@/components/agents/grok-bot-setup"
import { appForClient, useAppChoices, worktableLabel } from "@/lib/app-choices"
import { WorksInSetting } from "@/components/agents/works-in"
import { GROK_BOT_STATUS_LABELS, grokAutoReply } from "@/lib/grok-bot-status"
import { useSettingsSectionActive } from "../settings-dialog"

// The nav rail / tab strip already names the section, so no repeated heading —
// group headers carry the hierarchy (mirrors SystemSection).
export function AgentsSection() {
  const sectionActive = useSettingsSectionActive()
  const connectionQuery = useQuery({
    queryKey: ["system", "connection"],
    queryFn: getConnection,
    enabled: sectionActive,
    staleTime: 30_000,
  })
  // The list Connected Agents shows, read once for both.
  const agentsOnCloud = connectionQuery.data?.mcpAuthMode === "oauth"
  const agents = useQuery({
    queryKey: ["agent-connections", agentsOnCloud],
    queryFn: () =>
      listAgentConnections({ workspaceAgentsOnCloud: agentsOnCloud }),
    enabled: sectionActive && connectionQuery.isFetched,
  })

  if (connectionQuery.isError && !connectionQuery.data) {
    return (
      <Callout variant="warning">
        <span className="flex flex-wrap items-center gap-3">
          <span>Couldn&rsquo;t read the agent connection settings.</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void connectionQuery.refetch()}
          >
            Try again
          </Button>
        </span>
      </Callout>
    )
  }

  if (connectionQuery.isLoading || !connectionQuery.data) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Checking how agents connect…
      </p>
    )
  }

  const cloud = connectionQuery.data.mcpAuthMode === "oauth"
  // What's connected leads once there is something; until then, connecting does.
  // An empty list says nothing the tiles don't, so it waits for an agent.
  const anyConnected =
    (agents.data?.connections.length ?? 0) > 0 ||
    (agents.data?.grokBots?.length ?? 0) > 0 ||
    agents.isError
  return (
    <div className="flex flex-col gap-8">
      {anyConnected ? <ConnectedAgentsGroup /> : null}
      <ConnectAppGroup active={sectionActive} />
      <ManualSetupGroup connection={connectionQuery.data} />
      <DesktopAgentSkillsGroup enabled={sectionActive} />
      {cloud ? null : (
        <AccessTokensGroup>
          <PreviewToolsRow />
        </AccessTokensGroup>
      )}
    </div>
  )
}

/** The same choice as onboarding: the app, then its one best setup. */
function ConnectAppGroup({ active }: { active: boolean }) {
  // Agents connected here are listed under Connected Agents; this only
  // marks the app on its tile until Settings closes.
  const [setups, setSetups] = useState<SetupRecord[]>([])
  return (
    <section className="flex flex-col gap-3" aria-labelledby="connect-app">
      <h3 id="connect-app" className="text-sm font-medium text-foreground">
        Connect App
      </h3>
      <AgentConnectOptions
        setups={setups}
        onSetupsChange={setSetups}
        active={active}
        compact
      />
    </section>
  )
}

function ManualRow({
  title,
  detail,
  children,
}: {
  title: string
  detail: ReactNode
  children: ReactNode
}) {
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-3 not-first:border-t not-first:border-border/60">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{detail}</div>
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </li>
  )
}

const ROW_LINK = "text-sm font-medium text-primary-text hover:underline"

/**
 * Everything the setups above use, for doing it by hand: the plugin, the
 * skills, Claude Desktop's extension and this Worktable's address.
 */
function ManualSetupGroup({ connection }: { connection: ConnectionInfo }) {
  const cloud = connection.mcpAuthMode === "oauth"
  const address = cloud
    ? connection.remoteMcpUrl
    : desktopAgentConnectionDetails(connection).endpoint
  const copy = useCopy(() => toast.success("Copied"))
  return (
    <section className="flex flex-col gap-3" aria-labelledby="manual-setup">
      <h3 id="manual-setup" className="text-sm font-medium text-foreground">
        Manual Setup
      </h3>
      <ul className="rounded-xl card-surface">
        <ManualRow title="Plugin" detail="Skills and the Cloud connection">
          <a href={PLUGIN_DOWNLOAD} className={ROW_LINK}>
            Download
          </a>
          <a
            href={PLUGIN_REPOSITORY}
            target="_blank"
            rel="noreferrer"
            className={ROW_LINK}
          >
            Open
          </a>
        </ManualRow>
        <ManualRow title="Skills" detail="For agents without the plugin">
          <a
            href={SKILLS_GUIDE}
            target="_blank"
            rel="noreferrer"
            className={ROW_LINK}
          >
            Open
          </a>
        </ManualRow>
        {cloud ? null : (
          <ManualRow title="Desktop Extension" detail="Claude Desktop">
            <a
              href="/integrations/claude-desktop.mcpb"
              download="worktable-claude-desktop.mcpb"
              className={ROW_LINK}
            >
              Download
            </a>
          </ManualRow>
        )}
        <ManualRow
          title="MCP Address"
          detail={<span className="font-mono">{address}</span>}
        >
          <button
            type="button"
            className={ROW_LINK}
            onClick={() => void copy.copy(address)}
          >
            {copy.copied ? "Copied" : "Copy"}
          </button>
        </ManualRow>
      </ul>
    </section>
  )
}

/** Self-hosted only: Cloud always serves the released tools. */
function PreviewToolsRow() {
  const settingsQuery = useServerSettings()
  const patch = useSettingsPatch()
  const settings = settingsQuery.data
  if (settingsQuery.isError) return null
  const override = settings?.agents.previewToolsOverride ?? null
  return (
    <div className="rounded-xl card-surface p-4">
      <SettingRow
        label="Preview agent tools"
        description={
          override === null
            ? "Agents use tool changes that aren't released yet, from the next time they connect."
            : "Set by WORKTABLE_MCP_PREVIEW on this server."
        }
      >
        <Switch
          checked={override ?? settings?.agents.previewTools ?? false}
          disabled={!settings || patch.isPending || override !== null}
          onCheckedChange={(v) => patch.mutate({ agents: { previewTools: v } })}
        />
      </SettingRow>
    </div>
  )
}

// ── Quick connect (pairing — the primary path) ───────────────────────────────

const REMOTE_CLIENT_KEY = "worktable-connect-remote-client"
type RemoteClientChoice = ConnectorInstallableMcpClientId | "auto"

// Goose has no config surface the connector can write (manual install only),
// so offering it here would mint a pairing that always fails on the machine.
const REMOTE_CLIENT_OPTIONS = CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.map(
  (id) => MCP_CLIENTS[id]
)

function readStoredRemoteClient(): RemoteClientChoice {
  try {
    const stored = localStorage.getItem(REMOTE_CLIENT_KEY)
    if (stored === "auto") return "auto"
    if (stored && REMOTE_CLIENT_OPTIONS.some((c) => c.id === stored)) {
      return stored as ConnectorInstallableMcpClientId
    }
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return "auto"
}

function RemoteAgentOriginWarning({
  connection,
}: {
  connection: ConnectionInfo
}) {
  if (connection.originConfigured) return null
  return (
    <p className="text-sm text-muted-foreground">
      Agents on another computer require a Worktable URL in Settings → General.
    </p>
  )
}

function QuickConnectPanel({
  connection,
  agentId,
}: {
  connection: ConnectionInfo
  agentId?: string
}) {
  const queryClient = useQueryClient()
  const sectionActive = useSettingsSectionActive()

  const [clientChoice, setClientChoice] = useState<RemoteClientChoice>(
    readStoredRemoteClient
  )
  useEffect(() => {
    try {
      localStorage.setItem(REMOTE_CLIENT_KEY, clientChoice)
    } catch {
      // Best-effort persistence.
    }
  }, [clientChoice])

  // The pairing code lives only in component state, like the manual flow's
  // one-time token: the dialog shell unmounts sections on close, so a code
  // can't outlive the dialog. Codes are single-use and expire server-side
  // anyway (15 minutes).
  const [pairing, setPairing] = useState<PairingCreated | null>(null)
  const [access, setAccess] = useState<AgentAccess>(DEFAULT_AGENT_ACCESS)

  const create = useMutation({
    mutationFn: () =>
      createPairing({
        client: clientChoice === "auto" ? null : clientChoice,
        access,
        ...(agentId ? { agentId } : {}),
      }),
    onSuccess: (res) => setPairing(res),
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Couldn't create a pairing code."
      ),
  })

  const statusQuery = useQuery({
    queryKey: ["pairing", pairing?.id],
    queryFn: () => getPairing(pairing!.id),
    enabled: sectionActive && pairing !== null,
    refetchInterval: (query) =>
      shouldPollPairing(query.state.data) ? 2_000 : false,
  })
  const session = statusQuery.data

  // A redeemed pairing minted a token — surface it in Access tokens right
  // away, then refresh Connected agents again when durable completion lands.
  const tokenId = session?.tokenId ?? null
  const pairingStatus = session?.status
  useEffect(() => {
    if (!tokenId) return
    void queryClient.invalidateQueries({ queryKey: ["tokens"] })
    void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    void queryClient.invalidateQueries({ queryKey: ["system", "connection"] })
  }, [tokenId, pairingStatus, queryClient])

  // The command's origin comes from the pairing itself: the server resolved
  // it when the pairing was created, so it cannot go stale against a cached
  // connection query (e.g. right after the Worktable URL changed).
  const command = pairing
    ? `curl -fsSL ${new URL("/connect.sh", pairing.mcpUrl).href} | sh -s -- ${pairing.code}${pairing.client ? ` --client ${pairing.client}` : ""}`
    : null

  const copied = () => toast.success("Copied")

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">Agent</span>
        <Select
          value={clientChoice}
          onValueChange={(value) => {
            setClientChoice(value as RemoteClientChoice)
            setPairing(null)
            create.reset()
          }}
          disabled={create.isPending}
        >
          <SelectTrigger aria-label="Coding agent" className="w-full sm:w-64">
            <SelectValue>
              {clientChoice === "auto"
                ? "Detect automatically"
                : MCP_CLIENTS[clientChoice].label}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Detect automatically</SelectItem>
            {REMOTE_CLIENT_OPTIONS.map((client) => (
              <SelectItem key={client.id} value={client.id}>
                {client.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <AgentAccessFields
        value={access}
        onChange={(next) => {
          setAccess(next)
          setPairing(null)
          create.reset()
        }}
        // A pairing being created carries this choice; it stays until done.
        disabled={create.isPending}
      />

      <RemoteAgentOriginWarning connection={connection} />

      {!pairing ? (
        <div>
          <Button
            onClick={() => create.mutate()}
            disabled={
              create.isPending ||
              !(access.threads || access.read || access.edit)
            }
          >
            {create.isPending ? "Connecting…" : "Connect"}
          </Button>
        </div>
      ) : (
        <>
          {command ? <Snippet code={command} onCopied={copied} /> : null}
          <p className="text-sm text-muted-foreground">
            One use · 15 minutes · Node 18+ or Bun
          </p>

          <PairingStatus session={session} />

          {/* Always offered: a connector that crashed after redeeming
                would otherwise strand the flow on a spinner forever. */}
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => create.mutate()}
              disabled={create.isPending}
            >
              {create.isPending ? "Generating…" : "New command"}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

// The live install trail the connector reports back through the pairing
// session. Order matters: each step lights up as its event arrives.
const PAIRING_STEPS = [
  { event: "redeemed", label: "Command accepted" },
  { event: "config_written", label: "Worktable added" },
  { event: "verified", label: "Connection verified" },
] as const

function PairingStatus({ session }: { session: PairingSession | undefined }) {
  if (!session || session.status === "pending") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Waiting for the command to run…
      </div>
    )
  }

  if (session.status === "expired") {
    return (
      <Callout variant="warning">
        This code expired before it was used. Generate a new one.
      </Callout>
    )
  }

  const failure = latestPairingFailure(session)
  const done = new Set(session.events.map((e) => e.event))
  const redeemedOn = session.redeemedBy?.hostname

  return (
    <div className="flex flex-col gap-2" role="status">
      <ul className="flex flex-col gap-1.5">
        {PAIRING_STEPS.map((step, index) => {
          const isDone = done.has(step.event)
          const prevDone =
            index === 0 || done.has(PAIRING_STEPS[index - 1]!.event)
          const isCurrent = !isDone && prevDone && !failure
          return (
            <li
              key={step.event}
              className={cn(
                "flex items-center gap-2 text-sm",
                isDone ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {isDone ? (
                <Check className="size-4 text-success" aria-hidden />
              ) : isCurrent ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <span
                  className="mx-1 size-2 rounded-full bg-border"
                  aria-hidden
                />
              )}
              {step.event === "redeemed" && redeemedOn
                ? `Command ran on ${redeemedOn}`
                : step.label}
            </li>
          )
        })}
      </ul>

      {session.status === "verified" ? (
        <Callout variant="success">Connected.</Callout>
      ) : null}

      {failure ? (
        <Callout variant="danger">
          <span className="flex items-start gap-1.5">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Connect failed
              {failure.detail ? `: ${failure.detail}` : "."} Generate a new
              command to retry.
            </span>
          </span>
        </Callout>
      ) : null}
    </div>
  )
}

// ── Connected agents ---------------------------------------------------------

/** The agent's one name; Cloud's inventory still reports it beside a platform label. */
function agentConnectionName(connection: AgentConnection): string {
  // This Worktable reports each of its agents under its canonical name.
  if (connection.authKind === "local-token") return connection.displayName
  return (
    connection.participant?.name ?? clientDisplayName(connection.displayName)
  )
}

export function ConnectedAgentsGroup() {
  const sectionActive = useSettingsSectionActive()
  const queryClient = useQueryClient()
  const systemConnection = useQuery({
    queryKey: ["system", "connection"],
    queryFn: getConnection,
    enabled: sectionActive,
  })
  const workspaceAgentsOnCloud = systemConnection.data?.mcpAuthMode === "oauth"
  const connectionsQuery = useQuery({
    queryKey: ["agent-connections", workspaceAgentsOnCloud],
    queryFn: () => listAgentConnections({ workspaceAgentsOnCloud }),
    enabled: sectionActive && systemConnection.isFetched,
  })
  const disconnect = useMutation({
    mutationFn: async (id: string) => {
      const inventory = connectionsQuery.data
      const connection = inventory?.connections.find((entry) => entry.id === id)
      if (!connection) throw new Error("Agent connection not found")
      const clientId =
        connection?.authKind === "oauth" &&
        connection.target.kind === "mcp-client"
          ? connection.target.clientId
          : null
      const grok = inventory?.grokBots?.find(
        (entry) =>
          (connection?.participant &&
            entry.participantId === connection.participant.id) ||
          (clientId && entry.connectionId.startsWith(`oauth:${clientId}:`))
      )
      const candidate = inventory?.grokBotCandidates?.find(
        (entry) =>
          entry.participantId === connection.participant?.id ||
          (clientId && entry.id.startsWith(`oauth:${clientId}:`))
      )
      const grokId = grok?.connectionId ?? candidate?.id
      const result = await disconnectAgentConnection(connection)
      // Workspace/Team disconnects own this cleanup. A gateway sign-in is
      // disconnected on Cloud, so its local routine must be retired here.
      const cleaned =
        grokId &&
        connection.authKind === "oauth" &&
        connection.ownership === undefined &&
        connection.requestScope !== "workspace"
          ? await fetchJSON(
              `/api/grok-bot/${encodeURIComponent(grokId)}/configuration?scope=workspace&disconnect=1`,
              { method: "DELETE" }
            ).then(
              () => true,
              () => false
            )
          : true
      if (!cleaned)
        toast.warning("Agent disconnected. Could not remove its Grok routine.")
      return result
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
      void queryClient.invalidateQueries({ queryKey: ["tokens"] })
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn’t disconnect the agent."
      ),
  })

  const reconnect = useMutation({
    mutationFn: (id: string) =>
      fetchJSON(`/api/team/agents/${encodeURIComponent(id)}/reconnect`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Sign in again from your agent to finish reconnecting.")
      void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not reconnect the agent."
      ),
  })
  const [editing, setEditing] = useState<AgentConnection | null>(null)
  const [editingGrok, setEditingGrok] = useState<string | null>(null)
  const [grokOpen, setGrokOpen] = useState(false)
  const [confirmingGrok, setConfirmingGrok] = useState(false)
  const appChoices = useAppChoices(sectionActive)
  const connections = connectionsQuery.data?.connections ?? []
  const grokBots = connectionsQuery.data?.grokBots ?? []
  const candidates = connectionsQuery.data?.grokBotCandidates ?? []
  const botForConnection = (connection: AgentConnection) =>
    grokBots.find(
      (bot) =>
        bot.participantId === connection.participant?.id ||
        (connection.authKind === "oauth" &&
          connection.target.kind === "mcp-client" &&
          connection.target.clientId &&
          bot.connectionId.startsWith(`oauth:${connection.target.clientId}:`))
    )
  const rows = [
    ...connections.map((connection) => ({
      connection,
      grok: botForConnection(connection),
    })),
    ...grokBots
      .filter(
        (bot) =>
          !connections.some(
            (connection) =>
              botForConnection(connection)?.connectionId === bot.connectionId
          )
      )
      .map((grok) => ({ connection: undefined, grok })),
  ]
  const editingCandidate = candidates.find(
    (candidate) => candidate.id === editingGrok
  )
  const editingConnection = connections.find(
    (connection) => botForConnection(connection)?.connectionId === editingGrok
  )
  // Grok Bot is an app at Cloud's shared address too, so it can work elsewhere.
  const editingGrokApp =
    editingConnection?.target.kind === "mcp-client"
      ? appForClient(appChoices.data, editingConnection.target.clientId)
      : undefined
  const oauthInventoryUnavailable =
    (connectionsQuery.data?.unavailableAuthKinds?.length ?? 0) > 0
  return (
    <section className="flex flex-col gap-3" aria-labelledby="connected-agents">
      <h3 id="connected-agents" className="text-sm font-medium text-foreground">
        Connected Agents
      </h3>
      <Card>
        <CardContent>
          {oauthInventoryUnavailable ? (
            <Callout variant="warning" className="mb-3">
              Some details are unavailable. Registered agents can still be
              disconnected.
            </Callout>
          ) : null}
          {connectionsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">
              Loading connected agents…
            </p>
          ) : connectionsQuery.isError ? (
            <p className="text-sm text-muted-foreground">
              Owner access required.
            </p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No agents connected yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map(({ connection, grok }) => {
                const candidate = candidates.find(
                  (candidate) => candidate.id === grok?.connectionId
                )
                const name =
                  candidate?.displayName ??
                  (connection ? agentConnectionName(connection) : "Grok Bot")
                const platform = grok
                  ? "grok-bot"
                  : agentConnectionPlatform(connection!)
                const platformName = AGENT_PLATFORMS[platform].name
                // An app working in another Worktable says so in place of when it was seen.
                const app =
                  connection?.target.kind === "mcp-client"
                    ? appForClient(appChoices.data, connection.target.clientId)
                    : undefined
                const elsewhere =
                  app?.worktable && !app.worktable.here ? app.worktable : null
                return (
                  <li
                    key={connection?.id ?? grok!.connectionId}
                    className="flex min-h-14 items-center gap-3 rounded-xl bg-surface-inset px-3 py-2"
                  >
                    <span className="relative shrink-0">
                      <AgentAvatar
                        name={name}
                        platform={platform}
                        icon={connection?.icon}
                      />
                      <AutoReplyDot
                        autoReply={
                          grok ? grokAutoReply(grok) : connection?.autoReply
                        }
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium text-foreground">
                        {name}
                      </span>
                      <p className="truncate text-xs text-muted-foreground">
                        {platform !== "other" && platformName !== name
                          ? `${platformName} · `
                          : ""}
                        {connection?.machine ? `${connection.machine} · ` : ""}
                        {connection?.link ? "Worktable Link · " : ""}
                        {elsewhere
                          ? `Works in ${worktableLabel(elsewhere)}`
                          : grok
                            ? GROK_BOT_STATUS_LABELS[grok.status]
                            : connection?.lastSeenAt
                              ? `Last seen ${timeAgo(connection.lastSeenAt)}`
                              : "Not used yet"}
                      </p>
                    </div>
                    {/* Edit holds everything else, Disconnect included. */}
                    {connection?.canManage !== false && (grok || connection) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (grok) {
                            setEditingGrok(grok.connectionId)
                            setGrokOpen(true)
                          } else setEditing(connection!)
                        }}
                      >
                        Edit
                      </Button>
                    ) : null}
                    {connection?.canReconnect && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={reconnect.isPending}
                        onClick={() => reconnect.mutate(connection.id)}
                      >
                        Reconnect
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      <AgentEditDialog
        connection={editing}
        autoReply={
          (connections.find((entry) => entry.id === editing?.id) ?? editing)
            ?.autoReply
        }
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
        onDisconnect={
          editing && !editing.link && editing.canManage !== false
            ? () =>
                disconnect.mutate(editing.id, {
                  onSuccess: () => setEditing(null),
                })
            : undefined
        }
        disconnecting={disconnect.isPending}
      />
      <ResponsiveDialog
        open={grokOpen}
        onOpenChange={(open) => {
          setGrokOpen(open)
        }}
      >
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <AgentAvatar
              name={editingCandidate?.displayName ?? "Grok Bot"}
              platform="grok-bot"
              className="mb-1 size-10"
            />
            <ResponsiveDialogTitle>
              {editingCandidate?.displayName ?? "Grok Bot"}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>Grok Bot</ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            {editingGrokApp?.worktable && (
              <div className="mb-5">
                <WorksInSetting app={editingGrokApp} />
              </div>
            )}
            {editingGrok && systemConnection.data && (
              <GrokBotSetupPanel
                key={editingGrok}
                connection={systemConnection.data}
                connectionId={editingGrok}
                open={grokOpen}
                onRemoved={() => setGrokOpen(false)}
              />
            )}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            {/* Cloud holds a Link sign-in, so it's managed there. */}
            {editingConnection?.link && (
              <a
                href={editingConnection.link.manageUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-muted-foreground hover:text-foreground sm:mr-auto sm:self-center"
              >
                Manage in Cloud
              </a>
            )}
            {editingConnection &&
              !editingConnection.link &&
              editingConnection.canManage !== false && (
                <Button
                  variant="destructive"
                  className="sm:mr-auto"
                  disabled={disconnect.isPending}
                  onClick={() => setConfirmingGrok(true)}
                >
                  Disconnect
                </Button>
              )}
            {editingConnection &&
              (editingConnection.authKind === "local-token" ||
                editingConnection.access) && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setGrokOpen(false)
                    setEditing(editingConnection)
                  }}
                >
                  Access and avatar
                </Button>
              )}
            <Button variant="outline" onClick={() => setGrokOpen(false)}>
              Close
            </Button>
          </ResponsiveDialogFooter>
          {editingConnection && (
            <ConfirmDialog
              open={confirmingGrok}
              onOpenChange={(open) => {
                if (!disconnect.isPending) setConfirmingGrok(open)
              }}
              title={`Disconnect ${editingCandidate?.displayName ?? "Grok Bot"}?`}
              description="It loses access to this Worktable."
              confirmLabel="Disconnect"
              variant="destructive"
              loading={disconnect.isPending}
              loadingLabel="Disconnecting…"
              onConfirm={() =>
                disconnect.mutate(editingConnection.id, {
                  onSuccess: () => {
                    setConfirmingGrok(false)
                    setGrokOpen(false)
                  },
                })
              }
            />
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </section>
  )
}

// ── Advanced access tokens ---------------------------------------------------
//
// Local/self-hosted connection management. Today every row is a local bearer
// token (paired, managed, or hand-minted). Cloud renders its OAuth guide above;
// future Cloud inventory belongs to the stable agent-identity roadmap rather
// than exposing raw authorization grants through this local-token surface.

export function AccessTokensGroup({ children }: { children?: ReactNode } = {}) {
  const queryClient = useQueryClient()
  const sectionActive = useSettingsSectionActive()
  const tokensQuery = useQuery({
    queryKey: ["tokens"],
    queryFn: listTokens,
    enabled: sectionActive,
  })
  const [newOpen, setNewOpen] = useState(false)
  const [open, setOpen] = useState(false)

  const active = (tokensQuery.data ?? []).filter((t) => t.revokedAt == null)

  const revoke = useMutation({
    mutationFn: (id: string) => revokeToken(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tokens"] })
      void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Couldn't revoke the token."
      ),
  })

  const summary = tokensQuery.isLoading
    ? "Loading…"
    : tokensQuery.isError
      ? "Owner access required"
      : active.length === 0
        ? "No active tokens"
        : `${active.length} active ${active.length === 1 ? "token" : "tokens"}`

  return (
    <section className="flex flex-col gap-3" aria-labelledby="advanced-title">
      <h3 id="advanced-title" className="text-sm font-medium text-foreground">
        Advanced
      </h3>
      <Collapsible open={open} onOpenChange={setOpen}>
        <Card className="gap-0 py-0">
          <div className="flex min-h-14 items-center gap-2 pr-3">
            <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors outline-none hover:bg-surface-hover focus-visible:ring-3 focus-visible:ring-ring/50">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  Access tokens
                </span>
                <span className="block text-sm text-muted-foreground">
                  {summary}
                </span>
              </span>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-180"
                )}
                aria-hidden
              />
            </CollapsibleTrigger>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setNewOpen(true)}
            >
              <Plus className="size-4" />
              New token
            </Button>
          </div>

          <CollapsibleContent keepMounted>
            <CardContent className="border-t border-border/60 py-4">
              {tokensQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">
                  Loading access tokens…
                </p>
              ) : tokensQuery.isError ? (
                <p className="text-sm text-muted-foreground">
                  Connection management requires owner access.
                </p>
              ) : active.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No active access tokens. Local agents on this machine may
                  connect without one.
                </p>
              ) : (
                <TokenList
                  tokens={active}
                  onRevoke={(id) => revoke.mutate(id)}
                  revoking={revoke.isPending}
                />
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
      {children}

      <NewTokenDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onMinted={() => {
          void queryClient.invalidateQueries({ queryKey: ["tokens"] })
          void queryClient.invalidateQueries({
            queryKey: ["agent-connections"],
          })
          void queryClient.invalidateQueries({
            queryKey: ["system", "connection"],
          })
        }}
      />
    </section>
  )
}

// Paired tokens carry a `client@hostname` label; the CLI's same-machine token
// is labeled "managed"; hand-minted ones are free text. Split into a display
// identity: what connects, and from where.
function connectionIdentity(token: TokenMetadata): {
  name: string
  machine: string | null
} {
  const label = token.agent
  if (!label) return { name: "Unnamed token", machine: null }
  if (label.startsWith("manual@")) return { name: "MCP agent", machine: null }
  if (label === MANAGED_LABEL) {
    return { name: "Local agents", machine: "this machine" }
  }
  const at = label.indexOf("@")
  if (at <= 0) return { name: clientDisplayName(label), machine: null }
  return {
    name: clientDisplayName(label.slice(0, at)),
    machine: label.slice(at + 1),
  }
}

const MANAGED_LABEL = "managed"

function clientDisplayName(id: string): string {
  return id in MCP_CLIENTS
    ? MCP_CLIENTS[id as keyof typeof MCP_CLIENTS].label
    : id
}

// "Connected right now" is not a thing MCP has (stateless, on-demand), so
// status is derived from the last successful verify: seen recently = active,
// silent for a week = stale, never seen = configured but unproven.
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

function lastSeenInfo(token: TokenMetadata): {
  label: string
  tone: "active" | "stale" | "never"
} {
  if (!token.lastUsedAt) return { label: "Never used", tone: "never" }
  const age = Date.now() - new Date(token.lastUsedAt).getTime()
  return {
    label: timeAgo(token.lastUsedAt),
    tone: age >= STALE_AFTER_MS ? "stale" : "active",
  }
}

function LastSeen({ token }: { token: TokenMetadata }) {
  const info = lastSeenInfo(token)
  return (
    <span className="flex items-center gap-1.5 text-sm">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          info.tone === "active" && "bg-success",
          info.tone === "stale" && "bg-warning",
          info.tone === "never" && "bg-border"
        )}
        aria-hidden
      />
      <span
        className={
          info.tone === "never" ? "text-muted-foreground" : "text-foreground"
        }
      >
        {info.label}
      </span>
    </span>
  )
}

// wt_ prefix is only on the full token string; metadata carries the bare id.
// Show a recognizable, prefixed, truncated handle.
function tokenHandle(token: TokenMetadata): string {
  return `wt_${token.id.slice(0, 4)}…`
}

function ScopeBadges({ scopes }: { scopes: string[] }) {
  if (scopes.includes("*")) {
    return (
      <Badge
        variant="secondary"
        className="border border-accent-bronze/25 bg-surface-tint text-accent-bronze-ink"
      >
        Full access
      </Badge>
    )
  }
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <Badge key={scope} variant="secondary" className="font-mono">
          {scope}
        </Badge>
      ))}
    </div>
  )
}

function RevokeButton({
  token,
  onRevoke,
  revoking,
}: {
  token: TokenMetadata
  onRevoke: (id: string) => void
  revoking: boolean
}) {
  const [open, setOpen] = useState(false)
  const identity = connectionIdentity(token)
  const who = identity.machine
    ? `${identity.name} on ${identity.machine}`
    : identity.name
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Revoke access token"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-4" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        variant="destructive"
        title="Revoke access token?"
        description={`${who} loses access immediately. This can’t be undone.`}
        confirmLabel="Revoke"
        loading={revoking}
        onConfirm={() => {
          onRevoke(token.id)
          setOpen(false)
        }}
      />
    </>
  )
}

// Desktop table + a stacked-card list on mobile so the layout never overflows a
// 390px viewport (the table's own columns can't collapse below that).
function TokenList({
  tokens,
  onRevoke,
  revoking,
}: {
  tokens: TokenMetadata[]
  onRevoke: (id: string) => void
  revoking: boolean
}) {
  return (
    <>
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Scopes</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((token) => {
            const identity = connectionIdentity(token)
            return (
              <TableRow key={token.id}>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm text-foreground">
                      {identity.name}
                    </span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {identity.machine ? `${identity.machine} · ` : ""}
                      {tokenHandle(token)}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <ScopeBadges scopes={token.scopes} />
                </TableCell>
                <TableCell
                  title={`Created ${new Date(token.createdAt).toLocaleDateString()}`}
                >
                  <LastSeen token={token} />
                </TableCell>
                <TableCell className="text-right">
                  <RevokeButton
                    token={token}
                    onRevoke={onRevoke}
                    revoking={revoking}
                  />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      <ul className="flex flex-col gap-3 md:hidden">
        {tokens.map((token) => {
          const identity = connectionIdentity(token)
          return (
            <li
              key={token.id}
              className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm text-foreground">
                    {identity.name}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {identity.machine ? `${identity.machine} · ` : ""}
                    {tokenHandle(token)}
                  </span>
                </div>
                <RevokeButton
                  token={token}
                  onRevoke={onRevoke}
                  revoking={revoking}
                />
              </div>
              <ScopeBadges scopes={token.scopes} />
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <LastSeen token={token} />
                <span>
                  Created {new Date(token.createdAt).toLocaleDateString()}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}

// ── New token dialog ─────────────────────────────────────────────────────────

// Per-resource read/write scope pairs, plus a search-read scope and a single
// full-access checkbox. The full-access checkbox disables the rest.
const SCOPE_RESOURCES = [
  { key: "docs", label: "Documents" },
  { key: "widgets", label: "Widgets" },
  { key: "records", label: "Records" },
  { key: "annotations", label: "Comments" },
  { key: "threads", label: "Threads" },
] as const

function NewTokenDialog({
  open,
  onOpenChange,
  onMinted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onMinted: () => void
}) {
  const { isMobile } = useResponsiveDialog()
  const [agent, setAgent] = useState("")
  const [full, setFull] = useState(false)
  const [scopes, setScopes] = useState<Set<string>>(new Set())
  const [minted, setMinted] = useState<string | null>(null)

  const mint = useMutation({
    mutationFn: (selected: string[]) =>
      mintToken({ scopes: selected, agent: agent.trim() || null }),
    onSuccess: (res) => {
      setMinted(res.token)
      onMinted()
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Couldn't create the token."
      ),
  })

  function reset() {
    setAgent("")
    setFull(false)
    setScopes(new Set())
    setMinted(null)
    mint.reset()
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  function toggleScope(scope: string, checked: boolean) {
    setScopes((prev) => {
      const next = new Set(prev)
      if (checked) next.add(scope)
      else next.delete(scope)
      return next
    })
  }

  const selected = full ? ["*"] : [...scopes]
  const canMint = selected.length > 0 && !mint.isPending

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {minted ? "Token created" : "New access token"}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {minted
              ? "Copy this token now. It won’t be shown again."
              : "Create a scoped token for a manually configured client."}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {minted ? (
          <>
            <ResponsiveDialogBody>
              <div className="flex flex-col gap-3">
                <SecretReveal
                  secret={minted}
                  onCopied={() => toast.success("Copied")}
                />
                <Callout variant="info">
                  You won’t be able to see this token again.
                </Callout>
              </div>
            </ResponsiveDialogBody>
            <ResponsiveDialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </ResponsiveDialogFooter>
          </>
        ) : (
          <>
            <ResponsiveDialogBody>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="token-agent"
                    className="text-sm font-medium text-foreground"
                  >
                    Agent label (optional)
                  </label>
                  <Input
                    id="token-agent"
                    value={agent}
                    onChange={(e) => setAgent(e.target.value)}
                    placeholder="e.g. claude-code"
                    autoFocus={!isMobile}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium text-foreground">
                    Scopes
                  </span>
                  <ScopeCheckbox
                    label="Full access (*)"
                    checked={full}
                    onCheckedChange={(v) => setFull(v)}
                  />
                  <div
                    className={cn(
                      "flex flex-col gap-2",
                      full && "pointer-events-none opacity-50"
                    )}
                  >
                    {SCOPE_RESOURCES.map((resource) => (
                      <div
                        key={resource.key}
                        className="flex items-center justify-between gap-4"
                      >
                        <span className="text-sm text-foreground">
                          {resource.label}
                        </span>
                        <div className="flex shrink-0 gap-4">
                          <ScopeCheckbox
                            label="Read"
                            checked={scopes.has(`${resource.key}:read`)}
                            disabled={full}
                            onCheckedChange={(v) =>
                              toggleScope(`${resource.key}:read`, v)
                            }
                          />
                          <ScopeCheckbox
                            label="Write"
                            checked={scopes.has(`${resource.key}:write`)}
                            disabled={full}
                            onCheckedChange={(v) =>
                              toggleScope(`${resource.key}:write`, v)
                            }
                          />
                        </div>
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-sm text-foreground">Search</span>
                      <ScopeCheckbox
                        label="Read"
                        checked={scopes.has("search:read")}
                        disabled={full}
                        onCheckedChange={(v) => toggleScope("search:read", v)}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </ResponsiveDialogBody>
            <ResponsiveDialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={!canMint} onClick={() => mint.mutate(selected)}>
                {mint.isPending ? "Creating…" : "Create token"}
              </Button>
            </ResponsiveDialogFooter>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function ScopeCheckbox({
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2 text-sm text-foreground",
        disabled ? "cursor-not-allowed" : "cursor-pointer"
      )}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      {label}
    </label>
  )
}

/** Use the ordinary connection flow for an explicitly registered team agent. */
export function TeamAgentConnectPanel({ agentId }: { agentId: string }) {
  const connection = useQuery({
    queryKey: ["system", "connection"],
    queryFn: getConnection,
  })
  if (connection.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading connection…
      </p>
    )
  if (connection.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load connection settings.
      </p>
    )
  return (
    <QuickConnectPanel
      key={agentId}
      connection={connection.data}
      agentId={agentId}
    />
  )
}
