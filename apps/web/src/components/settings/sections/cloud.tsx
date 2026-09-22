import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@worktable/ui/components/button"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { fetchJSON } from "@/lib/http"
import { useSettingsSectionActive } from "../settings-dialog"

type Status = {
  state: string
  cloudOrigin: string
  mcpUrl?: string
  label?: string
}
const STATES: Record<string, string> = {
  unlinked: "Connect this device",
  awaiting_approval: "Waiting for sign-in",
  connecting: "Connecting…",
  online: "Connected",
  offline: "Offline",
  locked: "Subscription required",
  paused: "Paused",
  revoked: "Device unlinked",
  unlinking: "Unlinking…",
  error: "Could not connect",
}

export function CloudSection() {
  const active = useSettingsSectionActive()
  const client = useQueryClient()
  const [approveUrl, setApproveUrl] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [copied, setCopied] = useState(false)
  const query = useQuery({
    queryKey: ["linked"],
    queryFn: () => fetchJSON<Status>("/api/linked"),
    enabled: active,
    refetchInterval: active ? 5000 : false,
  })
  useEffect(() => {
    void client.invalidateQueries({ queryKey: ["system", "deployment"] })
  }, [client, query.data?.state])
  const begin = useMutation({
    mutationFn: () =>
      fetchJSON<{ url: string }>("/api/linked", { method: "POST" }),
    onSuccess: (data) => {
      setApproveUrl(data.url)
      void client.invalidateQueries({ queryKey: ["linked"] })
    },
  })
  const disconnect = useMutation({
    mutationFn: () => fetchJSON<Status>("/api/linked", { method: "DELETE" }),
    onSuccess: () => {
      setConfirm(false)
      setApproveUrl(null)
      void client.invalidateQueries({ queryKey: ["linked"] })
      void client.invalidateQueries({ queryKey: ["system"] })
    },
  })
  if (query.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking connection…
      </p>
    )
  if (query.isError)
    return (
      <div>
        <p className="text-sm text-muted-foreground">
          Could not check this device.
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    )
  const data = query.data
  const unlinked = data.state === "unlinked"
  const needsApproval = data.state === "awaiting_approval"
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium">
          {STATES[data.state] ?? "Connecting…"}
        </h3>
        {unlinked && (
          <p className="mt-2 text-sm text-muted-foreground">
            Connect AI apps and share documents through Worktable Cloud. This
            device must stay online.
          </p>
        )}
        {data.state === "offline" && (
          <p className="mt-2 text-sm text-muted-foreground">
            Reconnecting automatically when this device is online.
          </p>
        )}
      </div>
      {(begin.isError || disconnect.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {(begin.error ?? disconnect.error)?.message}
        </p>
      )}
      {(unlinked || needsApproval) &&
        (approveUrl ? (
          <Button
            nativeButton={false}
            render={<a href={approveUrl} target="_blank" rel="noreferrer" />}
          >
            Continue in browser
          </Button>
        ) : (
          <Button disabled={begin.isPending} onClick={() => begin.mutate()}>
            {begin.isPending ? "Connecting…" : "Link with Worktable Cloud"}
          </Button>
        ))}
      {needsApproval && approveUrl && (
        <Button
          variant="ghost"
          disabled={begin.isPending}
          onClick={() => begin.mutate()}
        >
          Start again
        </Button>
      )}
      {data.mcpUrl && (
        <div className="flex flex-col gap-2">
          <label htmlFor="linked-mcp" className="text-sm font-medium">
            MCP URL
          </label>
          <input
            id="linked-mcp"
            className="well h-10 rounded-xl px-3 text-sm"
            readOnly
            value={data.mcpUrl}
          />
          <div>
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  .writeText(data.mcpUrl!)
                  .then(() => setCopied(true))
              }
            >
              {copied ? "Copied" : "Copy URL"}
            </Button>
          </div>
        </div>
      )}
      {!unlinked && (
        <div className="flex items-center gap-4">
          <a
            className="text-sm text-primary underline"
            href={`${data.cloudOrigin}/linked`}
            target="_blank"
            rel="noreferrer"
          >
            Manage devices
          </a>
          <Button
            variant="ghost"
            disabled={data.state === "unlinking"}
            onClick={() => setConfirm(true)}
          >
            Unlink this device
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Unlink this device?"
        description="Connected AI apps and shared links will stop working. Your local documents stay here."
        confirmLabel="Unlink device"
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </section>
  )
}
