import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArchiveRestore, Download, Upload } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { Progress } from "@worktable/ui/components/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { toast } from "@worktable/ui/components/sonner"
import { clearPersistedThreadDrafts } from "@/lib/thread-drafts"
import { clearPersistedDrawingDrafts } from "@/lib/drawing-drafts"
import { useWorkspace } from "@/lib/queries"
import {
  canResumeWorkspaceImport,
  createWorkspaceExport,
  createWorkspaceImport,
  getCurrentWorkspaceExportJob,
  getCurrentWorkspaceImportJob,
  prepareWorkspaceImport,
  replaceWorkspaceFromImport,
  uploadWorkspaceImport,
  workspaceImportResumeFingerprint,
  workspaceExportDownloadUrl,
  type ExportHistoryPolicy,
  type WorkspaceImportCreated,
  type WorkspaceImportJob,
} from "@/lib/workspace-transfer-api"

const EXPORT_OPTIONS: Array<{
  value: string
  label: string
  policy: ExportHistoryPolicy
}> = [
  { value: "all", label: "All history", policy: { mode: "all" } },
  {
    value: "age-30",
    label: "Last 30 days",
    policy: { mode: "age", maxAgeDays: 30 },
  },
  {
    value: "count-50",
    label: "Last 50 per item",
    policy: { mode: "count", maxPerItem: 50 },
  },
  { value: "none", label: "No history", policy: { mode: "none" } },
]

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = units[0]!
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]!
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

function historySummary(job: WorkspaceImportJob): string {
  const history = job.prepared?.history ?? job.manifest?.history
  if (!history) return "History summary unavailable."
  return `${history.includedFiles.toLocaleString()} history files included${history.omittedFiles ? `, ${history.omittedFiles.toLocaleString()} omitted` : ""}.`
}

export function PortabilitySection() {
  return (
    <div className="flex flex-col gap-6">
      <ExportGroup />
      <ImportGroup />
    </div>
  )
}

