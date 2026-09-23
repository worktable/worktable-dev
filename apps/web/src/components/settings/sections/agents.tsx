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
  DEFAULT_AGENT_TOKEN_SCOPES,
  CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  MCP_CLIENTS,
  MCP_SNIPPET_CLIENT_IDS,
  mcpClientSnippet,
  type AgentConnection,
  type ConnectorInstallableMcpClientId,
  type McpSnippetClientId,
} from "@worktable/types"
import { Button, buttonVariants } from "@worktable/ui/components/button"
import { Badge } from "@worktable/ui/components/badge"
import { Callout } from "@worktable/ui/components/callout"
import { Card, CardContent } from "@worktable/ui/components/card"
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
  disconnectAgentConnection,
  listAgentConnections,
} from "@/lib/agent-connections-api"
import { timeAgo } from "@/lib/time"
import { DesktopAgentSkillsGroup } from "./desktop-agent-skills"
import { useSettingsSectionActive } from "../settings-dialog"

const CLIENT_KEY = "worktable-connect-client"
const DEFAULT_CLIENT: McpSnippetClientId = "claude-code"

// The scopes a "Connect an agent" token grants — everything an interactive agent
// needs, minus token management (the shared agent-token scope set).
const CONNECT_SCOPES = [...DEFAULT_AGENT_TOKEN_SCOPES]

const CLIENT_OPTIONS = MCP_SNIPPET_CLIENT_IDS.map((id) => MCP_CLIENTS[id])

function readStoredClient(): McpSnippetClientId {
  try {
    const stored = localStorage.getItem(CLIENT_KEY)
    if (
      stored &&
      MCP_SNIPPET_CLIENT_IDS.includes(stored as McpSnippetClientId)
    ) {
      return stored as McpSnippetClientId
    }
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return DEFAULT_CLIENT
}

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
        <CloudAgentSetupGroup connection={connectionQuery.data} />
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
      <AccessTokensGroup />
    </div>
  )
}

type CloudAgentSetupPanel = "quick" | "always-on" | "desktop" | "manual"

function CloudAgentSetupGroup({ connection }: { connection: ConnectionInfo }) {
  const [openPanel, setOpenPanel] = useState<CloudAgentSetupPanel | null>(
    "quick"
  )

  function panelProps(panel: CloudAgentSetupPanel) {
    return {
      open: openPanel === panel,
      onOpenChange: (open: boolean) => setOpenPanel(open ? panel : null),
    }
  }

  return (
    <section aria-label="Agent connections">
      <Card className="gap-0 py-0">
        <AgentSetupDisclosure title="Coding agents" {...panelProps("quick")}>
          <CloudQuickConnectPanel connection={connection} />
        </AgentSetupDisclosure>
        <AgentSetupDisclosure
          title="OpenClaw"
          className="border-t border-border/60"
          {...panelProps("always-on")}
        >
          <CloudOpenClawPanel connection={connection} />
        </AgentSetupDisclosure>
        <AgentSetupDisclosure
          title="Claude and ChatGPT"
          className="border-t border-border/60"
          {...panelProps("desktop")}
        >
          <CloudNativeAppsPanel connection={connection} />
        </AgentSetupDisclosure>
        <AgentSetupDisclosure
          title="Manual setup"
          className="border-t border-border/60"
          {...panelProps("manual")}
        >
          <CloudManualInstallPanel connection={connection} />
        </AgentSetupDisclosure>
      </Card>
    </section>
  )
}

