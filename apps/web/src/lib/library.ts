import { queryOptions, useQuery } from "@tanstack/react-query"
import { useSkillLibrariesEnabled } from "@/hooks/use-deployment-info"
import { fetchJSON } from "./http.ts"

// Skill libraries: Docs people add for agents, live at a saved version.
// They ride with the preview agent tools; with those off, nothing here runs.
// Reading the library; changing one lives in library-actions.ts and what a
// screen shows of it in library-view.ts. A Doc learns whether it is a skill
// from its own page, not from here.

export type LibraryRef =
  | { kind: "worktable" }
  | { kind: "space"; spaceId: string }
  | { kind: "agent"; participantId: string }

/** One library entry as GET /api/library shows it to a person. */
export interface LibraryEntry {
  id: string
  name: string
  description: string
  library: LibraryRef
  doc: { spaceId: string; documentId: string }
  live: {
    generationId: string
    contentHash?: string
    savedAt: string
    savedBy: string
  } | null
  proposal: {
    kind: "add" | "update" | "remove"
    by: { participantId: string; displayName: string }
    at: string
  } | null
  removed: { at: string; by: string } | null
  /** Approving or discarding names the revision reviewed. */
  revision: number
  libraryLabel: string
  /** The Space's or agent's name; absent for the Worktable's library. */
  libraryName?: string
  /** Absent when the Doc no longer opens. */
  docPath?: string
  docTitle?: string
  /** The Doc was saved since its live version. */
  draft: boolean
  /** Whether this person may change the skill's library. */
  mayChange: boolean
}

/** A skill's own heading: its Doc's title, or its name while the Doc is gone. */
export const skillTitle = (entry: Pick<LibraryEntry, "docTitle" | "name">) =>
  entry.docTitle?.trim() || entry.name

/** One key per library, to group and filter by. */
export const libraryKey = (library: LibraryRef) =>
  library.kind === "space"
    ? `space:${library.spaceId}`
    : library.kind === "agent"
      ? `agent:${library.participantId}`
      : "worktable"

export const libraryQueryKey = ["library"] as const

/** The texts a person reads of one skill. */
export interface SkillTexts {
  /** What agents get now; null when nothing is live or it can't be read. */
  live: string | null
  /**
   * What waits: an agent's proposed text, or the Doc as last saved. Absent
   * when nothing waits or the proposal is to remove; null when unreadable.
   */
  next?: string | null
  /** The description an agent proposes, when it differs. */
  nextDescription?: string
}

/** Every skill a person may see, in one request. */
export interface Library {
  revision: number
  entries: LibraryEntry[]
}

export const libraryQueryOptions = () =>
  queryOptions({
    queryKey: libraryQueryKey,
    queryFn: () => fetchJSON<Library>("/api/library"),
  })

/** The Library's list; a revisit shows it at once and reads it again behind. */
export function useLibrary() {
  const enabled = useSkillLibrariesEnabled()
  return useQuery({ ...libraryQueryOptions(), enabled, staleTime: 0 })
}
