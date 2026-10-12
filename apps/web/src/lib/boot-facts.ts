import type { QueryClient } from "@tanstack/react-query"
import { BOOT_FACTS_ID, inlineScriptJson } from "@worktable/ui/lib/page-json"
import {
  acceptWorkspace,
  type WorkspaceInfo,
  type WorkspaceStorageUpgrade,
} from "./api"
import { noteServerBuildId } from "./build-version"
import { queryKeys, workspaceQueryOptions } from "./queries"

/**
 * What the server's REST reads would have told this tab at startup: the
 * storage upgrade state, the workspace once storage is ready, and the build
 * it serves. The server writes these into a signed-in navigation's page
 * (packages/server/src/boot-facts.ts); development pages and anyone not
 * signed in read them over the network instead.
 */
export interface BootFacts {
  build: string | null
  storageUpgrade: WorkspaceStorageUpgrade
  workspace?: WorkspaceInfo
}

// Captured once, before hydration.
const bootFacts: BootFacts | null = (() => {
  if (typeof document === "undefined") return null
  try {
    const facts = JSON.parse(
      document.getElementById(BOOT_FACTS_ID)?.textContent ?? "null"
    )
    return typeof facts?.storageUpgrade?.state === "string" ? facts : null
  } catch {
    return null
  }
})()

/** The shell renders the facts back unchanged, so its head hydrates as served. */
export const bootFactsJson = inlineScriptJson(bootFacts)

/**
 * Start the workspace queries the first render waits on, from the page when it
 * carries them. A summary from the page is adopted exactly as a read one is.
 */
export function startWorkspaceQueries(
  queryClient: QueryClient,
  facts = bootFacts
): void {
  const workspace = facts?.workspace
  if (facts) {
    noteServerBuildId(facts.build)
    queryClient.setQueryData(queryKeys.storageUpgrade, facts.storageUpgrade)
  }
  void queryClient.prefetchQuery(
    workspace
      ? {
          ...workspaceQueryOptions(),
          queryFn: () => acceptWorkspace(workspace),
        }
      : workspaceQueryOptions()
  )
}
