import { OperationStatus } from "../operation-status"
import { SettingsGroup } from "../settings-group"
import { WorkspaceClearControls } from "./workspace-clear"
import {
  recoverWorkspaceExport,
  workspaceExportDiagnosticsUrl,
} from "@/lib/workspace-transfer-api"
import { useRef, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArchiveRestore, ChevronDown, Download, Upload } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { Progress } from "@worktable/ui/components/progress"
import { SettingRow } from "@worktable/ui/components/setting-row"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { toast } from "@worktable/ui/components/sonner"
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
    <SettingsGroup title="Workspace">
      <ExportControls />
      <ImportControls />
      <WorkspaceClearControls />
    </SettingsGroup>
  )
}

function ExportControls() {
  const [option, setOption] = useState("all")
  const queryClient = useQueryClient()
  const policy =
    EXPORT_OPTIONS.find((candidate) => candidate.value === option)?.policy ??
    EXPORT_OPTIONS[0]!.policy
  const create = useMutation({
    mutationFn: () => createWorkspaceExport(policy),
    onSuccess: (job) => {
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
      return query.state.error
        ? 3000
        : state === "queued" || state === "running"
          ? 750
          : false
    },
  })

  const recover = useMutation({
    mutationFn: (id: string) => recoverWorkspaceExport(id),
    onSuccess: (next) =>
      queryClient.setQueryData(
        ["workspace-transfer", "export", "current"],
        next
      ),
    onError: (error) => toast.error(error.message),
  })

  const working =
    create.isPending ||
    recover.isPending ||
    job.data?.state === "queued" ||
    job.data?.state === "running"
  const completedJob = job.data?.state === "complete" ? job.data : null

  const failedJob = !working && job.data?.state === "failed" ? job.data : null
  const recoveryAvailable = Boolean(failedJob?.failure?.recoveryFingerprint)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-2">
          <label htmlFor="export-history" className="text-sm font-medium">
            Version history
          </label>
          <Select
            value={option}
            onValueChange={(value) => {
              if (value) setOption(value)
            }}
            disabled={working}
          >
            <SelectTrigger id="export-history" className="w-44">
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
        <div className="flex flex-wrap items-center gap-2">
          {completedJob ? (
            <>
              <Button
                nativeButton={false}
                render={
                  <a href={workspaceExportDownloadUrl(completedJob.id)} />
                }
              >
                <Download className="size-4" />
                Download
              </Button>
              <Button
                variant="outline"
                onClick={() => create.mutate()}
                disabled={working}
              >
                New export
              </Button>
            </>
          ) : (
            <>
              <Button
                variant={recoveryAvailable ? "outline" : "default"}
                onClick={() => create.mutate()}
                disabled={working}
              >
                <Download className="size-4" />
                Export
              </Button>
              {recoveryAvailable && failedJob ? (
                <Button
                  onClick={() => recover.mutate(failedJob.id)}
                  disabled={working}
                >
                  Skip files
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
      {job.isError ? (
        <OperationStatus state="attention">Reconnecting…</OperationStatus>
      ) : working ? (
        <OperationStatus state="working">
          {job.data?.state === "queued"
            ? "Waiting to export…"
            : EXPORT_PHASES[job.data?.progress ?? "inventory"]}
        </OperationStatus>
      ) : completedJob ? (
        <OperationStatus state="success">
          {completedJob.manifest?.history.recovery
            ? `Export ready — ${completedJob.manifest.history.recovery.omittedFiles.toLocaleString()} history ${completedJob.manifest.history.recovery.omittedFiles === 1 ? "file" : "files"} omitted.`
            : "Export ready."}
          {completedJob.bytes ? (
            <span className="ml-2 text-xs text-muted-foreground">
              {humanBytes(completedJob.bytes)}
            </span>
          ) : null}
        </OperationStatus>
      ) : failedJob ? (
        <OperationStatus state={failedJob.failure ? "attention" : "error"}>
          {failedJob.failure?.code === "NON_PORTABLE_HISTORY"
            ? `${failedJob.failure.affectedFiles.toLocaleString()} history ${failedJob.failure.affectedFiles === 1 ? "file blocks" : "files block"} export.`
            : failedJob.failure
              ? "Some filenames need attention."
              : "Export failed."}
        </OperationStatus>
      ) : null}
      {failedJob ? (
        <TransferDetails title="Details">
          {failedJob.failure ? (
            <>
              <ul className="flex max-h-48 flex-col gap-2 overflow-auto">
                {failedJob.failure.issues.map((issue) => (
                  <li key={issue.path}>
                    <code className="text-xs break-all whitespace-pre-wrap">
                      {displayExportPath(issue.path)}
                    </code>
                    <span className="block text-xs text-muted-foreground">
                      {issue.code.replaceAll("-", " ")}
                    </span>
                  </li>
                ))}
              </ul>
              {failedJob.failure.truncated ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing {failedJob.failure.issues.length} of{" "}
                  {failedJob.failure.issueCount} issues.
                </p>
              ) : null}
              <a
                className="mt-3 inline-block whitespace-nowrap underline"
                href={workspaceExportDiagnosticsUrl(failedJob.id)}
              >
                Download report
              </a>
            </>
          ) : (
            <p className="text-muted-foreground">
              {failedJob.error ?? "Try exporting again."}
            </p>
          )}
        </TransferDetails>
      ) : null}
    </div>
  )
}

function ImportControls() {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
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
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Worktable replacement failed."
      ),
  })

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

  const chooseLabel =
    uploadingJob && uploadingJob.receivedBytes > 0
      ? "Resume upload…"
      : ready
        ? "Choose another…"
        : "Choose file…"

  return (
    <div className="-mx-4 flex flex-col gap-3 border-t border-border/60 px-4 pt-3">
      {job.isError ? (
        <OperationStatus state="attention">Reconnecting…</OperationStatus>
      ) : null}
      <SettingRow
        label="Import workspace"
        description="Replace content from a Worktable package."
      >
        <Button
          variant="outline"
          aria-label={chooseLabel}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="size-4" />
          {chooseLabel}
        </Button>
      </SettingRow>
      <div
        className={
          job.data || upload.isPending ? "flex flex-col gap-3" : "hidden"
        }
      >
        <input
          ref={inputRef}
          className="hidden"
          aria-label="Import package"
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
          <OperationStatus state="working">
            {job.data.state === "verifying"
              ? "Verifying package…"
              : "Preparing import…"}
          </OperationStatus>
        ) : null}

        {job.data?.state === "failed" ? (
          <OperationStatus state="error">
            {job.data.error ?? "Import failed."}
          </OperationStatus>
        ) : null}

        {ready?.state === "ready" && ready.prepared ? (
          <div className="text-sm">
            <p className="font-medium text-foreground">
              {ready.prepared.source.workspaceName}
            </p>
            <p className="mt-1 text-muted-foreground">
              Exported {new Date(ready.prepared.exportedAt).toLocaleString()} ·{" "}
              {humanBytes(ready.prepared.bytes)} ·{" "}
              {ready.prepared.files.toLocaleString()} files
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          {ready?.state === "ready" ? (
            <Button disabled={busy} onClick={() => setConfirming(true)}>
              <ArchiveRestore className="size-4" />
              Replace Worktable
            </Button>
          ) : null}
          {uploadedJob ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => prepare.mutate(uploadedJob.id)}
            >
              Retry
            </Button>
          ) : null}
          {job.data?.state === "replacing" ? (
            <OperationStatus state="working">
              Reconnecting after replacement…
            </OperationStatus>
          ) : null}
        </div>
      </div>

      {ready?.state === "ready" && ready.prepared ? (
        <TransferDetails title="History details">
          <p className="text-muted-foreground">{historySummary(ready)}</p>
        </TransferDetails>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        variant="destructive"
        title="Replace this Worktable?"
        description={`Replace all content and history with ${ready?.prepared?.source.workspaceName ?? "this package"}? This can’t be undone.`}
        confirmLabel="Replace Worktable"
        loading={replace.isPending}
        loadingLabel="Starting replacement…"
        onConfirm={() => {
          if (ready?.id) replace.mutate(ready.id)
        }}
      />
    </div>
  )
}

function TransferDetails({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <Collapsible className="border-t border-border/60">
      <CollapsibleTrigger className="flex min-h-12 w-full items-center justify-between gap-3 py-2.5 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-muted/30 focus-visible:ring-3 focus-visible:ring-ring/50 [&[data-panel-open]>svg]:rotate-180">
        {title}
        <ChevronDown
          className="size-4 shrink-0 transition-transform motion-reduce:transition-none"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pb-1 text-sm">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const EXPORT_PHASES = {
  inventory: "Preparing export…",
  history: "Preparing export…",
  capture: "Preparing export…",
  viewer: "Preparing export…",
  archive: "Creating export…",
  finalize: "Finalizing export…",
} as const

function displayExportPath(path: string): string {
  return path
    .split("/")
    .map((part) => part.replace(/ +$/u, (spaces) => "␠".repeat(spaces.length)))
    .join("/")
    .split("")
    .map((char) =>
      char.charCodeAt(0) < 32
        ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
        : char
    )
    .join("")
}
