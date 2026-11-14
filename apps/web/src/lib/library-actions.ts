import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import { useCallback } from "react"
import { toast } from "@worktable/ui/components/sonner"
import { activityQueryKeys } from "./activity.ts"
import { documentQueryKeys } from "./documents-queries.ts"
import { HttpError, fetchJSON } from "./http.ts"
import { libraryQueryKey, type LibraryEntry } from "./library.ts"
import { useWorkspace } from "./queries.ts"
import { formatArchiveDate } from "./lifetime.ts"
import { formatDate } from "./time.tsx"

// Changing skill libraries. Only the Library page and the dialogs load
// this; a skill's Doc loads it when Save is pressed.

const PROPOSES: Record<NonNullable<LibraryEntry["proposal"]>["kind"], string> =
  {
    add: "proposes a new skill",
    update: "proposes an update",
    remove: "proposes removing it",
  }

/** What an agent's waiting proposal is, in the words every screen shares. */
export function proposalText(
  proposal: NonNullable<LibraryEntry["proposal"]>
): string {
  return `${proposal.by.displayName} ${PROPOSES[proposal.kind]}`
}

/** The name a library goes by: the Worktable's, the Space's, or the agent's. */
export function useLibraryName() {
  const { data: workspace } = useWorkspace()
  return (entry: Pick<LibraryEntry, "library" | "libraryName">): string =>
    entry.library.kind === "worktable"
      ? (workspace?.name ?? "This Worktable")
      : (entry.libraryName ??
        (entry.library.kind === "space" ? "Space" : "Agent"))
}

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/**
 * When something happened, as Home's rows say it: the time today, Yesterday,
 * the weekday this week, the date before that. Written out here so the
 * Library shares no code with Home beyond what every page already loads.
 */
export function when(iso: string, now = new Date()): string {
  const date = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days <= 0)
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })
  if (days === 1) return "Yesterday"
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "short" })
  return formatArchiveDate(iso)
}

/** Who made a skill's live version what agents get, and when. */
export function useSavedBy() {
  const { data: workspace } = useWorkspace()
  return (live: NonNullable<LibraryEntry["live"]>) => ({
    name:
      workspace?.presentations?.[live.savedBy]?.name ??
      // The person reading may have no entry of their own in that directory.
      (workspace?.person?.id === live.savedBy
        ? workspace.person.name
        : undefined) ??
      "Someone",
    when: when(live.savedAt),
    title: formatDate(live.savedAt),
  })
}

/** What a waiting change would change for agents. */
export interface SkillChange {
  revision: number
  live: string | null
  next: string | null
  nextDescription?: string
}

/**
 * Read when an open skill is compared with what agents have. `at` names what
 * waits, a proposal's revision or the Doc's last save, so a newer one reads
 * again.
 */
export function useSkillChange(id: string, at: string, enabled: boolean) {
  return useQuery({
    queryKey: [...libraryQueryKey, "change", id, at] as const,
    queryFn: () =>
      fetchJSON<SkillChange>(`/api/library/${encodeURIComponent(id)}/change`),
    enabled,
    staleTime: 0,
    gcTime: 0,
  })
}

/** A library change the person makes; each answers with what it changed. */
export type LibraryAction =
  | {
      kind: "save"
      entry: Pick<LibraryEntry, "id">
      /** The content the person looked at; other content is refused. */
      contentHash?: string
    }
  | {
      kind: "approve" | "discard"
      entry: Pick<LibraryEntry, "id" | "revision">
    }
  | { kind: "remove" | "restore"; entry: Pick<LibraryEntry, "id"> }

function runAction(action: LibraryAction): Promise<unknown> {
  const path = `/api/library/${encodeURIComponent(action.entry.id)}`
  if (action.kind === "remove") return fetchJSON(path, { method: "DELETE" })
  return fetchJSON(`${path}/${action.kind}`, {
    method: "POST",
    body: JSON.stringify(
      action.kind === "approve" || action.kind === "discard"
        ? { revision: action.entry.revision }
        : action.kind === "save" && action.contentHash
          ? { contentHash: action.contentHash }
          : {}
    ),
  })
}

const FAILED: Record<LibraryAction["kind"], string> = {
  save: "Couldn’t save this skill.",
  approve: "Couldn’t approve this change.",
  discard: "Couldn’t discard this change.",
  remove: "Couldn’t remove this skill.",
  restore: "Couldn’t restore this skill.",
}

export interface AddToLibraryInput {
  spaceId: string
  path: string
  name: string
  description: string
  library:
    | { kind: "worktable" }
    | { kind: "space"; spaceId: string }
    | { kind: "agent"; participantId: string }
}

/** Read again only the Library and Pending, which show proposals. */
function refreshLibrary(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: libraryQueryKey, exact: true }),
    queryClient.invalidateQueries({ queryKey: activityQueryKeys.pending }),
  ])
}

/**
 * Change a library, then read it again. A change someone else made first
 * (409) shows the server's reason and the fresh state.
 */
export async function performLibraryAction(
  queryClient: QueryClient,
  action: LibraryAction
): Promise<boolean> {
  try {
    await runAction(action)
    await refreshLibrary(queryClient)
    return true
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      toast.error(error.message)
      await refreshLibrary(queryClient)
    } else {
      console.error(FAILED[action.kind], error)
      toast.error(FAILED[action.kind])
    }
    return false
  }
}

export function useLibraryActions() {
  const queryClient = useQueryClient()
  const refresh = useCallback(() => refreshLibrary(queryClient), [queryClient])
  const run = useCallback(
    (action: LibraryAction) => performLibraryAction(queryClient, action),
    [queryClient]
  )
  /** Resolves with the server's reason when it refuses, for the dialog to show. */
  const add = useCallback(
    async (input: AddToLibraryInput): Promise<string | null> => {
      try {
        await fetchJSON("/api/library", {
          method: "POST",
          body: JSON.stringify(input),
        })
        // The Doc's own page now names it as a skill.
        await Promise.all([
          refresh(),
          queryClient.invalidateQueries({
            queryKey: documentQueryKeys.page(input.spaceId, input.path),
            exact: true,
          }),
        ])
        return null
      } catch (error) {
        if (error instanceof HttpError && error.status < 500)
          return error.message
        console.error("Couldn’t add to the library.", error)
        return "Couldn’t add to the library."
      }
    },
    [queryClient, refresh]
  )
  /** Rename or redescribe a skill; resolves like `add`. */
  const describe = useCallback(
    async (
      id: string,
      details: { name?: string; description?: string }
    ): Promise<string | null> => {
      try {
        await fetchJSON(`/api/library/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(details),
        })
        await refresh()
        return null
      } catch (error) {
        if (error instanceof HttpError && error.status < 500)
          return error.message
        console.error("Couldn’t change this skill.", error)
        return "Couldn’t change this skill."
      }
    },
    [refresh]
  )
  return { run, add, describe }
}