function CloudQuickConnectPanel({
  connection,
}: {
  connection: ConnectionInfo
}) {
  const [clientChoice, setClientChoice] = useState<RemoteClientChoice>("auto")
  const origin = new URL(connection.remoteMcpUrl).origin
  const command = [
    `curl -fsSL ${origin}/connect.sh | sh -s --`,
    "--oauth",
    `--server ${origin}`,
    clientChoice === "auto" ? "" : `--client ${clientChoice}`,
  ]
    .filter(Boolean)
    .join(" ")
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

function CloudOpenClawPanel({ connection }: { connection: ConnectionInfo }) {
  const origin = new URL(connection.remoteMcpUrl).origin
  const install =
    "openclaw plugins install https://github.com/worktable/worktable-dev/releases/latest/download/worktable-openclaw.tgz --pin"
  const connect = `openclaw worktable connect --server ${origin} --agent-registration`
  const installCopy = useCopy(() => toast.success("Copied"))
  const connectCopy = useCopy(() => toast.success("Copied"))
  return (
    <div className="flex flex-col gap-4">
      <OpenClawSteps connectInstruction="Select Connect, then run the copied command." />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => void installCopy.copy(install)}
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
  return (
    <div>
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
  const [clientId, setClientId] = useState<McpSnippetClientId>(readStoredClient)

  useEffect(() => {
    try {
      localStorage.setItem(CLIENT_KEY, clientId)
    } catch {
      // Best-effort persistence.
    }
  }, [clientId])

  const meta = MCP_CLIENTS[clientId]
  const snippet = mcpClientSnippet(clientId, {
    endpoint: connection.remoteMcpUrl,
  })
  const pasteCaption = meta.configPathHint
    ? `Paste into ${meta.configPathHint}`
    : ""
  const copied = () => toast.success("Copied")

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium tracking-wide text-foreground/70">
          Client
        </span>
        <Select
          value={clientId}
          onValueChange={(value) => setClientId(value as McpSnippetClientId)}
        >
          <SelectTrigger aria-label="Cloud agent" className="w-full sm:w-64">
            <SelectValue>{meta.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {CLIENT_OPTIONS.map((client) => (
              <SelectItem key={client.id} value={client.id}>
                {client.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Snippet code={snippet.body} onCopied={copied} />
      <p className="text-xs text-muted-foreground">{pasteCaption}</p>

      <CopyField
        label="MCP endpoint"
        value={connection.remoteMcpUrl}
        onCopied={copied}
      />
    </div>
  )
}

// ── Local/self-hosted setup disclosures ─────────────────────────────────────

type AgentSetupPanel = "quick" | "always-on" | "desktop" | "manual"

function AgentSetupGroup({ connection }: { connection: ConnectionInfo }) {
  const [openPanel, setOpenPanel] = useState<AgentSetupPanel | null>("quick")

  function panelProps(panel: AgentSetupPanel) {
    return {
      open: openPanel === panel,
      onOpenChange: (open: boolean) => setOpenPanel(open ? panel : null),
    }
  }

  return (
    <section aria-label="Agent connections">
      <Card className="gap-0 py-0">
        <AgentSetupDisclosure title="Coding agents" {...panelProps("quick")}>
          <QuickConnectPanel connection={connection} />
        </AgentSetupDisclosure>

        <AgentSetupDisclosure
          title="OpenClaw"
          className="border-t border-border/60"
          {...panelProps("always-on")}
        >
          <OpenClawSetupPanel connection={connection} />
        </AgentSetupDisclosure>

        <AgentSetupDisclosure
          title="Claude and ChatGPT"
          className="border-t border-border/60"
          {...panelProps("desktop")}
        >
          <DesktopAppsPanel connection={connection} />
        </AgentSetupDisclosure>

        <AgentSetupDisclosure
          title="Manual setup"
          className="border-t border-border/60"
          {...panelProps("manual")}
        >
          <ManualInstallPanel connection={connection} />
        </AgentSetupDisclosure>
      </Card>
    </section>
  )
}

function AgentSetupDisclosure({
  title,
  open,
  onOpenChange,
  className,
  children,
}: {
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
  children: ReactNode
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={className}>
      <CollapsibleTrigger className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left transition-colors outline-none hover:bg-muted/30 focus-visible:ring-3 focus-visible:ring-ring/50">
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
          {title}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
          aria-hidden
        />
      </CollapsibleTrigger>
      {/* Setup can hold a live pairing or a one-time token. Switching panels
          must hide, not destroy, that in-progress state. */}
      <CollapsibleContent keepMounted>
        <div className="border-t border-border/60 px-4 py-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
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
    <p className="text-xs text-muted-foreground">
      Agents on another computer require a Worktable URL in Settings → General.
    </p>
  )
}

function QuickConnectPanel({ connection }: { connection: ConnectionInfo }) {
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

  const create = useMutation({
    mutationFn: () =>
      createPairing({
        client: clientChoice === "auto" ? null : clientChoice,
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
        <span className="text-xs font-medium tracking-wide text-foreground/70">
          Agent
        </span>
        <Select
          value={clientChoice}
          onValueChange={(value) => {
            setClientChoice(value as RemoteClientChoice)
            setPairing(null)
            create.reset()
          }}
        >
          <SelectTrigger className="w-full sm:w-64">
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

      <RemoteAgentOriginWarning connection={connection} />

      {!pairing ? (
        <div>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? "Connecting…" : "Connect"}
          </Button>
        </div>
      ) : (
        <>
          {command ? <Snippet code={command} onCopied={copied} /> : null}
          <p className="text-xs text-muted-foreground">
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

function OpenClawSetupPanel({ connection }: { connection: ConnectionInfo }) {
  const sectionActive = useSettingsSectionActive()
  const queryClient = useQueryClient()
  const [participantName, setParticipantName] = useState("OpenClaw")
  const [pairing, setPairing] = useState<PairingCreated | null>(null)
  const install =
    "openclaw plugins install https://github.com/worktable/worktable-dev/releases/latest/download/worktable-openclaw.tgz --pin"
  const installCopy = useCopy(() => toast.success("Copied"))

  const create = useMutation({
    mutationFn: () =>
      createPairing({
        target: {
          kind: "agent-adapter",
          adapter: "openclaw",
          participantName: participantName.trim(),
        },
      }),
    onSuccess: setPairing,
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn’t create an OpenClaw pairing."
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
    ? `openclaw worktable connect --server ${pairing.serverOrigin} --pairing-code ${pairing.code}`
    : null

  return (
    <div className="flex flex-col gap-4">
      <OpenClawSteps connectInstruction="Select Connect, then run the generated command." />

      <div className="max-w-sm">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium tracking-wide text-foreground/70">
            Agent name
          </span>
          <Input
            value={participantName}
            maxLength={100}
            onChange={(event) => {
              setParticipantName(event.target.value)
              setPairing(null)
            }}
            placeholder="OpenClaw"
          />
        </label>
      </div>

      <RemoteAgentOriginWarning connection={connection} />

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => void installCopy.copy(install)}
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
          <p className="text-xs leading-5 text-muted-foreground">
            One use. Expires in 15 minutes.
          </p>
          <OpenClawPairingStatus session={session} />
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

function OpenClawSteps({ connectInstruction }: { connectInstruction: string }) {
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-foreground/60">
      <li>Select Install, then run the copied command.</li>
      <li>
        Restart the Gateway if it doesn&rsquo;t restart automatically:{" "}
        <code className="inline-code-accent font-mono">
          openclaw gateway restart
        </code>
        .
      </li>
      <li>{connectInstruction}</li>
    </ol>
  )
}

function OpenClawPairingStatus({
  session,
}: {
  session: PairingSession | undefined
}) {
  if (!session || session.status === "pending") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Waiting for OpenClaw…
      </div>
    )
  }
  if (session.status === "expired") {
    return (
      <Callout variant="warning">
        This code expired before OpenClaw redeemed it.
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
        OpenClaw setup failed
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

  const { endpoint, needsToken } = desktopAgentConnectionDetails(connection)

  const afterMint = () => {
    void queryClient.invalidateQueries({ queryKey: ["tokens"] })
  }
  const mintClaude = useMutation({
    mutationFn: () =>
      mintToken({ scopes: CONNECT_SCOPES, agent: "claude-desktop" }),
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
    mutationFn: () => mintToken({ scopes: CONNECT_SCOPES, agent: "codex" }),
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
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium tracking-wide text-foreground/70">
          Desktop app
        </span>
        <Select
          value={app}
          onValueChange={(value) => setApp(value as DesktopAppChoice)}
        >
          <SelectTrigger aria-label="Desktop app" className="w-full sm:w-64">
            <SelectValue>
              {app === "claude-desktop" ? "Claude Desktop" : "ChatGPT desktop"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude-desktop">Claude Desktop</SelectItem>
            <SelectItem value="chatgpt-desktop">ChatGPT desktop</SelectItem>
          </SelectContent>
        </Select>
      </div>

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
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => mintClaude.mutate()}
                  disabled={mintClaude.isPending}
                >
                  {mintClaude.isPending
                    ? "Generating…"
                    : "Generate Claude access token"}
                </Button>
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
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => mintChatGpt.mutate()}
                  disabled={mintChatGpt.isPending}
                >
                  {mintChatGpt.isPending
                    ? "Generating…"
                    : "Generate ChatGPT access token"}
                </Button>
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

  const [clientId, setClientId] = useState<McpSnippetClientId>(readStoredClient)
  useEffect(() => {
    try {
      localStorage.setItem(CLIENT_KEY, clientId)
    } catch {
      // Best-effort persistence.
    }
  }, [clientId])

  // The minted connection secret lives ONLY in this component's state — never
  // persisted or logged. The shell keeps sections mounted while the dialog is
  // open (so switching sections can't destroy a one-time token) but unmounts
  // everything on close, so the token can't survive a close. Switching client
  // also drops it (it was minted for the prior agent).
  const [token, setToken] = useState<string | null>(null)

  const mint = useMutation({
    mutationFn: () => mintToken({ scopes: CONNECT_SCOPES, agent: clientId }),
    onSuccess: (res) => {
      setToken(res.token)
      // The new bearer must show up (and be revocable) in the table below.
      // Minting does not change literal-loopback MCP's implicit-owner posture.
      void queryClient.invalidateQueries({ queryKey: ["tokens"] })
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Couldn't generate a token."
      ),
  })

  function selectClient(next: McpSnippetClientId) {
    setClientId(next)
    setToken(null)
    mint.reset()
  }

  const meta = MCP_CLIENTS[clientId]
  const pasteCaption = meta.configPathHint
    ? `Paste into ${meta.configPathHint}`
    : "Run in a terminal"

  // A remote agent must reach the install at the user-facing origin, not the
  // loopback endpoint the server advertises for same-machine clients. A
  // configured origin counts too: a loopback install fronted by a tunnel saves
  // a Worktable URL precisely so generated configs point through the tunnel.
  const publicUrlUsed = Boolean(
    connection && (connection.reachable || connection.originConfigured)
  )
  const mcpUrl = connection
    ? publicUrlUsed
      ? connection.remoteMcpUrl
      : connection.endpoint
    : null
  // /mcp needs a bearer when the install is exposed or whenever the snippet
  // points at a PUBLIC URL: a tunnel in front of a
  // tokenless loopback install would otherwise expose the Worktable to anyone
  // who finds the URL. Until one is minted here, render the config in its real
  // shape with a visible placeholder — not the shared module's CLI-facing
  // guidance; the Generate button is right here.
  const needsToken = Boolean(
    connection &&
    (connection.reachable || connection.mcpTokenRequired || publicUrlUsed)
  )
  const placeholderShown = needsToken && !token
  const snippet =
    connection && mcpUrl
      ? mcpClientSnippet(clientId, {
          endpoint: mcpUrl,
          token: token ?? (needsToken ? "<generated-token>" : undefined),
          reachable: connection.reachable,
        })
      : null

  const copied = () => toast.success("Copied")

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium tracking-wide text-foreground/70">
          Client
        </span>
        <Select
          value={clientId}
          onValueChange={(value) => selectClient(value as McpSnippetClientId)}
        >
          <SelectTrigger
            aria-label="Manual setup agent"
            className="w-full sm:w-64"
          >
            <SelectValue>{meta.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {CLIENT_OPTIONS.map((client) => (
              <SelectItem key={client.id} value={client.id}>
                {client.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!snippet ? (
        <p className="text-sm text-muted-foreground">
          Couldn’t read connection info for this install.
        </p>
      ) : (
        <>
          {needsToken && !token ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => mint.mutate()}
                disabled={mint.isPending}
              >
                {mint.isPending ? "Generating…" : "Generate connection token"}
              </Button>
            </div>
          ) : null}

          {token ? (
            <Callout variant="info">
              Copy now. This token is shown once.
            </Callout>
          ) : null}

          <Snippet code={snippet.body} onCopied={copied} />

          <p className="text-xs text-muted-foreground">
            {pasteCaption}
            {placeholderShown &&
              ". Generate a token above to complete this config."}
          </p>

          {!needsToken ? (
            <p className="text-xs text-muted-foreground">
              No token needed on this computer.
            </p>
          ) : !connection.reachable && publicUrlUsed ? (
            <p className="text-xs text-muted-foreground">
              Public URLs require a token.
            </p>
          ) : !connection.reachable && connection.mcpTokenRequired ? (
            <p className="text-xs text-muted-foreground">
              This Worktable requires a token.
            </p>
          ) : null}

          <CopyField
            label="MCP endpoint"
            value={mcpUrl ?? connection.endpoint}
            onCopied={copied}
          />
        </>
      )}
    </div>
  )
}

// ── Connected agents ---------------------------------------------------------

function agentConnectionName(connection: AgentConnection): string {
  return clientDisplayName(connection.displayName)
}

export function ConnectedAgentsGroup() {
  const sectionActive = useSettingsSectionActive()
  const queryClient = useQueryClient()
  const connectionsQuery = useQuery({
    queryKey: ["agent-connections"],
    queryFn: listAgentConnections,
    enabled: sectionActive,
  })
  const disconnect = useMutation({
    mutationFn: disconnectAgentConnection,
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

  const connections = connectionsQuery.data?.connections ?? []
  const oauthInventoryUnavailable =
    connectionsQuery.data?.unavailableAuthKinds?.includes("oauth") ?? false
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
          ) : connections.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No agents connected yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {connections.map((connection) => (
                <li
                  key={connection.id}
                  className="flex min-h-14 items-center gap-3 rounded-xl bg-muted/35 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {agentConnectionName(connection)}
                      </span>
                      <Badge variant="secondary">
                        {connection.mode === "always-on"
                          ? "Always-on"
                          : "On-demand"}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {connection.participant?.name
                        ? `${connection.participant.name} · `
                        : ""}
                      {connection.machine ? `${connection.machine} · ` : ""}
                      {connection.lastSeenAt
                        ? `Last seen ${timeAgo(connection.lastSeenAt)}`
                        : "Not used yet"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disconnect.isPending}
                    onClick={() => disconnect.mutate(connection.id)}
                  >
                    Disconnect
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

// ── Advanced access tokens ---------------------------------------------------
//
// Local/self-hosted connection management. Today every row is a local bearer
// token (paired, managed, or hand-minted). Cloud renders its OAuth guide above;
// future Cloud inventory belongs to the stable agent-identity roadmap rather
// than exposing raw authorization grants through this local-token surface.

export function AccessTokensGroup() {
  const queryClient = useQueryClient()
  const sectionActive = useSettingsSectionActive()
  const tokensQuery = useQuery({
    queryKey: ["tokens"],
    queryFn: listTokens,
    enabled: sectionActive,
  })
  const [newOpen, setNewOpen] = useState(false)
  const [disclosure, setDisclosure] = useState({ count: 0, open: false })

  const active = (tokensQuery.data ?? []).filter((t) => t.revokedAt == null)

  // Existing connections should be visible on first load, and a connection
  // created while this section is open should reveal itself. A manual collapse
  // remains respected across ordinary refetches where the count is unchanged.
  if (active.length !== disclosure.count) {
    setDisclosure({
      count: active.length,
      open: active.length > disclosure.count ? true : disclosure.open,
    })
  }
  const open = disclosure.open

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
      <Collapsible
        open={open}
        onOpenChange={(nextOpen) =>
          setDisclosure({ count: active.length, open: nextOpen })
        }
      >
        <Card className="gap-0 py-0">
          <div className="flex min-h-14 items-center gap-2 pr-3">
            <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors outline-none hover:bg-muted/30 focus-visible:ring-3 focus-visible:ring-ring/50">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  Access tokens
                </span>
                <span className="block text-xs text-muted-foreground">
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

      <NewTokenDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onMinted={() => {
          void queryClient.invalidateQueries({ queryKey: ["tokens"] })
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
                    className="text-xs font-medium tracking-wide text-foreground/70"
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
                  <span className="text-xs font-medium tracking-wide text-foreground/70">
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
