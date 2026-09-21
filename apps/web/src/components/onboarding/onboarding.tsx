import { SourceCodeLink } from "@/components/source-code-link"
import {
  CACHED_SYSTEM_VERSION_QUERY_KEY,
  getCachedSystemVersion,
} from "@/lib/system-api"
import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  Laptop,
  Loader2,
  MessageCircle,
  Plug,
  RadioTower,
  UserRound,
} from "lucide-react"
import {
  CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  DEFAULT_AGENT_TOKEN_SCOPES,
  MCP_CLIENTS,
  MCP_SNIPPET_CLIENT_IDS,
  mcpClientSnippet,
  type AgentConnection,
  type ConnectorInstallableMcpClientId,
  type McpSnippetClientId,
  type ParticipantRef,
} from "@worktable/types"
import { Badge } from "@worktable/ui/components/badge"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { Input } from "@worktable/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { toast } from "@worktable/ui/components/sonner"
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { cn } from "@worktable/ui/lib/utils"
import type { WorkspaceInfo } from "@/lib/api"
import { updateWorkspace } from "@/lib/api"
import {
  listAgentConnections,
  renameAgentConnection,
} from "@/lib/agent-connections-api"
import { createClientId } from "@/lib/client-id"
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
  getCurrentUser,
  getUserProfile,
  updateUserProfile,
} from "@/lib/profile"
import { getConnection } from "@/lib/system-api"
import { createThread, listThreadParticipants } from "@/lib/threads-api"
import { listTokens, mintToken } from "@/lib/tokens-api"

type OnboardingStep = "identity" | "connect" | "ready"
type ConnectionMethod = "computer" | "native" | "openclaw" | "other"
type ComputerTarget = ConnectorInstallableMcpClientId | "auto"
type NativeService = "claude" | "chatgpt"

interface SetupRecord {
  id: string
  name: string
  harness: string
  mode: "on-demand" | "always-on"
  verified: boolean
  participantName?: string
  starterThreadKey?: string
}

interface OnboardingDraft {
  step: OnboardingStep
  setups: SetupRecord[]
  threads?: Array<{ setupId: string; id: string; participantName: string }>
}

const OPENCLAW_INSTALL =
  "openclaw plugins install https://github.com/worktable/worktable-dev/releases/latest/download/worktable-openclaw.tgz --pin"
const DEFAULT_DRAFT: OnboardingDraft = { step: "identity", setups: [] }
const AGENT_SCOPES = [...DEFAULT_AGENT_TOKEN_SCOPES]
const STARTER_PROMPTS = [
  {
    label: "Plan a first Space",
    value:
      "Ask me what I’m working on and what I want to accomplish. Then create a Space for it with an Overview note and a useful starting structure.",
  },
  {
    label: "Create a Space",
    value:
      "Create a new Space called [Space name] for [what I’m working on]. Add an Overview note with the goal, useful context, and three next steps.",
  },
] as const
const OPENCLAW_FIRST_MESSAGE =
  "Help me decide what to set up first in Worktable. Ask me about what I’m working on, then suggest a useful first Space and the three notes it should contain."

const CONNECTION_METHODS = [
  {
    id: "computer",
    title: "CLI agents",
    description: "Copy an install command to connect agents on a computer.",
    icon: Laptop,
  },
  {
    id: "native",
    title: "Claude or ChatGPT",
    description: "Add Worktable to a supported web or desktop app.",
    icon: MessageCircle,
  },
  {
    id: "openclaw",
    title: "OpenClaw",
    description: "Pair an always-on agent.",
    icon: RadioTower,
  },
  {
    id: "other",
    title: "Other MCP agent",
    description: "Configure a compatible agent with the Worktable endpoint.",
    icon: Plug,
  },
] as const

function draftKey(workspaceId: string): string {
  return `worktable-onboarding:${workspaceId}`
}

function readDraft(workspaceId: string): OnboardingDraft {
  try {
    const raw = localStorage.getItem(draftKey(workspaceId))
    if (!raw) return DEFAULT_DRAFT
    const value = JSON.parse(raw) as Partial<OnboardingDraft>
    if (!isOnboardingStep(value.step) || !isSetupList(value.setups)) {
      return DEFAULT_DRAFT
    }
    const setups = value.setups.map(ensureStarterThreadKey)
    return {
      step: value.step,
      setups,
      ...(isStarterThreadList(value.threads) ? { threads: value.threads } : {}),
    }
  } catch {
    return DEFAULT_DRAFT
  }
}

function isOnboardingStep(value: unknown): value is OnboardingStep {
  return value === "identity" || value === "connect" || value === "ready"
}

function isSetupList(value: unknown): value is SetupRecord[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as SetupRecord).id === "string" &&
        typeof (item as SetupRecord).name === "string" &&
        typeof (item as SetupRecord).harness === "string" &&
        ["on-demand", "always-on"].includes((item as SetupRecord).mode) &&
        typeof (item as SetupRecord).verified === "boolean" &&
        ((item as SetupRecord).participantName === undefined ||
          typeof (item as SetupRecord).participantName === "string") &&
        ((item as SetupRecord).starterThreadKey === undefined ||
          (typeof (item as SetupRecord).starterThreadKey === "string" &&
            Boolean((item as SetupRecord).starterThreadKey)))
    )
  )
}

