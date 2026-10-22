import { useId, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  grokBotRoutineInstructions,
  type GrokBotConnection,
} from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Badge } from "@worktable/ui/components/badge"
import { Callout } from "@worktable/ui/components/callout"
import { CopyField } from "@worktable/ui/components/copy-field"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { Input } from "@worktable/ui/components/input"
import { SettingRow } from "@worktable/ui/components/setting-row"
import { Switch } from "@worktable/ui/components/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { toast } from "@worktable/ui/components/sonner"
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { listAgentConnections } from "@/lib/agent-connections-api"
import { fetchJSON } from "@/lib/http"
import type { ConnectionInfo } from "@/lib/system-api"
import { useSettingsSectionActive } from "../settings-dialog"

const STATUS: Record<GrokBotConnection["status"], string> = {
  configured: "Needs a connection check",
  checking: "Checking connection",
  ready: "Ready",
  working: "Working",
  paused: "Paused",
  "needs-attention": "Needs attention",
}

export function GrokBotSetupPanel({
  connection,
  open,
}: {
  connection: ConnectionInfo
  open: boolean
}) {
  const active = useSettingsSectionActive()
  const queryClient = useQueryClient()
  const workspaceAgentsOnCloud = connection.mcpAuthMode === "oauth"
  const inventory = useQuery({
    queryKey: ["agent-connections", workspaceAgentsOnCloud],
    queryFn: () => listAgentConnections({ workspaceAgentsOnCloud }),
    enabled: active && open,
  })
  const [selected, setSelected] = useState("")
  const candidates = inventory.data?.grokBotCandidates ?? []
  const candidate = candidates.find((c) => c.id === selected) ?? candidates[0]
  const saved = inventory.data?.grokBots?.find(
    (c) => c.connectionId === candidate?.id
  )
  const mcpUrl =
    connection.mcpAuthMode === "oauth"
      ? connection.remoteMcpUrl
      : inventory.data?.grokBotMcpUrl
  const copy = useCopy(() => toast.success("Copied"))
  const refresh = () => void inventory.refetch()
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Grok Bot can answer messages assigned to it in Worktable, including
        requests from another agent.
      </p>
      {!mcpUrl ? (
        <Callout title="Connect Worktable Link first">
          Grok Bot needs an OAuth connection to reach this Worktable. Set up
          Worktable Link in Settings → Worktable Cloud, then return here.
        </Callout>
      ) : (
        <>
          <p className="text-sm">
            Add a custom MCP connection in Grok Bot with this endpoint, then
            sign in to Worktable.
          </p>
          <CopyField
            label="MCP endpoint"
            value={mcpUrl}
            onCopied={() => toast.success("Copied")}
          />
          <p className="text-sm text-muted-foreground">
            Ask Grok Bot to check its Worktable inbox once. Then refresh the
            connections here and select that sign-in.
          </p>
          <div>
            <Button
              variant="outline"
              disabled={inventory.isFetching}
              onClick={refresh}
            >
              Refresh connections
            </Button>
          </div>
          {inventory.isError && (
            <Callout variant="danger">
              Could not load connections. Refresh to try again.
            </Callout>
          )}
          {candidate && (
            <>
              <Select
                value={candidate.id}
                onValueChange={(value) => setSelected(value ?? "")}
              >
                <SelectTrigger aria-label="Grok Bot sign-in">
                  <SelectValue>{candidate.displayName}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs break-all text-muted-foreground">
                Sign-in: {candidate.id}
              </p>
              <div>
                <Button
                  variant="outline"
                  onClick={() =>
                    void copy.copy(grokBotRoutineInstructions(mcpUrl))
                  }
                >
                  {copy.copied ? "Copied" : "Copy routine instructions"}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Send these instructions to Grok Bot. Open the saved routine on
                desktop and copy its webhook URL and key below. Grok Bot uses
                the apps and accounts linked to your Grok account.
              </p>
              <GrokBotConfiguration
                key={candidate.id}
                id={candidate.id}
                saved={saved}
                onChanged={async () => {
                  await queryClient.invalidateQueries({
                    queryKey: ["agent-connections", workspaceAgentsOnCloud],
                    exact: true,
                  })
                }}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}

function GrokBotConfiguration({
  id,
  saved,
  onChanged,
}: {
  id: string
  saved?: GrokBotConnection
  onChanged: () => Promise<void>
}) {
  const fieldId = useId()
  const [url, setUrl] = useState("")
  const [key, setKey] = useState("")
  const [minutes, setMinutes] = useState(String(saved?.executionMinutes ?? 30))
  const [enabled, setEnabled] = useState(saved?.enabled ?? true)
  const [confirmRetry, setConfirmRetry] = useState(false)
  const base = `/api/grok-bot/${encodeURIComponent(id)}`
  const action = useMutation({
    mutationFn: async (kind: "save" | "check" | "retry" | "remove") => {
      await fetchJSON(
        `${base}/${kind === "save" || kind === "remove" ? "configuration" : kind}?scope=workspace`,
        {
          method:
            kind === "save" ? "PUT" : kind === "remove" ? "DELETE" : "POST",
          ...(kind === "save"
            ? {
                body: JSON.stringify({
                  ...(url ? { webhookUrl: url.trim() } : {}),
                  ...(key ? { webhookKey: key.trim() } : {}),
                  enabled,
                  executionMinutes: Number(minutes),
                }),
              }
            : {}),
        }
      )
      if (kind === "save" || kind === "remove") {
        setKey("")
        setUrl("")
      }
      setConfirmRetry(false)
      await onChanged()
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Could not update Grok Bot"
      ),
  })
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        action.mutate("save")
      }}
    >
      {saved && (
        <div aria-live="polite">
          <Badge variant="secondary">{STATUS[saved.status]}</Badge>
        </div>
      )}
      {saved?.error && <Callout variant="warning">{saved.error}</Callout>}
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={`${fieldId}-url`}>
          Webhook URL
        </label>
        <Input
          id={`${fieldId}-url`}
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoComplete="off"
          placeholder={
            saved
              ? "Saved · paste a new URL to replace"
              : "https://api2.cursor.sh/automations/webhook/…"
          }
          required={!saved}
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={`${fieldId}-key`}>
          Webhook key
        </label>
        <Input
          id={`${fieldId}-key`}
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="new-password"
          placeholder={
            saved
              ? "Saved · paste a new key to replace"
              : "Paste the routine key"
          }
          required={!saved}
        />
        <p className="text-xs text-muted-foreground">
          Stored privately on this Worktable server.
        </p>
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={`${fieldId}-deadline`}>
          Execution deadline (minutes)
        </label>
        <Input
          id={`${fieldId}-deadline`}
          className="w-28"
          type="number"
          min={1}
          max={120}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground">
          When a claimed run exceeds this deadline, Worktable waits for you to
          check Grok Bot before retrying.
        </p>
      </div>
      <SettingRow label="Receive assignments">
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </SettingRow>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={action.isPending}>
          Save routine
        </Button>
        {saved?.enabled && !saved.verifiedAt && (
          <Button
            type="button"
            variant="outline"
            disabled={action.isPending}
            onClick={() => action.mutate("check")}
          >
            {saved.probe ? "Check pending" : "Check connection"}
          </Button>
        )}
        {saved?.status === "needs-attention" && (
          <Button
            type="button"
            variant="outline"
            disabled={action.isPending}
            onClick={() =>
              saved.uncertain ? setConfirmRetry(true) : action.mutate("retry")
            }
          >
            Retry
          </Button>
        )}
        {saved && (
          <Button
            type="button"
            variant="ghost"
            disabled={action.isPending}
            onClick={() => action.mutate("remove")}
          >
            Remove routine
          </Button>
        )}
      </div>
      {saved?.probe && (
        <p className="text-sm text-muted-foreground">
          A connection-check message is waiting in Worktable. This connection
          becomes ready after Grok Bot claims it and replies.{" "}
          <Button type="button" variant="link" onClick={() => void onChanged()}>
            Refresh status
          </Button>
        </p>
      )}
      <ConfirmDialog
        open={confirmRetry}
        onOpenChange={setConfirmRetry}
        title="Retry this assignment?"
        description="Check the run in Grok Bot first. It may have completed work in another app. Retrying starts a new attempt and could repeat that work."
        confirmLabel="Retry assignment"
        loading={action.isPending}
        onConfirm={() => action.mutateAsync("retry")}
      />
    </form>
  )
}
