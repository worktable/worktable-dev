import { cloudConnectorCommand } from "@/lib/always-on-agents"
import { fetchJSON } from "@/lib/http"
import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@worktable/ui/components/sonner"
import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Download,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react"
import {
  AGENT_PLATFORMS,
  DEFAULT_AGENT_ACCESS,
  CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  MCP_CLIENTS,
  scopesForAccess,
  type AgentAccess,
  type AgentConnection,
  type ConnectorInstallableMcpClientId,
} from "@worktable/types"
import { Button, buttonVariants } from "@worktable/ui/components/button"
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
import { CopyField } from "@worktable/ui/components/copy-field"
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
  connectAgentApp,
  getAppAgent,
  disconnectAgentConnection,
  listAgentConnections,
} from "@/lib/agent-connections-api"
import { ALWAYS_ON_AGENTS, type AlwaysOnAgent } from "@/lib/always-on-agents"
import { timeAgo } from "@/lib/time"
import { AgentAccessFields } from "@/components/agents/agent-access-fields"
import { AgentAvatar } from "@/components/agents/agent-avatar"
import { AgentEditDialog } from "@/components/agents/agent-edit-dialog"
import { DesktopAgentSkillsGroup } from "./desktop-agent-skills"
import {
  GrokBotSetupPanel,
  GROK_BOT_STATUS_LABELS,
} from "@/components/agents/grok-bot-setup"
import {
  AGENT_SETUP_CATEGORIES,
  AgentSetupCategory,
  AgentSetupTabs,
} from "@/components/agents/agent-setup-category"
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

  if (connectionQuery.data.mcpAuthMode === "oauth") {
    return (
      <div className="flex flex-col gap-6">
        <AgentSetupGroup connection={connectionQuery.data} />
        <ConnectedAgentsGroup />
        <DesktopAgentSkillsGroup enabled={sectionActive} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <AgentSetupGroup connection={connectionQuery.data} />
      <ConnectedAgentsGroup />
      <DesktopAgentSkillsGroup enabled={sectionActive} />
      <AccessTokensGroup>
        <PreviewToolsRow />
      </AccessTokensGroup>
    </div>
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

function CloudQuickConnectPanel({
  connection,
}: {
  connection: ConnectionInfo
}) {
  const [clientChoice, setClientChoice] = useState<RemoteClientChoice>("auto")
  const command = cloudConnectorCommand(connection.remoteMcpUrl, clientChoice)
  return (
    <div className="flex flex-col gap-4">
      <Select
        value={clientChoice}
        onValueChange={(value) => setClientChoice(value as RemoteClientChoice)}
      >
        <SelectTrigger
          aria-label="Cloud quick connect agent"
          className="w-full sm:w-64"
        >
          <SelectValue>
            {clientChoice === "auto"
              ? "Detect installed agents"
              : MCP_CLIENTS[clientChoice].label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Detect installed agents</SelectItem>
          {REMOTE_CLIENT_OPTIONS.map((client) => (
            <SelectItem key={client.id} value={client.id}>
              {client.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Snippet code={command} onCopied={() => toast.success("Copied")} />
    </div>
  )
}

function CloudAlwaysOnPanel({
  connection,
  agent,
}: {
  connection: ConnectionInfo
  agent: AlwaysOnAgent
}) {
  const connect = agent.cloudConnectCommand(connection.remoteMcpUrl)
  const installCopy = useCopy(() => toast.success("Copied"))
  const connectCopy = useCopy(() => toast.success("Copied"))
  return (
    <div className="flex flex-col gap-4">
      <AlwaysOnSteps
        agent={agent}
        connectInstruction="Select Connect, then run the copied command."
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => void installCopy.copy(agent.installCommand)}
        >
          <Copy className="size-4" aria-hidden />
          {installCopy.copied ? "Copied" : "Install"}
        </Button>
        <Button onClick={() => void connectCopy.copy(connect)}>
          <Copy className="size-4" aria-hidden />
          {connectCopy.copied ? "Copied" : "Connect"}
        </Button>
      </div>
    </div>
  )
}

function CloudNativeAppsPanel({ connection }: { connection: ConnectionInfo }) {
  const [app, setApp] = useState<"claude" | "chatgpt">("claude")
  return (
    <div className="flex flex-col gap-3">
      <AgentSetupTabs
        value={app}
        onValueChange={setApp}
        options={[
          { value: "claude", label: "Claude", platform: "claude" },
          { value: "chatgpt", label: "ChatGPT", platform: "chatgpt" },
        ]}
      />
      <p className="text-sm text-muted-foreground">
        {app === "claude"
          ? "In Claude, add a custom connector in Settings → Connectors. Paste this address and sign in."
          : "In ChatGPT on the web, create an app in Settings → Apps. Paste this address and sign in."}
      </p>
      <CopyField
        label="MCP endpoint"
        value={connection.remoteMcpUrl}
        onCopied={() => toast.success("Copied")}
      />
    </div>
  )
}

function CloudManualInstallPanel({
  connection,
}: {
  connection: ConnectionInfo
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Add this address as a custom connector or MCP server, then sign in.
      </p>
      <CopyField
        label="MCP endpoint"
        value={connection.remoteMcpUrl}
        onCopied={() => toast.success("Copied")}
      />
    </div>
  )
}

// ── Local/self-hosted setup disclosures ─────────────────────────────────────

type AgentSetupCategoryId = keyof typeof AGENT_SETUP_CATEGORIES | "manual"
type AlwaysOnChoice = AlwaysOnAgent["adapter"] | "grok-bot"

function AgentSetupGroup({ connection }: { connection: ConnectionInfo }) {
  const active = useSettingsSectionActive()
  const cloud = connection.mcpAuthMode === "oauth"
  const [open, setOpen] = useState<AgentSetupCategoryId | null>(null)
  const [provider, setProvider] = useState<AlwaysOnChoice>("openclaw")
  const [visited, setVisited] = useState<AlwaysOnChoice[]>(["openclaw"])
  const categoryProps = (id: keyof typeof AGENT_SETUP_CATEGORIES) => ({
    ...AGENT_SETUP_CATEGORIES[id],
    open: open === id,
    onOpenChange: (next: boolean) => setOpen(next ? id : null),
    keepMounted: true,
  })
  return (
    <section aria-label="Agent connections">
      <div className="overflow-hidden rounded-xl card-surface">
        <AgentSetupCategory {...categoryProps("code")}>
          {cloud ? (
            <CloudQuickConnectPanel connection={connection} />
          ) : (
            <QuickConnectPanel connection={connection} />
          )}
        </AgentSetupCategory>
        <AgentSetupCategory {...categoryProps("chat")}>
          {cloud ? (
            <CloudNativeAppsPanel connection={connection} />
          ) : (
            <DesktopAppsPanel connection={connection} />
          )}
        </AgentSetupCategory>
        <AgentSetupCategory {...categoryProps("always")}>
          <AgentSetupTabs
            value={provider}
            onValueChange={(value) => {
              setProvider(value)
              setVisited((previous) =>
                previous.includes(value) ? previous : [...previous, value]
              )
            }}
            options={AGENT_SETUP_CATEGORIES.always.platforms.map(
              (platform) => ({
                value: platform as AlwaysOnChoice,
                label: AGENT_PLATFORMS[platform].name,
                platform,
              })
            )}
          />
          {visited.map((value) => (
            <div key={value} hidden={provider !== value}>
              {value === "grok-bot" ? (
                <GrokBotSetupPanel
                  connection={connection}
                  open={active && open === "always" && provider === value}
                />
              ) : (
                (() => {
                  const agent = ALWAYS_ON_AGENTS.find(
                    (agent) => agent.adapter === value
                  )!
                  return cloud && !connection.agentPairing ? (
                    <CloudAlwaysOnPanel connection={connection} agent={agent} />
                  ) : (
                    <AlwaysOnSetupPanel connection={connection} agent={agent} />
                  )
                })()
              )}
            </div>
          ))}
        </AgentSetupCategory>
      </div>
      <Collapsible
        open={open === "manual"}
        onOpenChange={(next) => setOpen(next ? "manual" : null)}
      >
        <CollapsibleTrigger className="mt-5 text-sm text-muted-foreground hover:text-foreground">
          Using something else?{" "}
          <span className="text-primary-text">Connect any MCP agent</span>
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <div className="pt-4">
            {cloud ? (
              <CloudManualInstallPanel connection={connection} />
            ) : (
              <ManualInstallPanel connection={connection} />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
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

function AlwaysOnSetupPanel({
  connection,
  agent,
}: {
  connection: ConnectionInfo
  agent: AlwaysOnAgent
}) {
  const sectionActive = useSettingsSectionActive()
  const queryClient = useQueryClient()
  const [participantName, setParticipantName] = useState(agent.name)
  const [access, setAccess] = useState<AgentAccess>(DEFAULT_AGENT_ACCESS)
  const [pairing, setPairing] = useState<PairingCreated | null>(null)
  const installCopy = useCopy(() => toast.success("Copied"))

  const create = useMutation({
    mutationFn: () =>
      createPairing({
        target: {
          kind: "agent-adapter",
          adapter: agent.adapter,
          participantName: participantName.trim(),
        },
        access,
      }),
    onSuccess: setPairing,
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : `Couldn’t create a ${agent.name} pairing.`
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
  useEffect(() => {
    if (!session?.tokenId) return
    void queryClient.invalidateQueries({ queryKey: ["tokens"] })
    void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
  }, [session?.tokenId, session?.status, queryClient])

  const command = pairing
    ? agent.localConnectCommand(pairing.serverOrigin, pairing.code)
    : null

  return (
    <div className="flex flex-col gap-4">
      <AlwaysOnSteps
        agent={agent}
        connectInstruction="Select Connect, then run the generated command."
      />

      <div className="max-w-sm">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">
            Agent name
          </span>
          <Input
            value={participantName}
            maxLength={100}
            onChange={(event) => {
              setParticipantName(event.target.value)
              setPairing(null)
            }}
            placeholder={agent.name}
            disabled={create.isPending}
          />
        </label>
      </div>

      <AgentAccessFields
        value={access}
        onChange={(next) => {
          setAccess(next)
          setPairing(null)
        }}
        alwaysOn
        disabled={create.isPending}
      />

      <RemoteAgentOriginWarning connection={connection} />

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => void installCopy.copy(agent.installCommand)}
        >
          <Copy className="size-4" aria-hidden />
          {installCopy.copied ? "Copied" : "Install"}
        </Button>
        {!pairing ? (
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || !participantName.trim()}
          >
            {create.isPending ? "Connecting…" : "Connect"}
          </Button>
        ) : null}
      </div>

      {pairing ? (
        <>
          {command && (
            <Snippet code={command} onCopied={() => toast.success("Copied")} />
          )}
          <p className="text-sm leading-5 text-muted-foreground">
            One use. Expires in 15 minutes.
          </p>
          <AlwaysOnPairingStatus agent={agent} session={session} />
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => create.mutate()}
              disabled={create.isPending}
            >
              New command
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}

function AlwaysOnSteps({
  agent,
  connectInstruction,
}: {
  agent: AlwaysOnAgent
  connectInstruction: string
}) {
  const restart = (
    <li>
      Restart the Gateway
      {agent.restartBeforeConnect ? " if it doesn’t restart automatically" : ""}
      :{" "}
      <code className="inline-code-accent font-mono">
        {agent.restartCommand}
      </code>
      .
    </li>
  )
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-foreground/60">
      <li>Select Install, then run the copied command.</li>
      {agent.restartBeforeConnect ? restart : null}
      <li>{connectInstruction}</li>
      {agent.restartBeforeConnect ? null : restart}
    </ol>
  )
}

function AlwaysOnPairingStatus({
  agent,
  session,
}: {
  agent: AlwaysOnAgent
  session: PairingSession | undefined
}) {
  if (!session || session.status === "pending") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Waiting for {agent.name}…
      </div>
    )
  }
  if (session.status === "expired") {
    return (
      <Callout variant="warning">
        This code expired before {agent.name} redeemed it.
      </Callout>
    )
  }
  if (session.status === "verified") {
    return (
      <Callout variant="success">
        Connected
        {session.redeemedBy?.hostname
          ? ` on ${session.redeemedBy.hostname}`
          : ""}
        .
      </Callout>
    )
  }
  const failure = latestPairingFailure(session)
  if (failure) {
    return (
      <Callout variant="danger">
        {agent.name} setup failed
        {failure.detail ? `: ${failure.detail}` : "."}
      </Callout>
    )
  }
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      Finishing the connection…
    </div>
  )
}

// ── Desktop apps ------------------------------------------------------------

type DesktopAppChoice = "claude-desktop" | "chatgpt-desktop"

function DesktopAppsPanel({ connection }: { connection: ConnectionInfo }) {
  const queryClient = useQueryClient()
  const [app, setApp] = useState<DesktopAppChoice>("claude-desktop")
  const [claudeToken, setClaudeToken] = useState<string | null>(null)
  const [chatGptToken, setChatGptToken] = useState<string | null>(null)
  const [chosenAccess, setAccess] = useState<AgentAccess | null>(null)

  const { endpoint, needsToken } = desktopAgentConnectionDetails(connection)
  // Connecting an app again is the same agent: start from its access.
  const existing = useQuery({
    queryKey: ["agent-connections", "app", app],
    queryFn: () => getAppAgent(app),
    enabled: needsToken,
  })
  const existingAgent = existing.data?.connection ?? null
  // Until it is known whether the app is already an agent, its access is not:
  // generating then could widen an agent its owner had limited.
  const appKnown = existing.isSuccess
  const access = chosenAccess ?? existingAgent?.access ?? DEFAULT_AGENT_ACCESS

  const afterMint = () => {
    void queryClient.invalidateQueries({ queryKey: ["tokens"] })
    void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
  }
  const mintClaude = useMutation({
    mutationFn: () => connectAgentApp({ client: "claude-desktop", access }),
    onSuccess: (result) => {
      setClaudeToken(result.token)
      afterMint()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn’t generate the Claude Desktop token."
      ),
  })
  const mintChatGpt = useMutation({
    mutationFn: () => connectAgentApp({ client: "chatgpt-desktop", access }),
    onSuccess: (result) => {
      setChatGptToken(result.token)
      afterMint()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn’t generate the ChatGPT token."
      ),
  })
  const copied = () => toast.success("Copied")

  return (
    <div className="flex flex-col gap-4">
      <AgentSetupTabs
        value={app}
        onValueChange={(value) => {
          setApp(value)
          setAccess(null)
        }}
        options={[
          { value: "claude-desktop", label: "Claude", platform: "claude" },
          { value: "chatgpt-desktop", label: "ChatGPT", platform: "chatgpt" },
        ]}
      />

      {app === "claude-desktop" ? (
        <article className="flex flex-col gap-4">
          <div>
            <a
              href="/integrations/claude-desktop.mcpb"
              download="worktable-claude-desktop.mcpb"
              className={buttonVariants()}
            >
              <Download className="size-4" aria-hidden />
              Download extension
            </a>
          </div>

          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-foreground/60">
            <li>Download and open the extension, then approve installation.</li>
            <li>Paste the MCP endpoint shown below.</li>
            <li>
              {needsToken
                ? "Generate an access token and paste it into the extension."
                : "Leave the optional access token blank for this same-machine connection."}
            </li>
            <li>Restart Claude, then ask it to list the Worktable tools.</li>
          </ol>

          <CopyField label="MCP endpoint" value={endpoint} onCopied={copied} />

          {needsToken ? (
            claudeToken ? (
              <div className="flex flex-col gap-2">
                <SecretReveal secret={claudeToken} onCopied={copied} />
                <Callout variant="info">
                  This token is shown once. Updating or revoking it requires
                  replacing the value in Claude Desktop.
                </Callout>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <AgentAccessFields
                  value={access}
                  onChange={setAccess}
                  disabled={mintClaude.isPending || !appKnown}
                />
                {existing.isError ? (
                  <Callout variant="danger">
                    Couldn’t check whether this app is already connected.{" "}
                    <button
                      type="button"
                      className="font-medium underline underline-offset-2"
                      onClick={() => void existing.refetch()}
                    >
                      Try again
                    </button>
                  </Callout>
                ) : null}
                {existingAgent ? (
                  <p className="text-xs text-muted-foreground">
                    Already connected as {existingAgent.displayName}. A new
                    token joins it.
                  </p>
                ) : null}
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => mintClaude.mutate()}
                    disabled={
                      mintClaude.isPending ||
                      !appKnown ||
                      !(access.threads || access.read || access.edit)
                    }
                  >
                    {mintClaude.isPending
                      ? "Generating…"
                      : "Generate Claude access token"}
                  </Button>
                </div>
              </div>
            )
          ) : null}
        </article>
      ) : (
        <article className="flex flex-col gap-4">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-foreground/60">
            <li>Open ChatGPT Settings → MCP servers.</li>
            <li>Select Add server and name it Worktable.</li>
            <li>Choose Streamable HTTP and paste the endpoint below.</li>
            {needsToken ? (
              <li>Generate and supply the bearer token shown here.</li>
            ) : null}
            <li>Save, restart, and type /mcp to verify Worktable.</li>
          </ol>

          <CopyField label="MCP endpoint" value={endpoint} onCopied={copied} />

          {needsToken ? (
            chatGptToken ? (
              <div className="flex flex-col gap-2">
                <SecretReveal secret={chatGptToken} onCopied={copied} />
                <Callout variant="info">
                  This token is shown once. Revoke it under Connections and
                  replace it in ChatGPT when needed.
                </Callout>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <AgentAccessFields
                  value={access}
                  onChange={setAccess}
                  disabled={mintChatGpt.isPending || !appKnown}
                />
                {existing.isError ? (
                  <Callout variant="danger">
                    Couldn’t check whether this app is already connected.{" "}
                    <button
                      type="button"
                      className="font-medium underline underline-offset-2"
                      onClick={() => void existing.refetch()}
                    >
                      Try again
                    </button>
                  </Callout>
                ) : null}
                {existingAgent ? (
                  <p className="text-xs text-muted-foreground">
                    Already connected as {existingAgent.displayName}. A new
                    token joins it.
                  </p>
                ) : null}
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => mintChatGpt.mutate()}
                    disabled={
                      mintChatGpt.isPending ||
                      !appKnown ||
                      !(access.threads || access.read || access.edit)
                    }
                  >
                    {mintChatGpt.isPending
                      ? "Generating…"
                      : "Generate ChatGPT access token"}
                  </Button>
                </div>
              </div>
            )
          ) : null}

          <Callout variant="info">
            Codex and ChatGPT share MCP settings. Already connected in Codex?
            Restart ChatGPT.
          </Callout>
        </article>
      )}
    </div>
  )
}

// ── Manual setup (fallback for locked-down machines) ─────────────────────────

function ManualInstallPanel({ connection }: { connection: ConnectionInfo }) {
  const queryClient = useQueryClient()
  const [access, setAccess] = useState<AgentAccess>(DEFAULT_AGENT_ACCESS)
  // Keep the one-time secret in this mounted panel, never in persisted state.
  const [token, setToken] = useState<string | null>(null)
  const mint = useMutation({
    mutationFn: () =>
      mintToken({ scopes: scopesForAccess(access), agent: "My agent" }),
    onSuccess: (result) => {
      setToken(result.token)
      void queryClient.invalidateQueries({ queryKey: ["tokens"] })
      void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn’t create an access token."
      ),
  })
  const endpoint = desktopAgentConnectionDetails(connection).endpoint
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Add Worktable to your agent as an MCP server with this address and an
        access token.
      </p>
      <CopyField label="MCP endpoint" value={endpoint} />
      {token ? (
        <>
          <Callout variant="info">
            Copy the token now. It isn’t shown again.
          </Callout>
          <CopyField label="Access token" value={token} />
        </>
      ) : (
        <>
          <AgentAccessFields
            value={access}
            onChange={setAccess}
            disabled={mint.isPending}
          />
          <div>
            <Button
              variant="outline"
              disabled={
                mint.isPending ||
                !(access.threads || access.read || access.edit)
              }
              onClick={() => mint.mutate()}
            >
              {mint.isPending ? "Creating…" : "Create access token"}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Connected agents ---------------------------------------------------------

/** The agent's one name; Cloud's inventory still reports it beside a platform label. */
function agentConnectionName(connection: AgentConnection): string {
  // This Worktable reports each of its agents under its canonical name.
  if (connection.authKind === "local-token") return connection.displayName
  return (
    connection.participant?.name ??
    (connection.target.kind === "agent-adapter"
      ? connection.target.participantName
      : undefined) ??
    clientDisplayName(connection.displayName)
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
      const cleaned = grok
        ? await fetchJSON(
            `/api/grok-bot/${encodeURIComponent(grok.connectionId)}/configuration?scope=workspace`,
            { method: "DELETE" }
          ).then(
            () => true,
            () => false
          )
        : true
      const result = await disconnectAgentConnection(id)
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
  const oauthInventoryUnavailable =
    (connectionsQuery.data?.unavailableAuthKinds?.length ?? 0) > 0
  return (
    <section className="flex flex-col gap-3" aria-labelledby="connected-agents">
      <h3 id="connected-agents" className="text-sm font-medium text-foreground">
        Connected agents
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
                return (
                  <li
                    key={connection?.id ?? grok!.connectionId}
                    className="flex min-h-14 items-center gap-3 rounded-xl bg-surface-inset px-3 py-2"
                  >
                    <AgentAvatar
                      name={name}
                      platform={platform}
                      icon={connection?.icon}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {name}
                        </span>
                        <Badge variant="secondary">
                          {grok || connection?.mode === "always-on"
                            ? "Always-on"
                            : "On-demand"}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {platform !== "other" && platformName !== name
                          ? `${platformName} · `
                          : ""}
                        {connection?.machine ? `${connection.machine} · ` : ""}
                        {grok
                          ? GROK_BOT_STATUS_LABELS[grok.status]
                          : connection?.lastSeenAt
                            ? `Last seen ${timeAgo(connection.lastSeenAt)}`
                            : "Not used yet"}
                      </p>
                    </div>
                    {connection?.canManage !== false &&
                    (grok ||
                      connection?.authKind === "local-token" ||
                      (connection?.authKind === "oauth" &&
                        connection.access)) ? (
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
                    {connection && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={
                          disconnect.isPending || connection.canManage === false
                        }
                        onClick={() => disconnect.mutate(connection.id)}
                      >
                        Disconnect
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
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
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
  { key: "annotations", label: "Annotations" },
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
