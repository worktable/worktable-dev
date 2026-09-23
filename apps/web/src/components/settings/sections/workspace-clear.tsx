import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import {
  createWorkspaceClear,
  getCurrentWorkspaceClearJob,
  confirmWorkspaceClear,
} from "@/lib/workspace-transfer-api"
import { clearJobKey } from "@/lib/workspace-transfer-api"
import { SettingRow } from "@worktable/ui/components/setting-row"
import { OperationStatus } from "../operation-status"

export function WorkspaceClearControls() {
  const deployment = useDeploymentInfo()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [phrase, setPhrase] = useState("")
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])
  const enabled = deployment.data?.capabilities.workspaceClear === true
  const job = useQuery({
    queryKey: clearJobKey,
    queryFn: getCurrentWorkspaceClearJob,
    enabled,
    refetchInterval: (q) =>
      ["preparing", "replacing"].includes(q.state.data?.state ?? "")
        ? 1000
        : false,
  })
  const prepare = useMutation({
    mutationFn: createWorkspaceClear,
    onSuccess: (next) => {
      client.setQueryData(clearJobKey, next)
      setPhrase("")
      setOpen(true)
    },
  })
  const confirm = useMutation({
    mutationFn: () => {
      if (!job.data) throw new Error("Review the workspace again.")
      return confirmWorkspaceClear(job.data, phrase)
    },
    onSuccess: (next) => {
      client.setQueryData(clearJobKey, next)
      if (next.state === "replacing" || next.state === "complete") {
        setOpen(false)
        setPhrase("")
      }
    },
  })
  if (!enabled) return null
  const busy =
    prepare.isPending ||
    job.data?.state === "preparing" ||
    job.data?.state === "replacing"
  const ready =
    job.data?.state === "ready" && Date.parse(job.data.expiresAt) > now
  const error = confirm.error ?? prepare.error
  return (
    <div className="-mx-4 flex flex-col gap-3 border-t border-border/60 px-4 pt-3">
      <SettingRow label="Clear workspace">
        <Button
          variant="outline"
          disabled={busy}
          aria-label="Clear workspace…"
          onClick={() => {
            confirm.reset()
            prepare.mutate()
          }}
        >
          Clear…
        </Button>
      </SettingRow>
      {!open && busy ? (
        <OperationStatus state="working">
          {job.data?.state === "replacing"
            ? "Clearing workspace…"
            : "Preparing…"}
        </OperationStatus>
      ) : null}
      {job.data?.state === "complete" ? (
        <OperationStatus
          state="success"
          detail={
            job.data.cleanupPending ? "Finishing local cleanup…" : undefined
          }
        >
          Workspace cleared.
        </OperationStatus>
      ) : null}
      {!open && job.data?.state === "failed" ? (
        <OperationStatus state="error">
          {job.data.error ?? "Workspace clear failed. Review and try again."}
        </OperationStatus>
      ) : null}
      {!open && error ? (
        <OperationStatus state="error">{error.message}</OperationStatus>
      ) : null}
      {!open && job.isError && busy ? (
        <OperationStatus state="attention">Reconnecting…</OperationStatus>
      ) : null}
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setPhrase("")
        }}
        variant="destructive"
        title={`Clear ${job.data?.workspaceName ?? "workspace"}?`}
        description="Permanently deletes all content and history and disconnects Worktable Cloud."
        confirmLabel="Clear workspace"
        confirmDisabled={!ready || phrase !== job.data?.confirmationText}
        loading={confirm.isPending}
        loadingLabel="Starting clear…"
        onConfirm={() => {
          confirm.mutate()
        }}
      >
        <div className="flex flex-col gap-3">
          {!ready ? (
            job.data?.state === "ready" || (!job.data && !job.isPending) ? (
              <OperationStatus state="attention">
                Review expired. Close and try again.
              </OperationStatus>
            ) : job.data?.state === "failed" ? (
              <OperationStatus state="error">{job.data.error}</OperationStatus>
            ) : (
              <OperationStatus state="working">Preparing…</OperationStatus>
            )
          ) : null}
          <label htmlFor="workspace-clear-confirmation" className="text-sm">
            Type{" "}
            <strong className="select-all">{job.data?.confirmationText}</strong>{" "}
            to confirm.
          </label>
          <Input
            id="workspace-clear-confirmation"
            autoComplete="off"
            spellCheck={false}
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            disabled={!ready || confirm.isPending}
          />
          {job.data?.state === "ready" && job.data.error ? (
            <OperationStatus state="error">{job.data.error}</OperationStatus>
          ) : null}
          {confirm.error ? (
            <OperationStatus state="error">
              {confirm.error.message}
            </OperationStatus>
          ) : null}
        </div>
      </ConfirmDialog>
    </div>
  )
}
