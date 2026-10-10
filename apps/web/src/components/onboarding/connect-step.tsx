import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Check, ExternalLink, Plug } from "lucide-react"
import {
  AGENT_PLATFORMS,
  CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  DEFAULT_AGENT_ACCESS,
  MCP_CLIENTS,
  MCP_SNIPPET_CLIENT_IDS,
  mcpClientSnippet,
  platformForClient,
  type AgentAccess,
  type AgentConnection,
  type AgentPlatformId,
  type ConnectorInstallableMcpClientId,
  type McpSnippetClientId,
} from "@worktable/types"
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
import { cn } from "@worktable/ui/lib/utils"

import { AgentAccessFields } from "@/components/agents/agent-access-fields"
import { AgentAvatar } from "@/components/agents/agent-avatar"
import {
  connectAgentApp,
  getAppAgent,
  listAgentConnections,
  saveAgentChanges,
} from "@/lib/agent-connections-api"
import {
  ALWAYS_ON_AGENTS,
  OPENCLAW,
  type AlwaysOnAgent,
} from "@/lib/always-on-agents"
import { desktopAgentConnectionDetails } from "@/lib/desktop-agent-connection"
import {
  createPairing,
  getPairing,
  shouldPollPairing,
  type PairingCreated,
} from "@/lib/pairing-api"
import { getConnection } from "@/lib/system-api"
import { listTokens } from "@/lib/tokens-api"
import {
  CopyValue,
  PairingProgress,
  SetupList,
  StepHeading,
  Waiting,
} from "./onboarding-shared"
import {
  ensureStarterThreadKey,
  type SetupRecord,
} from "@/lib/onboarding-setups"

type Method = "computer" | "native" | "always-on" | "other"
type ComputerTarget = ConnectorInstallableMcpClientId | "auto"
type NativeApp = "claude" | "chatgpt"

const METHODS: Array<{
  id: Method
  title: string
  description: (cloud: boolean) => string
  platforms: AgentPlatformId[]
}> = [
  {
    id: "computer",
    title: "CLI agents",
    description: () => "Claude Code, Codex, Cursor, and others on a computer.",
    platforms: ["claude-code", "codex"],
  },
  {
    id: "native",
    title: "Claude or ChatGPT",
    description: (cloud) =>
      cloud ? "The web or desktop app." : "The desktop app.",
    platforms: ["claude", "chatgpt"],
  },
  {
    id: "always-on",
    title: "OpenClaw or Hermes",
    description: () => "Always on, answering you in Threads.",
    platforms: ["openclaw", "hermes"],
  },
  {
    id: "other",
    title: "Other MCP agent",
    description: () => "Any agent that connects over MCP.",
    platforms: [],
  },
]

/** Labels the credential carries, so the agent shows its platform. */
const NATIVE_LABELS = {
  claude: "claude-desktop",
  chatgpt: "chatgpt-desktop",
} as const

function LogoStack({
  platforms,
  className,
}: {
  platforms: AgentPlatformId[]
  className?: string
}) {
  if (platforms.length === 0) {
    return (
      <span
        className={cn(
          "grid size-9 place-items-center rounded-full bg-surface-tint text-primary",
          className
        )}
      >
        <Plug className="size-4" />
      </span>
    )
  }
  return (
    <span className="flex -space-x-2" aria-hidden>
      {platforms.map((platform) => (
        <AgentAvatar
          key={platform}
          name={AGENT_PLATFORMS[platform].name}
          platform={platform}
          className={cn("size-9 ring-2 ring-card", className)}
        />
      ))}
    </span>
  )
}