function ExportGroup() {
  const [option, setOption] = useState("all")
  const queryClient = useQueryClient()
  const announced = useRef<string | null>(null)
  const policy =
    EXPORT_OPTIONS.find((candidate) => candidate.value === option)?.policy ??
    EXPORT_OPTIONS[0]!.policy
  const create = useMutation({
    mutationFn: () => createWorkspaceExport(policy),
    onSuccess: (job) => {
      announced.current = null
      queryClient.setQueryData(["workspace-transfer", "export", "current"], job)
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Couldn’t start the export."
      ),
  })
  const job = useQuery({
    queryKey: ["workspace-transfer", "export", "current"],
    queryFn: getCurrentWorkspaceExportJob,
    refetchInterval: (query) => {
      const state = query.state.data?.state
      return state === "queued" || state === "running" ? 750 : false
    },
  })

  useEffect(() => {
    if (job.data?.state === "complete" && announced.current !== job.data.id) {
      announced.current = job.data.id
      toast.success("Worktable export is ready to download.")
    } else if (
      job.data?.state === "failed" &&
      announced.current !== job.data.id
    ) {
      announced.current = job.data.id
      toast.error(job.data.error ?? "Worktable export failed.")
    }
  }, [job.data])

  const working =
    create.isPending ||
    job.data?.state === "queued" ||
    job.data?.state === "running"
  const completedJob = job.data?.state === "complete" ? job.data : null

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Export</h3>
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
        <div className="flex max-w-52 flex-col gap-1.5">
          <span className="text-xs font-medium tracking-wide text-foreground/70">
            Version history
          </span>
          <Select
            value={option}
            onValueChange={(value) => {
              if (value) setOption(value)
            }}
            disabled={working}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {EXPORT_OPTIONS.find((candidate) => candidate.value === option)
                  ?.label ?? "All history"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {EXPORT_OPTIONS.map((candidate) => (
                <SelectItem key={candidate.value} value={candidate.value}>
                  {candidate.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {completedJob ? (
            <Button
              nativeButton={false}
              render={<a href={workspaceExportDownloadUrl(completedJob.id)} />}
            >
              <Download className="size-4" />
              Download {completedJob.downloadName ?? "worktable.wtb"}
            </Button>
          ) : (
            <Button onClick={() => create.mutate()} disabled={working}>
              <Download className="size-4" />
              {working ? "Preparing export…" : "Export Worktable"}
            </Button>
          )}
          {completedJob?.bytes ? (
            <span className="text-xs text-muted-foreground">
              {humanBytes(completedJob.bytes)}
            </span>
          ) : null}
          {completedJob ? (
            <Button
              variant="ghost"
              onClick={() => create.mutate()}
              disabled={create.isPending}
            >
              Create another
            </Button>
          ) : null}
        </div>
        {job.data?.state === "failed" ? (
          <Callout variant="danger">
            {job.data.error ?? "Worktable export failed."} You can try the
            export again.
          </Callout>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Import to another Worktable or extract it plainly as a ZIP file.
        </p>
      </div>
    </section>
  )
}

function ImportGroup() {
  const queryClient = useQueryClient()
  const workspaceQuery = useWorkspace()
  const inputRef = useRef<HTMLInputElement>(null)
  const announced = useRef<string | null>(null)
  const autoPrepared = useRef<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const queryKey = ["workspace-transfer", "import", "current"] as const

  const job = useQuery({
    queryKey,
    queryFn: getCurrentWorkspaceImportJob,
    refetchInterval: (query) =>
      query.state.data?.state === "verifying" ||
      query.state.data?.state === "preparing" ||
      query.state.data?.state === "replacing"
        ? 1_000
        : false,
    retry: 2,
  })

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const current = job.data
      const resumeFingerprint = await workspaceImportResumeFingerprint(file)
      const canResume = canResumeWorkspaceImport(
        file,
        current,
        resumeFingerprint
      )
      const created =
        canResume && current
          ? current
          : await createWorkspaceImport(file, resumeFingerprint)
      setProgress(created.receivedBytes / file.size)
      queryClient.setQueryData(queryKey, created)
      const uploaded = await uploadWorkspaceImport(
        file,
        created,
        (received) => setProgress(received / file.size),
        { resumeFingerprint }
      )
      queryClient.setQueryData(
        queryKey,
        (existing: WorkspaceImportCreated | null | undefined) =>
          existing ? { ...existing, ...uploaded } : created
      )
      return uploaded
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey })
      toast.error(
        error instanceof Error ? error.message : "Couldn’t import the package."
      )
    },
  })

  const prepare = useMutation({
    mutationFn: (id: string) => prepareWorkspaceImport(id),
    onSuccess: (preparing) => {
      queryClient.setQueryData(
        queryKey,
        (existing: WorkspaceImportCreated | null | undefined) =>
          existing ? { ...existing, ...preparing } : existing
      )
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey })
      toast.error(
        error instanceof Error
          ? error.message
          : "The Worktable package could not be prepared."
      )
    },
  })

  const replace = useMutation({
    mutationFn: (id: string) => replaceWorkspaceFromImport(id),
    onSuccess: (replacing) => {
      setConfirming(false)
      queryClient.setQueryData(
        queryKey,
        (existing: WorkspaceImportCreated | null | undefined) =>
          existing ? { ...existing, ...replacing } : existing
      )
      toast.message("Replacing Worktable. Reconnecting shortly.")
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Worktable replacement failed."
      ),
  })

  useEffect(() => {
    if (
      job.data?.state === "uploaded" &&
      autoPrepared.current !== job.data.id
    ) {
      autoPrepared.current = job.data.id
      prepare.mutate(job.data.id)
    }
  }, [job.data, prepare])

  useEffect(() => {
    if (job.data?.state === "complete" && announced.current !== job.data.id) {
      announced.current = job.data.id
      if (workspaceQuery.data?.id) {
        clearPersistedThreadDrafts(workspaceQuery.data.id)
        clearPersistedDrawingDrafts(workspaceQuery.data.id)
      }
      toast.success("Worktable imported. Name and account preserved.")
      void queryClient.invalidateQueries()
    } else if (
      job.data?.state === "failed" &&
      announced.current !== job.data.id
    ) {
      announced.current = job.data.id
      toast.error(job.data.error ?? "Worktable replacement failed.")
    }
  }, [job.data, queryClient, workspaceQuery.data?.id])

  const ready = job.data?.state === "ready" ? job.data : null
  const uploadingJob = job.data?.state === "uploading" ? job.data : null
  const uploadedJob = job.data?.state === "uploaded" ? job.data : null
  const waitingForFile = uploadingJob !== null
  const displayedProgress = upload.isPending
    ? progress
    : uploadingJob
      ? uploadingJob.receivedBytes / uploadingJob.expectedBytes
      : progress
  const busy =
    upload.isPending ||
    prepare.isPending ||
    replace.isPending ||
    job.data?.state === "replacing" ||
    job.data?.state === "verifying" ||
    job.data?.state === "preparing"

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">
        Import and replace
      </h3>
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
        <Callout variant="warning">
          Imports replace all content and history.
        </Callout>

        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept=".wtb,.zip,application/zip,application/vnd.worktable.workspace+zip"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ""
            if (file) upload.mutate(file)
          }}
        />

        {upload.isPending || waitingForFile ? (
          <div className="space-y-2" aria-live="polite">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                {upload.isPending
                  ? "Uploading package…"
                  : uploadingJob && uploadingJob.receivedBytes > 0
                    ? `Reselect ${uploadingJob.fileName} to continue`
                    : "Select the package to upload"}
              </span>
              <span>{Math.round(displayedProgress * 100)}%</span>
            </div>
            <Progress value={displayedProgress * 100} />
          </div>
        ) : null}

        {job.data?.state === "verifying" ||
        job.data?.state === "preparing" ||
        job.data?.state === "uploaded" ? (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {job.data.state === "verifying"
              ? "Verifying package integrity…"
              : "Preparing a safe replacement…"}
          </p>
        ) : null}

        {job.data?.state === "failed" ? (
          <Callout variant="danger">
            {job.data.error ?? "Worktable import failed."} Choose the package
            again to retry.
          </Callout>
        ) : null}

        {ready?.state === "ready" && ready.prepared ? (
          <div className="rounded-lg bg-muted/60 p-3 text-sm">
            <p className="font-medium text-foreground">
              {ready.prepared.source.workspaceName}
            </p>
            <p className="mt-1 text-muted-foreground">
              Exported {new Date(ready.prepared.exportedAt).toLocaleString()} ·{" "}
              {humanBytes(ready.prepared.bytes)} ·{" "}
              {ready.prepared.files.toLocaleString()} files
            </p>
            <p className="mt-1 text-muted-foreground">
              {historySummary(ready)}
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="size-4" />
            {uploadingJob && uploadingJob.receivedBytes > 0
              ? "Reselect package to continue"
              : ready?.state === "ready"
                ? "Choose a different package"
                : "Choose .wtb package"}
          </Button>
          {ready?.state === "ready" ? (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              <ArchiveRestore className="size-4" />
              Replace Worktable
            </Button>
          ) : null}
          {uploadedJob && prepare.isError ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => prepare.mutate(uploadedJob.id)}
            >
              Try preparation again
            </Button>
          ) : null}
          {job.data?.state === "replacing" ? (
            <span className="self-center text-sm text-muted-foreground">
              Reconnecting after replacement…
            </span>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        variant="destructive"
        title="Replace this Worktable?"
        description="This replaces all portable content and version history; it does not merge and can’t be undone."
        confirmLabel="Replace Worktable"
        loading={replace.isPending}
        loadingLabel="Starting replacement…"
        onConfirm={() => {
          if (ready?.id) replace.mutate(ready.id)
        }}
      >
        {ready?.prepared ? (
          <p className="text-sm text-muted-foreground">
            Import <strong>{ready.prepared.source.workspaceName}</strong> while
            keeping this Worktable&rsquo;s name and Cloud account.
          </p>
        ) : null}
      </ConfirmDialog>
    </section>
  )
}
