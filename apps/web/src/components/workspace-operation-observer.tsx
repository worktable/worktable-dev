import { getVisibleSettingsSection } from "@/lib/settings-open"
import { useEffect, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@worktable/ui/components/sonner"
import { useWorkspace } from "@/lib/queries"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import {
  getCurrentWorkspaceExportJob,
  getCurrentWorkspaceImportJob,
  getCurrentWorkspaceClearJob,
  prepareWorkspaceImport,
} from "@/lib/workspace-transfer-api"

import {
  exportJobKey,
  importJobKey,
  clearJobKey,
} from "@/lib/workspace-transfer-api"

/** Mount above Settings so closing a dialog does not abandon operation observation. */
export function WorkspaceOperationObserver() {
  const workspace = useWorkspace()
  const deployment = useDeploymentInfo()
  const client = useQueryClient()
  const enabled = workspace.data?.canManage === true
  const seen = useRef(new Map<string, string>())
  const preparing = useRef(new Set<string>())
  const exported = useQuery({
    queryKey: exportJobKey,
    queryFn: getCurrentWorkspaceExportJob,
    enabled,
    refetchInterval: (q) =>
      q.state.error
        ? 3000
        : ["queued", "running"].includes(q.state.data?.state ?? "")
          ? 750
          : 15_000,
  })
  const imported = useQuery({
    queryKey: importJobKey,
    queryFn: getCurrentWorkspaceImportJob,
    enabled,
    refetchInterval: (q) =>
      q.state.error
        ? 3000
        : ["verifying", "uploaded", "preparing", "replacing"].includes(
              q.state.data?.state ?? ""
            )
          ? 1000
          : 15_000,
  })
  const cleared = useQuery({
    queryKey: clearJobKey,
    queryFn: getCurrentWorkspaceClearJob,
    enabled: enabled && deployment.data?.capabilities.workspaceClear === true,
    refetchInterval: (q) =>
      q.state.error
        ? 3000
        : ["preparing", "replacing"].includes(q.state.data?.state ?? "")
          ? 1000
          : 15_000,
  })

  useEffect(() => {
    const job = imported.data
    if (job?.state !== "uploaded" || preparing.current.has(job.id)) return
    preparing.current.add(job.id)
    void prepareWorkspaceImport(job.id)
      .then((next) => {
        client.setQueryData(importJobKey, { ...job, ...next })
      })
      .catch(() => {
        toast.error(
          "Couldn’t prepare the import. Try preparation again in Settings."
        )
      })
  }, [imported.data, client])

  useEffect(() => {
    for (const job of [exported.data, imported.data, cleared.data]) {
      if (!job) continue
      const previous = seen.current.get(job.id)
      seen.current.set(job.id, job.state)
      // Another tab can miss every intermediate state of a fast replacement.
      // Refresh content identity independently of transition-only notifications.
      if (
        job.kind !== "export" &&
        previous !== job.state &&
        ["complete", "failed"].includes(job.state)
      )
        void client.invalidateQueries({ queryKey: ["workspace"] })
      if (
        !previous ||
        previous === job.state ||
        !["complete", "failed"].includes(job.state)
      )
        continue
      const marker = `worktable-operation:${workspace.data?.id}:${job.id}:${job.state}`
      try {
        if (localStorage.getItem(marker)) continue
        localStorage.setItem(marker, "seen")
      } catch {
        /* announcements still work without persistence */
      }
      if (!document.hidden && getVisibleSettingsSection() === "portability")
        continue
      if (job.state === "failed")
        toast.error(
          `${job.kind === "clear" ? "Workspace clear" : job.kind === "export" ? "Export" : "Import"} needs attention. Review it in Settings.`
        )
      else if (job.kind === "export")
        toast.success(
          job.manifest?.history.recovery
            ? "Export ready with omitted history. Review it in Settings."
            : "Worktable export is ready to download."
        )
      else
        toast.success(
          job.kind === "clear" ? "Workspace cleared." : "Worktable imported."
        )
    }
  }, [exported.data, imported.data, cleared.data, workspace.data?.id, client])

  useEffect(() => {
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ["workspace"] })
    }
    const visible = () => {
      if (!document.hidden) refresh()
    }
    window.addEventListener("worktable:workspace-refresh", refresh)
    window.addEventListener("online", refresh)
    document.addEventListener("visibilitychange", visible)
    return () => {
      window.removeEventListener("worktable:workspace-refresh", refresh)
      window.removeEventListener("online", refresh)
      document.removeEventListener("visibilitychange", visible)
    }
  }, [client])
  return null
}