function accessSummary(access: AgentAccess): string {
  return [
    access.threads ? "Threads" : null,
    access.edit ? "Edit workspace" : access.read ? "Read workspace" : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** One numbered stage of connecting an agent. */
function SetupStage({
  number,
  title,
  state,
  last = false,
  children,
}: {
  number: number
  title: string
  state: "done" | "current" | "upcoming"
  last?: boolean
  children?: React.ReactNode
}) {
  return (
    <li className="relative flex gap-4">
      {last ? null : (
        <span
          aria-hidden
          className={cn(
            "absolute top-8 bottom-0 left-3.5 w-px",
            state === "done" ? "bg-primary/40" : "bg-border"
          )}
        />
      )}
      <span
        className={cn(
          "relative grid size-7 shrink-0 place-items-center rounded-full border text-xs font-medium",
          state === "done" &&
            "border-primary bg-primary text-primary-foreground",
          state === "current" && "border-primary bg-background text-primary",
          state === "upcoming" && "border-border text-muted-foreground"
        )}
      >
        {state === "done" ? <Check className="size-3.5" /> : number}
      </span>
      <div className={cn("min-w-0 flex-1", last ? "pb-1" : "pb-7")}>
        <h2
          className={cn(
            "pt-1 text-sm font-medium",
            state === "upcoming" ? "text-muted-foreground" : "text-foreground"
          )}
        >
          {title}
        </h2>
        {children && state !== "upcoming" ? (
          <div className="mt-3 space-y-4">{children}</div>
        ) : null}
      </div>
    </li>
  )
}

function LabeledCopy({
  label,
  hint,
  value,
  copyLabel,
  wrap,
}: {
  label: string
  hint?: string
  value: string
  copyLabel: string
  wrap?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-foreground/70">{label}</p>
      <CopyValue value={value} label={copyLabel} wrap={wrap} />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function Instructions({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm leading-6 text-muted-foreground marker:text-foreground/50">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ol>
  )
}

/** On Cloud, agents sign in; the owner picks the one that just did. */
function CloudCandidates({
  connections,
  baseline,
  alwaysOn,
  onUse,
  pending,
  disabled,
  failed,
  onRefresh,
}: {
  connections: AgentConnection[]
  baseline: Set<string>
  /** Set for an always-on agent that connects through its own registration. */
  alwaysOn?: AlwaysOnAgent
  onUse: (connection: AgentConnection) => void
  pending: boolean
  disabled: boolean
  /** Cloud's list of signed-in agents could not be read. */
  failed: boolean
  onRefresh: () => void
}) {
  const candidates = connections.filter((connection) =>
    alwaysOn?.cloudAuth === "agent-registration"
      ? connection.target.kind === "agent-adapter" &&
        connection.target.adapter === alwaysOn.adapter
      : connection.authKind === "oauth"
  )
  // Newly connected agents first: those are almost always the one.
  const ordered = [...candidates].sort(
    (a, b) => Number(baseline.has(a.id)) - Number(baseline.has(b.id))
  )
  return (
    <div className="space-y-3">
      {failed ? (
        <Callout variant="danger">
          Couldn’t read the agents that signed in.
        </Callout>
      ) : ordered.length === 0 ? (
        <Waiting>Waiting for the agent to sign in…</Waiting>
      ) : (
        <ul className="divide-y divide-border/70 rounded-xl border border-border/70 bg-background">
          {ordered.map((connection) => (
            <li
              key={connection.id}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <AgentAvatar
                name={connection.displayName}
                platform={connection.platform}
                icon={connection.icon}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {connection.displayName}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {baseline.has(connection.id)
                    ? "Already connected"
                    : "Just signed in"}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || disabled}
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

/** The token's id, from its `wt_<id>_<secret>` form. */
function tokenId(token: string): string | null {
  return /^wt_([0-9a-f]{12})_/.exec(token)?.[1] ?? null
}

export function ConnectStep({
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
  const [method, setMethod] = useState<Method | null>(null)
  const [computerTarget, setComputerTarget] = useState<ComputerTarget>("auto")
  const [nativeApp, setNativeApp] = useState<NativeApp>("claude")
  const [manualClient, setManualClient] = useState<McpSnippetClientId>("goose")
  const [alwaysOnAgent, setAlwaysOnAgent] = useState<AlwaysOnAgent>(OPENCLAW)
  // Until the owner types a name, the agent is named after what it is.
  const [typedName, setTypedName] = useState<string | null>(null)
  const [chosenAccess, setAccess] = useState<AgentAccess | null>(null)
  const [pairing, setPairing] = useState<PairingCreated | null>(null)
  const [token, setToken] = useState<{
    value: string
    id: string
    /** The agent it belongs to: one per app, however many tokens. */
    agentId: string
  } | null>(null)
  const [cloudComplete, setCloudComplete] = useState(false)
  const [baseline, setBaseline] = useState<Set<string>>(new Set())

  const connection = useQuery({
    queryKey: ["system", "connection"],
    queryFn: getConnection,
    staleTime: 30_000,
  })
  const isCloud = connection.data?.mcpAuthMode === "oauth"
  // Cloud pairs always-on agents like a local Worktable once its gateway can
  // route them; until then they connect with a sign-in.
  const alwaysOnSignIn = isCloud && !connection.data?.agentPairing
  const connections = useQuery({
    queryKey: ["agent-connections"],
    queryFn: () => listAgentConnections(),
    refetchInterval: method && isCloud ? 3_000 : false,
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

  // What is being connected, and how it is named and shown.
  const platform: AgentPlatformId =
    method === "computer"
      ? computerTarget === "auto"
        ? "other"
        : platformForClient(computerTarget)
      : method === "native"
        ? nativeApp
        : method === "always-on"
          ? alwaysOnAgent.adapter
          : platformForClient(manualClient)
  const agentTitle =
    method === "computer"
      ? computerTarget === "auto"
        ? "CLI agents"
        : MCP_CLIENTS[computerTarget].label
      : method === "native"
        ? nativeApp === "claude"
          ? "Claude"
          : "ChatGPT"
        : method === "always-on"
          ? alwaysOnAgent.name
          : MCP_CLIENTS[manualClient].label
  // An app connected with a token made here is the same agent when it is
  // connected again: start from its name and access.
  const appLabel =
    method === "native"
      ? NATIVE_LABELS[nativeApp]
      : method === "other"
        ? manualClient
        : null
  const appAgent = useQuery({
    queryKey: ["agent-connections", "app", appLabel],
    queryFn: () => getAppAgent(appLabel!),
    enabled: Boolean(appLabel) && connection.isSuccess && !isCloud,
  })
  const existingAgent = appLabel ? (appAgent.data?.connection ?? null) : null
  const access = chosenAccess ?? existingAgent?.access ?? DEFAULT_AGENT_ACCESS
  // Until it is known whether the app is already an agent, its access is not:
  // creating then could widen an agent its owner had limited.
  const appKnown = !appLabel || isCloud || appAgent.isSuccess
  const defaultName = existingAgent
    ? existingAgent.displayName
    : method === "computer" && computerTarget === "auto"
      ? "Agents on my computer"
      : platform === "other"
        ? agentTitle
        : AGENT_PLATFORMS[platform].name
  const name = typedName ?? defaultName

  const create = useMutation({
    mutationFn: () =>
      method === "always-on"
        ? createPairing({
            target: {
              kind: "agent-adapter",
              adapter: alwaysOnAgent.adapter,
              participantName: name.trim(),
            },
            access,
          })
        : createPairing({
            client: computerTarget === "auto" ? null : computerTarget,
            displayName: name.trim(),
            access,
          }),
    onSuccess: setPairing,
  })
  const mint = useMutation({
    mutationFn: () =>
      connectAgentApp({
        client: method === "native" ? NATIVE_LABELS[nativeApp] : manualClient,
        displayName: name.trim(),
        access,
      }),
    onSuccess: (result) => {
      const id = tokenId(result.token)
      if (id)
        setToken({ value: result.token, id, agentId: result.connection.id })
      void queryClient.invalidateQueries({ queryKey: ["tokens"] })
      void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    },
  })
  const useCloudConnection = useMutation({
    mutationFn: async (selected: AgentConnection) => {
      // Its registration fixes an always-on agent's access on Cloud.
      const registered = selected.authKind === "agent-registration"
      await saveAgentChanges(selected, {
        name: name.trim(),
        icon: selected.icon ?? null,
        access: registered ? null : access,
      })
      return selected
    },
    onSuccess: (selected) => {
      const isAlwaysOn = method === "always-on"
      addSetup({
        id: selected.id,
        name: name.trim(),
        harness: isAlwaysOn ? alwaysOnAgent.name : agentTitle,
        mode: isAlwaysOn ? "always-on" : "on-demand",
        verified: true,
        platform:
          selected.platform && selected.platform !== "other"
            ? selected.platform
            : platform,
        ...(isAlwaysOn ? { participantName: name.trim() } : {}),
      })
      setCloudComplete(true)
      void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    },
  })

  const session = pairingStatus.data
  const pairingVerified = session?.status === "verified"
  const tokenUsed = Boolean(
    token && tokens.data?.find((item) => item.id === token.id)?.lastUsedAt
  )

  useEffect(() => {
    if (!pairingVerified || !pairing || !method) return
    addSetup({
      id: `pairing:${pairing.id}`,
      name: name.trim(),
      harness:
        method === "always-on"
          ? alwaysOnAgent.name
          : computerTarget === "auto"
            ? "CLI agents on one computer"
            : MCP_CLIENTS[computerTarget].label,
      mode: method === "always-on" ? "always-on" : "on-demand",
      verified: true,
      platform,
      ...(method === "always-on" ? { participantName: name.trim() } : {}),
    })
    void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    void queryClient.invalidateQueries({ queryKey: ["tokens"] })
    // Only the terminal transition should add a setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairingVerified, pairing?.id])

  useEffect(() => {
    if (!tokenUsed || !token || !method) return
    addSetup({
      id: `agent:${token.agentId}`,
      name: name.trim(),
      harness: agentTitle,
      mode: "on-demand",
      verified: true,
      platform,
    })
    // Only the first observed use should add a setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenUsed, token?.id])

  function addSetup(setup: SetupRecord) {
    const durableSetup = ensureStarterThreadKey(setup)
    const existing = setups.find((item) => item.id === durableSetup.id)
    if (existing?.mode === "always-on") return
    onSetupsChange(
      existing
        ? setups.map((item) =>
            item.id === durableSetup.id ? durableSetup : item
          )
        : [...setups, durableSetup]
    )
  }

  function reset() {
    setPairing(null)
    setToken(null)
    setCloudComplete(false)
    create.reset()
    mint.reset()
    useCloudConnection.reset()
  }

  function choose(next: Method) {
    reset()
    setMethod(next)
    setTypedName(null)
    setAccess(null)
    setBaseline(
      new Set((connections.data?.connections ?? []).map((item) => item.id))
    )
  }

  const current = connection.data

  if (!method) {
    const loading = connection.isLoading || (isCloud && connections.isLoading)
    return (
      <>
        <StepHeading
          icon={<Bot className="size-5" />}
          title="Connect your Agents"
          description="Choose where you use an agent. You can connect more later in Settings."
        />
        {loading ? (
          <div className="mt-7">
            <Waiting>Reading connection details…</Waiting>
          </div>
        ) : connection.isError || (isCloud && connections.isError) ? (
          <Callout variant="danger" className="mt-7">
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
        ) : (
          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            {METHODS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="group flex flex-col items-start rounded-xl border border-border bg-background p-4 text-left transition-colors hover:border-primary/60 hover:bg-surface-tint/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                onClick={() => choose(item.id)}
              >
                <LogoStack platforms={item.platforms} />
                <span className="mt-4 block text-sm font-medium">
                  {item.title}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  {item.description(isCloud)}
                </span>
              </button>
            ))}
          </div>
        )}
        {setups.length ? (
          <div className="mt-7">
            <SetupList setups={setups} />
          </div>
        ) : null}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          {setups.length ? (
            <Button onClick={onContinue}>Continue</Button>
          ) : (
            <Button variant="outline" onClick={onContinue}>
              Continue without an agent
            </Button>
          )}
        </div>
      </>
    )
  }

  // Cloud connects apps and CLI agents by signing in, with no command to
  // create first; the owner's choices apply when the agent is picked.
  const signsIn = isCloud && (method !== "always-on" || alwaysOnSignIn)
  // On Cloud, an always-on agent's own registration fixes its access.
  const accessFixed =
    method === "always-on" &&
    alwaysOnSignIn &&
    alwaysOnAgent.cloudAuth === "agent-registration"
  const created = Boolean(pairing || token)
  const complete = pairingVerified || tokenUsed || cloudComplete
  const busy =
    create.isPending || mint.isPending || useCloudConnection.isPending
  const locked = created || busy || complete || !appKnown
  const anyAccess = accessFixed || access.threads || access.read || access.edit
  const setupPending =
    created &&
    !complete &&
    session?.status !== "expired" &&
    session?.status !== "failed"
  const canCreate = name.trim().length > 0 && anyAccess && !busy && appKnown

  const origin = current ? new URL(current.remoteMcpUrl).origin : ""
  const manualDetails = current ? desktopAgentConnectionDetails(current) : null
  const endpoint = isCloud ? current?.remoteMcpUrl : manualDetails?.endpoint
  const snippet =
    method === "other" && endpoint && (isCloud || token)
      ? mcpClientSnippet(manualClient, {
          endpoint,
          token: token?.value,
          reachable: current?.reachable,
        })
      : null

  const createLabel =
    method === "computer"
      ? "Create install command"
      : method === "always-on"
        ? "Create connection command"
        : method === "native"
          ? "Generate access token"
          : "Generate connection token"

  const agentPicker =
    method === "computer" ? (
      <LabeledSelect
        label="CLI agent"
        value={computerTarget}
        disabled={locked}
        display={
          computerTarget === "auto"
            ? "Detect installed agents"
            : MCP_CLIENTS[computerTarget].label
        }
        options={[
          { value: "auto", label: "Detect installed agents" },
          ...CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.map((id) => ({
            value: id,
            label: MCP_CLIENTS[id].label,
          })),
        ]}
        onChange={(value) => setComputerTarget(value as ComputerTarget)}
      />
    ) : method === "native" ? (
      <LabeledSelect
        label="App"
        value={nativeApp}
        disabled={locked}
        display={nativeApp === "claude" ? "Claude" : "ChatGPT"}
        options={[
          { value: "claude", label: "Claude" },
          { value: "chatgpt", label: "ChatGPT" },
        ]}
        onChange={(value) => {
          setNativeApp(value as NativeApp)
          setAccess(null)
        }}
      />
    ) : method === "always-on" ? (
      <LabeledSelect
        label="Agent"
        value={alwaysOnAgent.adapter}
        disabled={locked}
        display={alwaysOnAgent.name}
        options={ALWAYS_ON_AGENTS.map((item) => ({
          value: item.adapter,
          label: item.name,
        }))}
        onChange={(value) => {
          setAccess(null)
          setAlwaysOnAgent(
            ALWAYS_ON_AGENTS.find((item) => item.adapter === value) ?? OPENCLAW
          )
        }}
      />
    ) : (
      <LabeledSelect
        label="Agent configuration"
        value={manualClient}
        disabled={locked}
        display={MCP_CLIENTS[manualClient].label}
        options={MCP_SNIPPET_CLIENT_IDS.map((id) => ({
          value: id,
          label: MCP_CLIENTS[id].label,
        }))}
        onChange={(value) => {
          setManualClient(value as McpSnippetClientId)
          setAccess(null)
        }}
      />
    )

  const chosen = (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {agentPicker}
        <div className="space-y-1.5">
          <label
            htmlFor="onboarding-agent-name"
            className="text-sm font-medium"
          >
            Agent name
          </label>
          <Input
            id="onboarding-agent-name"
            value={name}
            maxLength={100}
            disabled={locked}
            onChange={(event) => setTypedName(event.target.value)}
          />
        </div>
      </div>
      {method === "computer" && computerTarget === "auto" ? (
        <p className="-mt-2 text-xs text-muted-foreground">
          Agents detected together share this name. Choose one agent to name it
          on its own.
        </p>
      ) : null}
      {accessFixed ? null : (
        <AgentAccessFields
          value={access}
          onChange={setAccess}
          alwaysOn={method === "always-on"}
          disabled={locked}
        />
      )}
      {appLabel && !isCloud && appAgent.isError ? (
        <Callout variant="danger">
          Couldn’t check whether {agentTitle} is already connected.{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => void appAgent.refetch()}
          >
            Try again
          </button>
        </Callout>
      ) : null}
      {existingAgent ? (
        <p className="text-xs text-muted-foreground">
          Already connected as {existingAgent.displayName}. A new token joins
          it.
        </p>
      ) : null}
      {signsIn ? null : (
        <Button
          disabled={!canCreate}
          onClick={() =>
            (method === "computer" || method === "always-on"
              ? create
              : mint
            ).mutate()
          }
        >
          {busy ? "Creating…" : createLabel}
        </Button>
      )}
    </div>
  )

  const chosenSummary = (
    <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-2.5">
      <AgentAvatar name={name.trim()} platform={platform} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {name.trim()}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {[
            name.trim() === agentTitle ? null : agentTitle,
            accessFixed ? null : accessSummary(access),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </div>
  )

  const commands =
    method === "computer" ? (
      isCloud ? (
        <>
          <CopyValue
            value={[
              `curl -fsSL ${origin}/connect.sh | sh -s --`,
              "--oauth",
              `--server ${origin}`,
              computerTarget === "auto" ? "" : `--client ${computerTarget}`,
            ]
              .filter(Boolean)
              .join(" ")}
            label="Copy install command"
          />
          <p className="text-xs text-muted-foreground">
            Then open the agent and complete sign-in.
          </p>
        </>
      ) : pairing ? (
        <CopyValue
          value={`curl -fsSL ${new URL("/connect.sh", pairing.mcpUrl).href} | sh -s -- ${pairing.code}${pairing.client ? ` --client ${pairing.client}` : ""}`}
          label="Copy install command"
        />
      ) : null
    ) : method === "always-on" ? (
      <>
        <LabeledCopy
          label="Install the Worktable plugin"
          value={alwaysOnAgent.installCommand}
          copyLabel="Copy install command"
        />
        {alwaysOnAgent.restartBeforeConnect ? (
          <LabeledCopy
            label="Restart its gateway if it doesn’t restart on its own"
            value={alwaysOnAgent.restartCommand}
            copyLabel="Copy restart command"
          />
        ) : null}
        {pairing || alwaysOnSignIn ? (
          <LabeledCopy
            label="Connect it"
            value={
              pairing
                ? alwaysOnAgent.localConnectCommand(
                    pairing.serverOrigin,
                    pairing.code
                  )
                : alwaysOnAgent.cloudConnectCommand(origin, name.trim())
            }
            copyLabel="Copy connection command"
          />
        ) : null}
        {alwaysOnAgent.restartBeforeConnect ? null : (
          <LabeledCopy
            label="Then restart its gateway"
            value={alwaysOnAgent.restartCommand}
            copyLabel="Copy restart command"
          />
        )}
      </>
    ) : method === "native" ? (
      <>
        <Instructions
          items={
            nativeApp === "claude"
              ? isCloud
                ? [
                    "In Claude or Claude Desktop, open Settings → Connectors.",
                    "Select Add custom connector.",
                    "Name it Worktable and paste the endpoint.",
                    "Select Connect and complete sign-in.",
                  ]
                : [
                    "Download and open the Worktable desktop extension.",
                    "Paste the endpoint and access token.",
                    "Restart Claude, then use a Worktable tool.",
                  ]
              : isCloud
                ? [
                    "In ChatGPT on the web, go to Settings → Apps. The connection will be available in web and desktop.",
                    "Create a custom app and paste the endpoint.",
                    "Scan the tools and complete sign-in when prompted.",
                    "Create the app, then use it in a new chat.",
                  ]
                : [
                    "Open ChatGPT desktop Settings → MCP servers.",
                    "Add a server named Worktable.",
                    "Choose Streamable HTTP and paste the endpoint.",
                    "Paste the access token.",
                    "Save, restart, then use a Worktable tool.",
                  ]
          }
        />
        {!isCloud && nativeApp === "claude" ? (
          <a
            href="/integrations/claude-desktop.mcpb"
            download="worktable-claude-desktop.mcpb"
            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            Download Claude Desktop extension{" "}
            <ExternalLink className="size-3.5" />
          </a>
        ) : null}
        {endpoint ? (
          <LabeledCopy
            label="MCP endpoint"
            value={endpoint}
            copyLabel="Copy MCP endpoint"
          />
        ) : null}
        {token ? (
          <LabeledCopy
            label="Access token"
            hint="Shown once. Copy it now."
            value={token.value}
            copyLabel="Copy access token"
          />
        ) : null}
      </>
    ) : (
      <>
        {snippet ? (
          <LabeledCopy
            label="Configuration"
            hint={token ? "Its token is shown once. Copy it now." : undefined}
            value={snippet.body}
            copyLabel="Copy configuration"
            wrap
          />
        ) : null}
        {endpoint ? (
          <LabeledCopy
            label="MCP endpoint"
            value={endpoint}
            copyLabel="Copy MCP endpoint"
          />
        ) : null}
      </>
    )

  const status = signsIn ? (
    <CloudCandidates
      connections={connections.data?.connections ?? []}
      baseline={baseline}
      alwaysOn={method === "always-on" ? alwaysOnAgent : undefined}
      pending={useCloudConnection.isPending}
      disabled={!name.trim() || !anyAccess || cloudComplete}
      failed={connections.isError}
      onUse={(item) => useCloudConnection.mutate(item)}
      onRefresh={() => void connections.refetch()}
    />
  ) : pairing ? (
    <>
      <PairingProgress session={session} />
      {session?.status === "expired" || session?.status === "failed" ? (
        <Button variant="outline" onClick={reset}>
          Create a new command
        </Button>
      ) : null}
    </>
  ) : token ? (
    tokenUsed ? (
      <Callout variant="success">Connected.</Callout>
    ) : (
      <Waiting>Waiting for the agent to use the connection…</Waiting>
    )
  ) : null

  const error = create.error ?? mint.error ?? useCloudConnection.error

  return (
    <>
      <StepHeading
        media={
          method === "computer" && computerTarget === "auto" ? (
            <LogoStack
              platforms={["claude-code", "codex"]}
              className="size-11"
            />
          ) : method === "other" && platform === "other" ? (
            <LogoStack platforms={[]} className="size-11" />
          ) : (
            <AgentAvatar
              name={agentTitle}
              platform={platform}
              className="size-11"
            />
          )
        }
        title={`Connect ${agentTitle}`}
        description={
          method === "computer"
            ? "Run one command on the computer where you use it."
            : method === "native"
              ? "Add Worktable to the app."
              : method === "always-on"
                ? `Pair ${alwaysOnAgent.name} so it can answer you in Threads.`
                : "Add Worktable to your agent’s configuration."
        }
      />
      <div className="mt-7">
        {connection.isError || (!connection.isLoading && !current) ? (
          <Callout variant="danger">
            Couldn’t read the connection details.
          </Callout>
        ) : connection.isLoading ? (
          <Waiting>Reading connection details…</Waiting>
        ) : (
          <ol>
            <SetupStage
              number={1}
              title="Name it and choose what it can do"
              state={created || cloudComplete ? "done" : "current"}
            >
              {created || cloudComplete ? chosenSummary : chosen}
            </SetupStage>
            <SetupStage
              number={2}
              title={
                method === "native"
                  ? `Add Worktable to ${agentTitle}`
                  : method === "other"
                    ? "Add the configuration"
                    : method === "always-on"
                      ? `Run these where ${alwaysOnAgent.name} is installed`
                      : "Run the command"
              }
              state={
                complete ? "done" : created || signsIn ? "current" : "upcoming"
              }
            >
              {commands}
            </SetupStage>
            <SetupStage
              number={3}
              title={complete ? "Connected" : "Wait for it to connect"}
              state={
                complete ? "done" : created || signsIn ? "current" : "upcoming"
              }
              last
            >
              {status}
            </SetupStage>
          </ol>
        )}
        {error ? (
          <Callout variant="danger" className="mt-5">
            {error instanceof Error
              ? error.message
              : "Couldn’t finish this connection."}
          </Callout>
        ) : null}
      </div>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          // A created command or token is live until it connects; leaving would
          // lose it without ending it.
          disabled={busy || setupPending}
          onClick={() => {
            reset()
            setMethod(null)
          }}
        >
          Back
        </Button>
        <div className="flex flex-wrap gap-2">
          {complete ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  reset()
                  setMethod(null)
                }}
              >
                Add another agent
              </Button>
              <Button disabled={busy} onClick={onContinue}>
                Continue
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={onContinue}>
              Finish later
            </Button>
          )}
        </div>
      </div>
    </>
  )
}

function LabeledSelect({
  label,
  value,
  display,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  display: string
  options: Array<{ value: string; label: string }>
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => onChange(next as string)}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue>{display}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
