import type { ReactNode } from "react"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useRouterState } from "@tanstack/react-router"
import { Button } from "@worktable/ui/components/button"
import { WorktableAppIcon } from "./worktable-app-icon"
import { fetchJSON } from "@/lib/http"

interface UpgradeStatus {
  state: "ready" | "upgrading" | "blocked"
  canRetry: boolean
}

/** Mount editors only after the server has admitted the workspace storage. */
export function WorkspaceStorageGate({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const publicRoute = ["/login", "/signed-out", "/logout", "/share"].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  )
  const [retryError, setRetryError] = useState(false)
  const status = useQuery({
    queryKey: ["workspace-storage-upgrade"],
    queryFn: () =>
      fetchJSON<UpgradeStatus>("/api/workspace/storage-upgrade", {
        cache: "no-store",
      }),
    enabled: !publicRoute,
    refetchInterval: (query) =>
      query.state.data?.state === "ready" ? false : 1500,
    retry: false,
  })
  if (publicRoute || status.data?.state === "ready") return children
  const blocked = status.data?.state === "blocked"
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
      <div
        className="flex max-w-md flex-col items-center gap-4 text-center"
        role="status"
        aria-live="polite"
      >
        <WorktableAppIcon className="size-12" />
        <h1 className="text-xl font-semibold">
          {blocked
            ? "Workspace upgrade needs attention"
            : status.data
              ? "Upgrading your workspace"
              : "Opening Worktable"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {blocked
            ? "Your workspace has been preserved. The server logs explain what needs fixing before you can continue."
            : status.data
              ? "Your documents are being prepared for this version of Worktable. This page will open when they’re ready."
              : status.isError
                ? "Waiting for Worktable to reconnect."
                : "Connecting to your workspace."}
        </p>
        {blocked && status.data?.canRetry && (
          <Button
            onClick={async () => {
              setRetryError(false)
              try {
                await fetchJSON("/api/workspace/storage-upgrade/retry", {
                  method: "POST",
                })
                await status.refetch()
              } catch {
                setRetryError(true)
              }
            }}
          >
            Retry upgrade
          </Button>
        )}
        {retryError && (
          <p className="text-sm text-destructive">
            Couldn’t retry the upgrade. Check the connection and try again.
          </p>
        )}
      </div>
    </main>
  )
}
