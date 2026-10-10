import { useEffect, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  AGENT_PLATFORMS,
  DEFAULT_AGENT_ACCESS,
  platformForAdapter,
  platformForClient,
  type AgentAccess,
} from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Card, CardContent } from "@worktable/ui/components/card"
import { Input } from "@worktable/ui/components/input"
import { toast } from "@worktable/ui/components/sonner"

import { AgentAvatar } from "@/components/agents/agent-avatar"
import { AgentFields } from "@/components/agents/agent-fields"
import {
  approveConnectionRequest,
  denyConnectionRequest,
  getConnectionRequest,
  type ConnectionRequest,
} from "@/lib/pairing-api"
import { openSettings } from "@/lib/settings-open"

interface ConnectSearch {
  code?: string
}

export const Route = createFileRoute("/connect")({
  validateSearch: (search: Record<string, unknown>): ConnectSearch =>
    typeof search["code"] === "string" && search["code"]
      ? { code: search["code"] }
      : {},
  component: ConnectPage,
})

function requestPlatform(request: ConnectionRequest) {
  return request.target.kind === "agent-adapter"
    ? platformForAdapter(request.target.adapter)
    : platformForClient(request.target.client)
}

/** An agent asked to connect; its owner checks the code and approves it. */
function ConnectPage() {
  const { code } = Route.useSearch()
  return (
    <div className="mx-auto max-w-lg px-4 py-8 sm:px-8 lg:py-10">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-[2rem]">
        Connect an agent
      </h1>
      <div className="mt-6">
        {code ? <RequestReview code={code} /> : <CodeEntry />}
      </div>
    </div>
  )
}

function CodeEntry() {
  const navigate = useNavigate({ from: "/connect" })
  const [code, setCode] = useState("")
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (code.trim()) void navigate({ search: { code: code.trim() } })
      }}
    >
      <label
        htmlFor="connect-code"
        className="text-sm font-medium text-foreground"
      >
        Code shown by your agent
      </label>
      <Input
        id="connect-code"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="BCDF-GHJK"
        autoComplete="off"
        autoFocus
        className="max-w-xs font-mono uppercase"
      />
      <div>
        <Button type="submit" disabled={!code.trim()}>
          Continue
        </Button>
      </div>
    </form>
  )
}

function RequestReview({ code }: { code: string }) {
  const requestQuery = useQuery({
    queryKey: ["connection-request", code],
    queryFn: () => getConnectionRequest(code),
    retry: false,
  })
  const request = requestQuery.data?.request
  const [name, setName] = useState("")
  const [icon, setIcon] = useState<string | null>(null)
  const [access, setAccess] = useState<AgentAccess>(DEFAULT_AGENT_ACCESS)
  const [answer, setAnswer] = useState<"approved" | "declined" | null>(null)

  useEffect(() => {
    if (!request) return
    setName(
      request.suggestedName ?? AGENT_PLATFORMS[requestPlatform(request)].name
    )
  }, [request])

  const approve = useMutation({
    mutationFn: () =>
      approveConnectionRequest(code, {
        displayName: name.trim(),
        icon,
        access,
      }),
    onSuccess: () => setAnswer("approved"),
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Couldn’t approve the agent."
      ),
  })
  const deny = useMutation({
    mutationFn: () => denyConnectionRequest(code),
    onSuccess: () => setAnswer("declined"),
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Couldn’t decline the agent."
      ),
  })

  if (answer) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm font-medium text-foreground">
            {answer === "approved"
              ? `${name.trim()} is connecting.`
              : "Declined."}
          </p>
          <p className="text-sm text-muted-foreground">
            {answer === "approved"
              ? "It finishes on its own in a few seconds. Manage it in "
              : "The agent was told and did not connect. Manage agents in "}
            <button
              type="button"
              className="text-primary-text underline-offset-4 hover:underline"
              onClick={() => openSettings("agents")}
            >
              Settings → Agents
            </button>
            .
          </p>
        </CardContent>
      </Card>
    )
  }
  if (requestQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }
  if (!request) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm font-medium text-foreground">
            This request expired or was already answered.
          </p>
          <p className="text-sm text-muted-foreground">
            Run the agent’s connect command again for a new code.
          </p>
        </CardContent>
      </Card>
    )
  }

  const platform = requestPlatform(request)
  const platformName = AGENT_PLATFORMS[platform].name
  const alwaysOn = request.target.kind === "agent-adapter"
  const canApprove =
    name.trim().length > 0 &&
    (access.threads || access.read || access.edit) &&
    !approve.isPending &&
    !deny.isPending
  return (
    <Card>
      <CardContent className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <AgentAvatar
            name={name.trim() || platformName}
            platform={platform}
            icon={icon}
            className="size-10"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {request.hostname
                ? `${platformName} on ${request.hostname}`
                : platformName}
            </p>
            <p className="text-sm text-muted-foreground">
              Check that it shows{" "}
              <span className="font-mono text-foreground">
                {request.userCode}
              </span>
            </p>
          </div>
        </div>
        <AgentFields
          platform={platform}
          name={name}
          onNameChange={setName}
          icon={icon}
          onIconChange={setIcon}
          access={access}
          onAccessChange={setAccess}
          alwaysOn={alwaysOn}
        />
        <div className="flex flex-wrap gap-2">
          <Button disabled={!canApprove} onClick={() => approve.mutate()}>
            {approve.isPending ? "Connecting…" : "Connect"}
          </Button>
          <Button
            variant="outline"
            disabled={approve.isPending || deny.isPending}
            onClick={() => deny.mutate()}
          >
            Decline
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
