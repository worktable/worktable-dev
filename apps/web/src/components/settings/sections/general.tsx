import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@worktable/ui/components/sonner"
import { Callout } from "@worktable/ui/components/callout"
import { CopyField } from "@worktable/ui/components/copy-field"
import { Input } from "@worktable/ui/components/input"
import { updateWorkspace, type WorkspaceInfo } from "@/lib/api"
import { queryKeys, useWorkspace } from "@/lib/queries"
import { getConnection, type ConnectionInfo } from "@/lib/system-api"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { useServerSettings } from "@/hooks/use-server-settings"
import { useSettingsPatch } from "../use-settings-patch"

// The General section: workspace identity, agent-facing URL, and the on-disk
// root. The nav rail names the section, so the group header carries hierarchy.
export function GeneralSection() {
  return (
    <div className="flex flex-col gap-6">
      <WorkspaceGroup />
    </div>
  )
}

function WorkspaceGroup() {
  const deploymentQuery = useDeploymentInfo()
  const capabilities = deploymentQuery.data?.capabilities
  const workspaceQuery = useWorkspace()
  const connectionQuery = useQuery({
    queryKey: ["system", "connection"],
    queryFn: getConnection,
    staleTime: 30_000,
    enabled: capabilities?.workspaceUrl === true,
  })
  const workspace = workspaceQuery.data
  const connection = connectionQuery.data

  return (
    <section className="flex flex-col gap-5">
      {workspaceQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading Worktable…</p>
      ) : workspaceQuery.isError || !workspace ? (
        <p className="text-sm text-muted-foreground">
          Couldn’t read this Worktable.
        </p>
      ) : (
        <>
          <WorkspaceNameField workspace={workspace} />
          {capabilities?.workspaceUrl ? (
            <WorkspaceUrlField connection={connection} />
          ) : null}
          {capabilities?.workspacePath ? (
            <WorkspaceFolderField root={workspace.root} />
          ) : null}
        </>
      )}
    </section>
  )
}

// ── Name ─────────────────────────────────────────────────────────────────────

function WorkspaceNameField({ workspace }: { workspace: WorkspaceInfo }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState(workspace.name)

  // Re-seed when the persisted name changes (e.g. another tab renamed it).
  useEffect(() => setValue(workspace.name), [workspace.name])

  const mutation = useMutation({
    mutationFn: (name: string) => updateWorkspace({ name }),
    onSuccess: (info) => queryClient.setQueryData(queryKeys.workspace, info),
    onError: (err) => {
      setValue(workspace.name)
      toast.error(
        err instanceof Error ? err.message : "Couldn’t rename the Worktable."
      )
    },
  })

  // Commit on blur/Enter only when the trimmed value actually changed (the
  // rename-dialog idiom); an empty value reverts rather than clearing the name.
  function commit() {
    const trimmed = value.trim()
    if (!trimmed || trimmed === workspace.name) {
      setValue(workspace.name)
      return
    }
    mutation.mutate(trimmed)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor="workspace-name"
        className="text-sm font-medium text-foreground"
      >
        Name
      </label>
      <Input
        id="workspace-name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur()
        }}
      />
    </div>
  )
}

// ── Workspace URL ────────────────────────────────────────────────────────────

// Validate a public URL: an absolute http(s) origin with no path/query/hash.
// Empty is valid — it clears the setting back to auto-detect.
function validatePublicUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return "Enter a full URL, e.g. https://worktable.example.com"
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "URL must start with http:// or https://"
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return "Use the origin only, with no path — e.g. https://worktable.example.com"
  }
  return null
}

function originSourceLabel(source: ConnectionInfo["originSource"]): string {
  switch (source) {
    case "env":
      return "from environment"
    case "config":
      return "from this setting"
    case "resource":
      return "from hosted resource"
    case "request":
      return "auto-detected"
    default:
      return "fallback"
  }
}

function WorkspaceUrlField({
  connection,
}: {
  connection: ConnectionInfo | undefined
}) {
  const queryClient = useQueryClient()
  const settingsQuery = useServerSettings()
  const patch = useSettingsPatch()
  // The configured public origin is machine-local — it lives in the settings
  // store (`network.publicUrl`), not in the portable workspace manifest.
  const persisted = settingsQuery.data?.network.publicUrl ?? ""
  const [value, setValue] = useState(persisted)
  const [error, setError] = useState<string | null>(null)

  // Re-seed when the persisted value changes (server merge, another tab, etc.).
  useEffect(() => setValue(persisted), [persisted])

  const externallyManaged =
    connection?.originSource === "env" ||
    connection?.originSource === "resource"

  function commit() {
    const trimmed = value.trim()
    if (trimmed === persisted) {
      setError(null)
      setValue(persisted)
      return
    }
    const validationError = validatePublicUrl(trimmed)
    if (validationError) {
      setError(validationError)
      return
    }
    setError(null)
    // Empty string clears the setting server-side.
    patch.mutate(
      { network: { publicUrl: trimmed } },
      {
        onSuccess: () => {
          // The origin hint below and the Agents connect card are derived from
          // GET /api/system/connection — refresh it so both reflect the save.
          void queryClient.invalidateQueries({
            queryKey: ["system", "connection"],
          })
        },
        onError: () => setValue(persisted),
      }
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor="workspace-url"
        className="text-sm font-medium text-foreground"
      >
        Worktable URL
      </label>
      <Input
        id="workspace-url"
        value={value}
        placeholder="Auto-detected"
        disabled={externallyManaged || !settingsQuery.data}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setValue(e.target.value)
          if (error) setError(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur()
        }}
      />

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {connection?.originSource === "env" ? (
        <p className="text-sm text-muted-foreground">
          Set by{" "}
          <code className="inline-code-accent font-mono">
            WORKTABLE_PUBLIC_URL
          </code>
          .
        </p>
      ) : connection?.originSource === "resource" ? (
        <p className="text-sm text-muted-foreground">
          Set by the hosted{" "}
          <code className="inline-code-accent font-mono">
            WORKTABLE_RESOURCE_URL
          </code>
          .
        </p>
      ) : connection ? (
        <p className="text-sm text-muted-foreground">
          Currently resolving to{" "}
          <span className="font-mono text-foreground/80">
            {connection.origin}
          </span>{" "}
          ({originSourceLabel(connection.originSource)}).
        </p>
      ) : null}

      {connection?.reachable && !connection.originConfigured ? (
        <Callout variant="warning">
          Agent links use localhost until you set a Worktable URL.
        </Callout>
      ) : null}
    </div>
  )
}

// ── Workspace folder ─────────────────────────────────────────────────────────

function WorkspaceFolderField({ root }: { root: string | null | undefined }) {
  return (
    <div className="flex flex-col gap-1.5">
      {root ? (
        <CopyField label="Worktable folder" value={root} />
      ) : (
        <>
          <span className="text-sm font-medium text-foreground">
            Worktable folder
          </span>
          <p className="text-sm text-muted-foreground">Unknown.</p>
        </>
      )}
      <p className="text-sm text-muted-foreground">
        Change with{" "}
        <code className="inline-code-accent font-mono">worktable setup</code>{" "}
        from the terminal.
      </p>
    </div>
  )
}