function ensureStarterThreadKey(setup: SetupRecord): SetupRecord {
  if (setup.mode !== "always-on" || setup.starterThreadKey) return setup
  return {
    ...setup,
    starterThreadKey: createClientId("onboarding-thread"),
  }
}

function isStarterThreadList(
  value: unknown
): value is NonNullable<OnboardingDraft["threads"]> {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>)["setupId"] === "string" &&
        typeof (item as Record<string, unknown>)["id"] === "string" &&
        typeof (item as Record<string, unknown>)["participantName"] === "string"
    )
  )
}

function usefulName(value: string): string {
  const name = value.trim()
  return ["User", "Owner", "Worktable user"].includes(name) ? "" : name
}

function initialWorktableName(workspace: WorkspaceInfo): string {
  return ["Local Workspace", "My Workspace"].includes(workspace.name)
    ? ""
    : workspace.name
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function StepProgress({ step }: { step: OnboardingStep }) {
  const steps: Array<{ id: OnboardingStep; label: string }> = [
    { id: "identity", label: "Set up" },
    { id: "connect", label: "Connect" },
    { id: "ready", label: "Ready" },
  ]
  const active = steps.findIndex((item) => item.id === step)
  return (
    <ol
      aria-label="Onboarding progress"
      className="mx-auto grid w-full max-w-sm grid-cols-3 gap-2"
    >
      {steps.map((item, index) => (
        <li
          key={item.id}
          aria-current={index === active ? "step" : undefined}
          className="flex flex-col items-center gap-1.5 text-center"
        >
          <span
            className={cn(
              "grid size-7 place-items-center rounded-full border text-xs font-medium",
              index < active &&
                "border-primary bg-primary text-primary-foreground",
              index === active &&
                "border-primary bg-background text-primary shadow-sm",
              index > active && "border-border text-muted-foreground"
            )}
          >
            {index < active ? <Check className="size-3.5" /> : index + 1}
          </span>
          <span
            className={cn(
              "text-xs",
              index === active
                ? "font-medium text-foreground"
                : "text-muted-foreground"
            )}
          >
            {item.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

function StepHeading({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div>
      <div className="mb-5 grid size-11 place-items-center rounded-xl bg-surface-tint text-primary">
        {icon}
      </div>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  )
}

function CopyValue({
  value,
  label,
  wrap = false,
}: {
  value: string
  label: string
  wrap?: boolean
}) {
  const copy = useCopy()
  return (
    <div className="rounded-xl border border-border bg-background p-3.5">
      <div className="flex items-start gap-3">
        <code
          className={cn(
            "min-w-0 flex-1 font-mono text-xs leading-5 text-foreground",
            wrap ? "whitespace-pre-wrap" : "break-all"
          )}
        >
          {value}
        </code>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={copy.copied ? "Copied" : label}
          title={copy.copied ? "Copied" : label}
          onClick={() => void copy.copy(value)}
        >
          {copy.copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  )
}

function PairingProgress({ session }: { session?: PairingSession }) {
  if (!session || session.status === "pending") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Waiting for the command…
      </p>
    )
  }
  if (session.status === "expired") {
    return (
      <Callout variant="warning">
        This command expired. Create a new one.
      </Callout>
    )
  }
  const failed = latestPairingFailure(session)
  const completed = new Set(session.events.map((event) => event.event))
  const steps = [
    ["redeemed", "Command accepted"],
    ["config_written", "Worktable added"],
    ["verified", "Connection verified"],
  ] as const
  return (
    <div className="space-y-3" role="status">
      <ul className="space-y-1.5">
        {steps.map(([event, label]) => (
          <li
            key={event}
            className={cn(
              "flex items-center gap-2 text-sm",
              completed.has(event) ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {completed.has(event) ? (
              <Check className="size-4 text-success" />
            ) : (
              <span className="mx-1 size-2 rounded-full bg-border" />
            )}
            {event === "redeemed" && session.redeemedBy?.hostname
              ? `Command ran on ${session.redeemedBy.hostname}`
              : label}
          </li>
        ))}
      </ul>
      {session.status === "verified" ? (
        <Callout variant="success">Connected.</Callout>
      ) : null}
      {failed ? (
        <Callout variant="danger">
          Connection failed{failed.detail ? `: ${failed.detail}` : "."}
        </Callout>
      ) : null}
    </div>
  )
}

function SetupList({ setups }: { setups: SetupRecord[] }) {
  if (setups.length === 0) return null
  return (
    <section aria-labelledby="onboarding-added-agents" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 id="onboarding-added-agents" className="text-sm font-medium">
          Added agents
        </h2>
        <Badge variant="secondary">{setups.length}</Badge>
      </div>
      <ul className="space-y-2">
        {setups.map((setup) => (
          <li
            key={setup.id}
            className="flex min-h-14 items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-2.5"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-tint text-primary">
              <Bot className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {setup.name}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {setup.harness}
              </span>
            </span>
            <Badge variant="outline">
              {setup.verified
                ? setup.mode === "always-on"
                  ? "Always-on"
                  : "Connected"
                : "Setup added"}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  )
}

function IdentityStep({
  workspace,
  onContinue,
}: {
  workspace: WorkspaceInfo
  onContinue: (workspace: WorkspaceInfo) => void
}) {
  const queryClient = useQueryClient()
  const [userName, setUserName] = useState(() =>
    usefulName(getCurrentUser().name)
  )
  const [worktableName, setWorktableName] = useState(() =>
    initialWorktableName(workspace)
  )
  const [profileTouched, setProfileTouched] = useState(false)
  const profile = useQuery({ queryKey: ["profile"], queryFn: getUserProfile })
  const displayedUserName = profileTouched
    ? userName
    : usefulName(profile.data?.name ?? userName)

  const save = useMutation({
    mutationFn: async () => {
      const updated = await updateWorkspace({ name: worktableName.trim() })
      await updateUserProfile(displayedUserName.trim())
      return updated
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["workspace"], updated)
      onContinue(updated)
    },
  })

  return (
    <>
      <StepHeading
        icon={<UserRound className="size-5" />}
        title="Set up your Worktable"
        description="Choose the names that identify you and this Worktable."
      />
      <div className="mt-7 space-y-5">
        <div className="space-y-1.5">
          <label htmlFor="onboarding-user-name" className="text-sm font-medium">
            Your name
          </label>
          <Input
            id="onboarding-user-name"
            value={displayedUserName}
            maxLength={100}
            autoComplete="name"
            autoFocus
            placeholder="Your name"
            onChange={(event) => {
              setProfileTouched(true)
              setUserName(event.target.value)
            }}
          />
          <p className="text-xs text-muted-foreground">
            Shown on your comments and Threads.
          </p>
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="onboarding-worktable-name"
            className="text-sm font-medium"
          >
            Worktable name
          </label>
          <Input
            id="onboarding-worktable-name"
            value={worktableName}
            maxLength={200}
            placeholder="Worktable name"
            onChange={(event) => setWorktableName(event.target.value)}
          />
        </div>
        {save.isError ? (
          <Callout variant="danger">
            {save.error instanceof Error
              ? save.error.message
              : "Couldn’t save these names."}
          </Callout>
        ) : null}
      </div>
      <div className="mt-8 flex justify-end">
        <Button
          disabled={
            save.isPending || !displayedUserName.trim() || !worktableName.trim()
          }
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Continue"}
        </Button>
      </div>
    </>
  )
}

function AgentNameField({
  value,
  onChange,
  placeholder,
  disabled = false,
  label = "Agent name",
  description = "Include the app or computer if that will help you recognize it later.",
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
  label?: string
  description?: string
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor="onboarding-agent-name" className="text-sm font-medium">
        {label}
      </label>
      <Input
        id="onboarding-agent-name"
        value={value}
        maxLength={100}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

function CloudCandidates({
  connections,
  baseline,
  method,
  name,
  onUse,
  pending,
  onRefresh,
}: {
  connections: AgentConnection[]
  baseline: Set<string>
  method: ConnectionMethod
  name: string
  onUse: (connection: AgentConnection) => void
  pending: boolean
  onRefresh: () => void
}) {
  const candidates = connections.filter((connection) =>
    method === "openclaw"
      ? connection.target.kind === "agent-adapter" &&
        connection.target.adapter === "openclaw"
      : connection.authKind === "oauth"
  )
  const ordered = [...candidates].sort(
    (a, b) => Number(baseline.has(a.id)) - Number(baseline.has(b.id))
  )
  return (
    <div className="space-y-3">
      {ordered.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Waiting for the agent to
          connect…
        </p>
      ) : (
        <ul className="space-y-2">
          {ordered.map((connection) => (
            <li
              key={connection.id}
              className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {connection.displayName}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {baseline.has(connection.id)
                    ? "Already connected"
                    : "New connection"}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !name.trim()}
                onClick={() => onUse(connection)}
              >
                Use this
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" size="sm" onClick={onRefresh}>
        Check again
      </Button>
    </div>
  )
}

function ConnectStep({
  setups,
  onSetupsChange,
  onContinue,
  onBack,
}: {
  setups: SetupRecord[]
  onSetupsChange: (setups: SetupRecord[]) => void
  onContinue: () => void
  onBack: () => void
}) {
  const queryClient = useQueryClient()
  const [method, setMethod] = useState<ConnectionMethod | null>(null)
  const [computerTarget, setComputerTarget] = useState<ComputerTarget>("auto")
  const [nativeService, setNativeService] = useState<NativeService>("claude")
  const [manualClient, setManualClient] = useState<McpSnippetClientId>("goose")
  const [agentName, setAgentName] = useState("")
  const [pairing, setPairing] = useState<PairingCreated | null>(null)
  const [token, setToken] = useState<{
    value: string
    id: string
  } | null>(null)
  const [cloudComplete, setCloudComplete] = useState(false)
  const [baseline, setBaseline] = useState<Set<string>>(new Set())

  const connection = useQuery({
    queryKey: ["system", "connection"],
    queryFn: getConnection,
    staleTime: 30_000,
  })
  const connections = useQuery({
    queryKey: ["agent-connections"],
    queryFn: listAgentConnections,
    refetchInterval:
      method && connection.data?.mcpAuthMode === "oauth" ? 3_000 : false,
  })
  const tokens = useQuery({
    queryKey: ["tokens"],
    queryFn: listTokens,
    enabled: Boolean(token),
    refetchInterval: token ? 3_000 : false,
  })
  const pairingStatus = useQuery({
    queryKey: ["pairing", pairing?.id],
    queryFn: () => getPairing(pairing!.id),
    enabled: Boolean(pairing),
    refetchInterval: (query) =>
      shouldPollPairing(query.state.data) ? 2_000 : false,
  })
  const isCloud = connection.data?.mcpAuthMode === "oauth"

  const create = useMutation({
    mutationFn: () => {
      if (method === "openclaw") {
        return createPairing({
          target: {
            kind: "agent-adapter",
            adapter: "openclaw",
            participantName: agentName.trim(),
          },
        })
      }
      return createPairing({
        client: computerTarget === "auto" ? null : computerTarget,
        displayName: agentName.trim(),
      })
    },
    onSuccess: setPairing,
  })
  const mint = useMutation({
    mutationFn: () =>
      mintToken({ scopes: AGENT_SCOPES, agent: agentName.trim() }),
    onSuccess: (result) => {
      setToken({ value: result.token, id: result.metadata.id })
      void queryClient.invalidateQueries({ queryKey: ["tokens"] })
    },
  })
  const useCloudConnection = useMutation({
    mutationFn: async (selected: AgentConnection) => {
      await renameAgentConnection(selected.id, agentName.trim())
      return selected
    },
    onSuccess: (selected) => {
      const isOpenClaw = method === "openclaw"
      addSetup({
        id: selected.id,
        name: agentName.trim(),
        harness: isOpenClaw ? "OpenClaw" : selected.displayName || "MCP agent",
        mode: isOpenClaw ? "always-on" : "on-demand",
        verified: true,
        ...(isOpenClaw
          ? {
              participantName:
                selected.target.kind === "agent-adapter"
                  ? (selected.target.participantName ?? agentName.trim())
                  : agentName.trim(),
            }
          : {}),
      })
      setCloudComplete(true)
      void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    },
  })

  const session = pairingStatus.data
  const localVerified = session?.status === "verified"
  const tokenUsed = Boolean(
    token && tokens.data?.find((item) => item.id === token.id)?.lastUsedAt
  )

  useEffect(() => {
    if (!localVerified || !pairing || !method) return
    addSetup({
      id: `pairing:${pairing.id}`,
      name: agentName.trim(),
      harness:
        method === "openclaw"
          ? "OpenClaw"
          : computerTarget === "auto"
            ? "CLI agents on one computer"
            : MCP_CLIENTS[computerTarget].label,
      mode: method === "openclaw" ? "always-on" : "on-demand",
      verified: true,
      ...(method === "openclaw" ? { participantName: agentName.trim() } : {}),
    })
    void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    void queryClient.invalidateQueries({ queryKey: ["tokens"] })
    // Only the terminal transition should add a setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localVerified, pairing?.id])

  useEffect(() => {
    if (!tokenUsed || !token || !method) return
    addSetup({
      id: `token:${token.id}`,
      name: agentName.trim(),
      harness:
        method === "native"
          ? nativeService === "claude"
            ? "Claude"
            : "ChatGPT"
          : MCP_CLIENTS[manualClient].label,
      mode: "on-demand",
      verified: true,
    })
    // Only the first observed use should add a setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenUsed, token?.id])

  function addSetup(setup: SetupRecord) {
    const durableSetup = ensureStarterThreadKey(setup)
    if (setups.some((item) => item.id === durableSetup.id)) return
    onSetupsChange([...setups, durableSetup])
  }

  function choose(next: ConnectionMethod) {
    setMethod(next)
    setPairing(null)
    setToken(null)
    setCloudComplete(false)
    setAgentName("")
    setBaseline(
      new Set((connections.data?.connections ?? []).map((item) => item.id))
    )
  }

  function resetMethod() {
    setMethod(null)
    setPairing(null)
    setToken(null)
    setCloudComplete(false)
    create.reset()
    mint.reset()
  }

  function retryPairing() {
    setPairing(null)
    create.reset()
  }

  const currentConnection = connection.data
  const origin = currentConnection
    ? new URL(currentConnection.remoteMcpUrl).origin
    : ""
  const localComputerCommand = pairing
    ? `curl -fsSL ${new URL("/connect.sh", pairing.mcpUrl).href} | sh -s -- ${pairing.code}${pairing.client ? ` --client ${pairing.client}` : ""}`
    : ""
  const cloudComputerCommand = currentConnection
    ? [
        `curl -fsSL ${origin}/connect.sh | sh -s --`,
        "--oauth",
        `--server ${origin}`,
        computerTarget === "auto" ? "" : `--client ${computerTarget}`,
      ]
        .filter(Boolean)
        .join(" ")
    : ""
  const openClawCommand = pairing
    ? `openclaw worktable connect --server ${pairing.serverOrigin} --pairing-code ${pairing.code}`
    : isCloud && currentConnection
      ? `openclaw worktable connect --server ${origin} --agent-registration --participant-name ${shellQuote(agentName.trim())}`
      : ""

  if (!method) {
    const inventoryPending =
      connection.isLoading || (isCloud && connections.isFetching)
    const inventoryUnavailable =
      connection.isError || (isCloud && connections.isError)
    return (
      <>
        <StepHeading
          icon={<Bot className="size-5" />}
          title="Connect your Agents"
          description="Add agents to your Worktable. You can add more later."
        />
        {inventoryPending ? (
          <p className="mt-7 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading connection
            details…
          </p>
        ) : inventoryUnavailable ? (
          <Callout variant="danger" className="mt-7">
            Couldn’t read the connection details.
          </Callout>
        ) : (
          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            {CONNECTION_METHODS.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  className="rounded-xl border border-border bg-background p-4 text-left transition-colors hover:border-primary/60 hover:bg-surface-tint/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  onClick={() => choose(item.id)}
                >
                  <span className="mb-4 grid size-9 place-items-center rounded-lg bg-surface-tint text-primary">
                    <Icon className="size-4" />
                  </span>
                  <span className="block text-sm font-medium">
                    {item.title}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                    {item.description}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        <div className="mt-7">
          <SetupList setups={setups} />
        </div>
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button onClick={onContinue}>
            {setups.length ? "Continue" : "Continue without an agent"}
          </Button>
        </div>
      </>
    )
  }

  const methodTitle =
    method === "computer"
      ? computerTarget === "auto"
        ? "CLI agents"
        : MCP_CLIENTS[computerTarget].label
      : method === "native"
        ? nativeService === "claude"
          ? "Claude"
          : "ChatGPT"
        : method === "openclaw"
          ? "OpenClaw"
          : MCP_CLIENTS[manualClient].label
  const namePlaceholder =
    method === "openclaw"
      ? "OpenClaw"
      : method === "computer" && computerTarget === "auto"
        ? "Agents on my computer"
        : `${methodTitle} on my computer`
  const methodComplete =
    (pairing && localVerified) || tokenUsed || cloudComplete
  const navigationBlocked =
    create.isPending || mint.isPending || useCloudConnection.isPending
  const configurationLocked = Boolean(pairing || token || cloudComplete)
  const pairingCanRetry =
    session?.status === "expired" || session?.status === "failed"

  const manualDetails = currentConnection
    ? desktopAgentConnectionDetails(currentConnection)
    : null
  const manualEndpoint = isCloud
    ? currentConnection?.remoteMcpUrl
    : manualDetails?.endpoint
  const snippet =
    method === "other" && manualEndpoint && (isCloud || token)
      ? mcpClientSnippet(manualClient, {
          endpoint: manualEndpoint,
          token: token?.value,
          reachable: currentConnection?.reachable,
        })
      : null

  return (
    <>
      <StepHeading
        icon={
          method === "computer" ? (
            <Laptop className="size-5" />
          ) : method === "native" ? (
            <MessageCircle className="size-5" />
          ) : method === "openclaw" ? (
            <RadioTower className="size-5" />
          ) : (
            <Plug className="size-5" />
          )
        }
        title={`Finish setting up ${agentName.trim() || methodTitle}`}
        description={
          method === "computer"
            ? "Run one command on the computer where you use this agent."
            : method === "native"
              ? "Add the Worktable MCP endpoint in the app."
              : method === "openclaw"
                ? "Install the Worktable plugin, then connect this OpenClaw."
                : "Add the endpoint or generated configuration to your agent."
        }
      />
      <div className="mt-7 space-y-5">
        {connection.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading connection
            details…
          </p>
        ) : connection.isError || !currentConnection ? (
          <Callout variant="danger">
            Couldn’t read the connection details.
          </Callout>
        ) : (
          <>
            {method === "computer" ? (
              <div className="space-y-5">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">CLI agent</label>
                  <Select
                    value={computerTarget}
                    disabled={configurationLocked}
                    onValueChange={(value) => {
                      setComputerTarget(value as ComputerTarget)
                      setPairing(null)
                    }}
                  >
                    <SelectTrigger aria-label="CLI agent">
                      <SelectValue>
                        {computerTarget === "auto"
                          ? "Detect installed agents"
                          : MCP_CLIENTS[computerTarget].label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">
                        Detect installed agents
                      </SelectItem>
                      {CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.map((id) => (
                        <SelectItem key={id} value={id}>
                          {MCP_CLIENTS[id].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <AgentNameField
                  value={agentName}
                  disabled={configurationLocked}
                  onChange={(value) => {
                    setAgentName(value)
                    setPairing(null)
                  }}
                  placeholder={namePlaceholder}
                  label={
                    computerTarget === "auto" ? "Connection name" : "Agent name"
                  }
                  description={
                    computerTarget === "auto"
                      ? "If more than one agent is detected, they share this name. Choose a specific agent above to name it separately."
                      : "Include the app or computer if that will help you recognize it later."
                  }
                />
                {!isCloud && !pairing ? (
                  <Button
                    disabled={!agentName.trim() || create.isPending}
                    onClick={() => create.mutate()}
                  >
                    {create.isPending ? "Creating…" : "Create install command"}
                  </Button>
                ) : null}
                {(isCloud ? cloudComputerCommand : localComputerCommand) ? (
                  <CopyValue
                    value={
                      isCloud ? cloudComputerCommand : localComputerCommand
                    }
                    label="Copy install command"
                  />
                ) : null}
                {isCloud ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Run the command, then open the agent and complete sign-in.
                    </p>
                    <CloudCandidates
                      connections={connections.data?.connections ?? []}
                      baseline={baseline}
                      method={method}
                      name={agentName}
                      pending={useCloudConnection.isPending}
                      onUse={(item) => useCloudConnection.mutate(item)}
                      onRefresh={() => void connections.refetch()}
                    />
                  </>
                ) : pairing ? (
                  <>
                    <PairingProgress session={session} />
                    {pairingCanRetry ? (
                      <Button variant="outline" onClick={retryPairing}>
                        Create a new command
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}

            {method === "openclaw" ? (
              <div className="space-y-5">
                <AgentNameField
                  value={agentName}
                  disabled={configurationLocked}
                  onChange={(value) => {
                    setAgentName(value)
                    setPairing(null)
                  }}
                  placeholder="OpenClaw"
                />
                <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground marker:text-foreground/60">
                  <li>Install the Worktable plugin.</li>
                  <li>Create the connection command.</li>
                  <li>Run both commands where OpenClaw is installed.</li>
                </ol>
                <CopyValue
                  value={OPENCLAW_INSTALL}
                  label="Copy install command"
                />
                {!isCloud && !pairing ? (
                  <Button
                    disabled={!agentName.trim() || create.isPending}
                    onClick={() => create.mutate()}
                  >
                    {create.isPending
                      ? "Creating…"
                      : "Create connection command"}
                  </Button>
                ) : null}
                {openClawCommand ? (
                  <CopyValue
                    value={openClawCommand}
                    label="Copy connection command"
                  />
                ) : null}
                {isCloud ? (
                  <CloudCandidates
                    connections={connections.data?.connections ?? []}
                    baseline={baseline}
                    method={method}
                    name={agentName}
                    pending={useCloudConnection.isPending}
                    onUse={(item) => useCloudConnection.mutate(item)}
                    onRefresh={() => void connections.refetch()}
                  />
                ) : pairing ? (
                  <>
                    <PairingProgress session={session} />
                    {pairingCanRetry ? (
                      <Button variant="outline" onClick={retryPairing}>
                        Create a new command
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}

            {method === "native" ? (
              <div className="space-y-5">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">App</label>
                  <Select
                    value={nativeService}
                    disabled={configurationLocked}
                    onValueChange={(value) => {
                      setNativeService(value as NativeService)
                      setToken(null)
                    }}
                  >
                    <SelectTrigger aria-label="App">
                      <SelectValue>
                        {nativeService === "claude" ? "Claude" : "ChatGPT"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="claude">Claude</SelectItem>
                      <SelectItem value="chatgpt">ChatGPT</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <AgentNameField
                  value={agentName}
                  disabled={configurationLocked}
                  onChange={(value) => {
                    setAgentName(value)
                    setToken(null)
                  }}
                  placeholder={namePlaceholder}
                />
                {nativeService === "claude" ? (
                  <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground marker:text-foreground/60">
                    {isCloud ? (
                      <>
                        <li>
                          Open Settings → Connectors in Claude or Claude
                          Desktop.
                        </li>
                        <li>Select Add custom connector.</li>
                        <li>Name it Worktable and paste the endpoint.</li>
                        <li>Select Connect and complete sign-in.</li>
                      </>
                    ) : (
                      <>
                        <li>
                          Download and open the Worktable desktop extension.
                        </li>
                        <li>Paste the endpoint and access token below.</li>
                        <li>Restart Claude, then use a Worktable tool.</li>
                      </>
                    )}
                  </ol>
                ) : (
                  <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground marker:text-foreground/60">
                    {isCloud ? (
                      <>
                        <li>
                          In ChatGPT on the web, go to Settings → Apps. The
                          connection will be available in web and desktop.
                        </li>
                        <li>Create a custom app and paste the endpoint.</li>
                        <li>
                          Scan the tools and complete sign-in when prompted.
                        </li>
                        <li>Create the app, then use it in a new chat.</li>
                      </>
                    ) : (
                      <>
                        <li>Open ChatGPT desktop Settings → MCP servers.</li>
                        <li>Add a server named Worktable.</li>
                        <li>
                          Choose Streamable HTTP and paste the endpoint below.
                        </li>
                        <li>Generate and supply the access token below.</li>
                        <li>Save, restart, then use a Worktable tool.</li>
                      </>
                    )}
                  </ol>
                )}
                {!isCloud && nativeService === "claude" ? (
                  <a
                    href="/integrations/claude-desktop.mcpb"
                    download="worktable-claude-desktop.mcpb"
                    className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
                  >
                    Download Claude Desktop extension{" "}
                    <ExternalLink className="size-3.5" />
                  </a>
                ) : null}
                {manualEndpoint ? (
                  <CopyValue value={manualEndpoint} label="Copy MCP endpoint" />
                ) : null}
                {!isCloud && !token ? (
                  <Button
                    variant="outline"
                    disabled={!agentName.trim() || mint.isPending}
                    onClick={() => mint.mutate()}
                  >
                    {mint.isPending ? "Generating…" : "Generate access token"}
                  </Button>
                ) : null}
                {token ? (
                  <>
                    <Callout variant="info">
                      Copy this token now. It is shown once.
                    </Callout>
                    <CopyValue value={token.value} label="Copy access token" />
                    {!tokenUsed ? (
                      <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> Waiting for
                        the app to use the connection…
                      </p>
                    ) : null}
                  </>
                ) : null}
                {isCloud ? (
                  <CloudCandidates
                    connections={connections.data?.connections ?? []}
                    baseline={baseline}
                    method={method}
                    name={agentName}
                    pending={useCloudConnection.isPending}
                    onUse={(item) => useCloudConnection.mutate(item)}
                    onRefresh={() => void connections.refetch()}
                  />
                ) : null}
              </div>
            ) : null}

            {method === "other" ? (
              <div className="space-y-5">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    Agent configuration
                  </label>
                  <Select
                    value={manualClient}
                    disabled={configurationLocked}
                    onValueChange={(value) => {
                      setManualClient(value as McpSnippetClientId)
                      setToken(null)
                    }}
                  >
                    <SelectTrigger aria-label="Agent configuration">
                      <SelectValue>
                        {MCP_CLIENTS[manualClient].label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {MCP_SNIPPET_CLIENT_IDS.map((id) => (
                        <SelectItem key={id} value={id}>
                          {MCP_CLIENTS[id].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <AgentNameField
                  value={agentName}
                  disabled={configurationLocked}
                  onChange={(value) => {
                    setAgentName(value)
                    setToken(null)
                  }}
                  placeholder={namePlaceholder}
                />
                {!isCloud && !token ? (
                  <Button
                    variant="outline"
                    disabled={!agentName.trim() || mint.isPending}
                    onClick={() => mint.mutate()}
                  >
                    {mint.isPending
                      ? "Generating…"
                      : "Generate connection token"}
                  </Button>
                ) : null}
                {token ? (
                  <Callout variant="info">
                    Copy this configuration now. Its token is shown once.
                  </Callout>
                ) : null}
                {snippet ? (
                  <CopyValue
                    value={snippet.body}
                    label="Copy configuration"
                    wrap
                  />
                ) : null}
                {manualEndpoint ? (
                  <CopyValue value={manualEndpoint} label="Copy MCP endpoint" />
                ) : null}
                {isCloud ? (
                  <CloudCandidates
                    connections={connections.data?.connections ?? []}
                    baseline={baseline}
                    method={method}
                    name={agentName}
                    pending={useCloudConnection.isPending}
                    onUse={(item) => useCloudConnection.mutate(item)}
                    onRefresh={() => void connections.refetch()}
                  />
                ) : token && !tokenUsed ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Waiting for the
                    agent to use the connection…
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        {create.isError || mint.isError || useCloudConnection.isError ? (
          <Callout variant="danger">
            {(create.error ?? mint.error ?? useCloudConnection.error) instanceof
            Error
              ? (
                  create.error ??
                  mint.error ??
                  (useCloudConnection.error as Error)
                ).message
              : "Couldn’t finish this connection."}
          </Callout>
        ) : null}
      </div>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          disabled={navigationBlocked}
          onClick={resetMethod}
        >
          Back
        </Button>
        <div className="flex flex-wrap gap-2">
          {methodComplete ? (
            <Button
              variant="outline"
              disabled={navigationBlocked}
              onClick={resetMethod}
            >
              Add another agent
            </Button>
          ) : null}
          <Button disabled={navigationBlocked} onClick={onContinue}>
            {methodComplete ? "Continue" : "Finish later"}
          </Button>
        </div>
      </div>
    </>
  )
}

function OpenClawStarter({
  setup,
  headingId,
  participants,
  savedThread,
  onThreadStarted,
}: {
  setup: SetupRecord
  headingId: string
  participants: ParticipantRef[]
  savedThread?: NonNullable<OnboardingDraft["threads"]>[number]
  onThreadStarted: (
    thread: NonNullable<OnboardingDraft["threads"]>[number]
  ) => void
}) {
  const [starterThreadKey] = useState(
    () => setup.starterThreadKey ?? createClientId("onboarding-thread")
  )
  const participantMatches = participants.filter(
    (item) => item.name === setup.participantName
  )
  const participant =
    participantMatches.length === 1 ? participantMatches[0] : undefined
  const startThread = useMutation({
    mutationFn: async (target: ParticipantRef) =>
      createThread(
        { kind: "worktable" },
        {
          to: target.id,
          body: OPENCLAW_FIRST_MESSAGE,
          idempotencyKey: starterThreadKey,
          waitSeconds: 0,
        }
      ),
    onSuccess: (result) => {
      onThreadStarted({
        setupId: setup.id,
        id: result.threadId,
        participantName: setup.participantName ?? setup.name,
      })
    },
  })

  return (
    <section className="space-y-3" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-sm font-medium">
        Start a Thread with {setup.name}
      </h2>
      <CopyValue
        value={OPENCLAW_FIRST_MESSAGE}
        label="Copy starter message"
        wrap
      />
      {savedThread ? (
        <Callout variant="success">
          Thread started. Finish setup now and check Threads whenever you’re
          ready.
        </Callout>
      ) : participant ? (
        <Button
          disabled={startThread.isPending}
          onClick={() => startThread.mutate(participant)}
        >
          {startThread.isPending ? "Starting…" : "Start Thread"}
        </Button>
      ) : participantMatches.length > 1 ? (
        <Callout variant="warning">
          More than one Thread participant matches this agent. Finish setup and
          start the Thread from Threads.
        </Callout>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Waiting for {setup.name} to
          appear in Threads…
        </p>
      )}
      {startThread.isError ? (
        <Callout variant="danger">
          {startThread.error instanceof Error
            ? startThread.error.message
            : "Couldn’t start the Thread."}
        </Callout>
      ) : null}
    </section>
  )
}

function ReadyStep({
  setups,
  savedThreads,
  onThreadStarted,
  onBack,
  onFinish,
  finishing,
}: {
  setups: SetupRecord[]
  savedThreads?: OnboardingDraft["threads"]
  onThreadStarted: (
    thread: NonNullable<OnboardingDraft["threads"]>[number]
  ) => void
  onBack: () => void
  onFinish: () => void
  finishing: boolean
}) {
  const participants = useQuery({
    queryKey: ["threads", "participants"],
    queryFn: () => listThreadParticipants(),
    refetchInterval: setups.some((item) => item.mode === "always-on")
      ? 3_000
      : false,
  })
  const alwaysOn = setups.filter((item) => item.mode === "always-on")
  const onDemand = setups.some((item) => item.mode === "on-demand")

  return (
    <>
      <StepHeading
        icon={<Check className="size-5" />}
        title="Your Worktable is ready"
        description={
          setups.length
            ? "Try one useful first step with an agent."
            : "Open Worktable now. You can connect agents from Settings later."
        }
      />
      <div className="mt-7 space-y-6">
        {alwaysOn.map((setup, index) => (
          <OpenClawStarter
            key={setup.id}
            setup={setup}
            headingId={`openclaw-first-thread-${index}`}
            participants={participants.data?.participants ?? []}
            savedThread={savedThreads?.find(
              (thread) => thread.setupId === setup.id
            )}
            onThreadStarted={onThreadStarted}
          />
        ))}

        {onDemand ? (
          <section className="space-y-3" aria-labelledby="starter-prompts">
            <h2 id="starter-prompts" className="text-sm font-medium">
              Starter prompts
            </h2>
            <div className="space-y-3">
              {STARTER_PROMPTS.map((prompt) => (
                <div key={prompt.label}>
                  <p className="mb-1.5 text-xs font-medium text-foreground/70">
                    {prompt.label}
                  </p>
                  <CopyValue
                    value={prompt.value}
                    label={`Copy ${prompt.label}`}
                    wrap
                  />
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {setups.length ? <SetupList setups={setups} /> : null}
      </div>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button disabled={finishing} onClick={onFinish}>
          {finishing ? "Finishing…" : "Finish setup"}
        </Button>
      </div>
    </>
  )
}

export function Onboarding({ workspace }: { workspace: WorkspaceInfo }) {
  const versionQuery = useQuery({
    queryKey: CACHED_SYSTEM_VERSION_QUERY_KEY,
    queryFn: getCachedSystemVersion,
    staleTime: Infinity,
  })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(() => readDraft(workspace.id))

  useEffect(() => {
    try {
      localStorage.setItem(draftKey(workspace.id), JSON.stringify(draft))
    } catch {
      // Reload recovery is best-effort; server completion remains authoritative.
    }
  }, [draft, workspace.id])

  const finish = useMutation({
    mutationFn: () => updateWorkspace({ onboarding: { status: "complete" } }),
    onSuccess: (updated) => {
      try {
        localStorage.removeItem(draftKey(workspace.id))
      } catch {
        // The server state is already complete.
      }
      queryClient.setQueryData(["workspace"], updated)
      toast.success("Setup complete")
      void navigate({ to: "/" })
    },
  })

  function setStep(step: OnboardingStep) {
    setDraft((current) => ({ ...current, step }))
  }

  return (
    <div className="min-h-dvh overflow-y-auto bg-background px-4 py-6 text-foreground sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-2xl">
        <StepProgress step={draft.step} />
        <main className="mt-8 rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:mt-10 sm:p-8">
          {draft.step === "identity" ? (
            <IdentityStep
              workspace={workspace}
              onContinue={() => setStep("connect")}
            />
          ) : draft.step === "connect" ? (
            <ConnectStep
              setups={draft.setups}
              onSetupsChange={(setups) =>
                setDraft((current) => ({ ...current, setups }))
              }
              onContinue={() => setStep("ready")}
              onBack={() => setStep("identity")}
            />
          ) : (
            <ReadyStep
              setups={draft.setups}
              savedThreads={draft.threads}
              onThreadStarted={(thread) =>
                setDraft((current) => ({
                  ...current,
                  threads: [
                    ...(current.threads ?? []).filter(
                      (item) => item.setupId !== thread.setupId
                    ),
                    thread,
                  ],
                }))
              }
              onBack={() => setStep("connect")}
              onFinish={() => finish.mutate()}
              finishing={finish.isPending}
            />
          )}
          {finish.isError ? (
            <div className="mt-5">
              <Callout variant="danger">
                {finish.error instanceof Error
                  ? finish.error.message
                  : "Couldn’t finish setup."}
              </Callout>
            </div>
          ) : null}
        </main>
        {versionQuery.data?.sourceUrl ? (
          <div className="mt-4 text-center">
            <SourceCodeLink sourceUrl={versionQuery.data.sourceUrl} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
