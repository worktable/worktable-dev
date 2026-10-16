import { useCallback } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  EMPTY_PERSONAL_NAVIGATION,
  type PersonalNavigation,
} from "@worktable/types"
import type { SpaceView, WorkspaceInfo } from "./api"
import { fetchJSON, HttpError } from "./http"
import { queryKeys, useSpaces, useWorkspace } from "./queries"
import { formatGroupLabel } from "./spaces"
import { toast } from "@worktable/ui/components/sonner"

/** What a change produces; the server assigns the revision. */
export type NavigationChange = (
  current: PersonalNavigation
) => Omit<PersonalNavigation, "revision">

/**
 * Before someone arranges anything, they start from the groups Spaces
 * already name. It is a copy: later changes are theirs alone.
 */
export function startingNavigation(
  spaces: readonly Pick<SpaceView, "id" | "group">[]
): PersonalNavigation {
  const groups = new Map<string, string>()
  const spaceGroups: Record<string, string> = {}
  for (const space of spaces) {
    if (!space.group) continue
    const id = `shared-${space.group.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 56)}`
    if (!groups.has(id)) groups.set(id, formatGroupLabel(space.group))
    spaceGroups[space.id] = id
  }
  const names = new Set<string>()
  const unique = [...groups].filter(([, name]) => {
    const key = name.toLocaleLowerCase()
    if (names.has(key)) return false
    names.add(key)
    return true
  })
  const kept = new Set(unique.map(([id]) => id))
  return {
    revision: 0,
    groups: unique.map(([id, name]) => ({ id, name })),
    spaceGroups: Object.fromEntries(
      Object.entries(spaceGroups).filter(([, id]) => kept.has(id))
    ),
    pins: [],
  }
}

export function newGroupId(): string {
  return `g-${crypto.randomUUID().slice(0, 12)}`
}

function savedNavigation(
  workspace: WorkspaceInfo | undefined,
  spaces: readonly SpaceView[] | undefined
): PersonalNavigation | null {
  if (!workspace || workspace.navigation === undefined) return null
  if (workspace.navigation) return workspace.navigation
  return spaces ? startingNavigation(spaces) : EMPTY_PERSONAL_NAVIGATION
}

function adopt(queryClient: QueryClient, navigation: PersonalNavigation) {
  queryClient.setQueryData<WorkspaceInfo>(queryKeys.workspace, (workspace) =>
    workspace ? { ...workspace, navigation } : workspace
  )
}

function conflictNavigation(error: unknown): PersonalNavigation | null {
  if (!(error instanceof HttpError) || error.status !== 409) return null
  const body = error.body as { navigation?: PersonalNavigation } | null
  return body?.navigation ?? null
}

function put(
  revision: number,
  next: Omit<PersonalNavigation, "revision">
): Promise<PersonalNavigation> {
  return fetchJSON<{ navigation: PersonalNavigation }>(
    "/api/profile/navigation",
    {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: revision, ...next }),
    }
  ).then((result) => result.navigation)
}

// One tab saves one change at a time, each applied to the latest value.
let queue: Promise<unknown> = Promise.resolve()

/**
 * The person's groups and pins. `navigation` is null for anyone who has none
 * to arrange, such as an agent session. A change shows at once and is saved
 * in the background; if another device saved first, it is applied again to
 * what that device saved.
 */
export function usePersonalNavigation() {
  const queryClient = useQueryClient()
  const { data: workspace } = useWorkspace()
  const { data: spaces } = useSpaces()
  const navigation = savedNavigation(workspace, spaces)

  const update = useCallback(
    (change: NavigationChange, failure = "Couldn't save your sidebar"): Promise<void> => {
      const run = async () => {
        const read = () =>
          savedNavigation(
            queryClient.getQueryData<WorkspaceInfo>(queryKeys.workspace),
            queryClient.getQueryData<SpaceView[]>(queryKeys.spaces)
          )
        const before = read()
        if (!before) return
        adopt(queryClient, { ...change(before), revision: before.revision })
        try {
          adopt(queryClient, await put(before.revision, change(before)))
        } catch (error) {
          const current = conflictNavigation(error)
          if (current) {
            try {
              adopt(queryClient, await put(current.revision, change(current)))
              return
            } catch {
              adopt(queryClient, current)
            }
          } else {
            adopt(queryClient, before)
          }
          toast.error(failure)
        }
      }
      const next = queue.then(run, run)
      queue = next.catch(() => undefined)
      return next
    },
    [queryClient]
  )

  return { navigation, update }
}

/** Another tab or device saved; read the summary again unless we already have it. */
export function noteNavigationChanged(
  queryClient: QueryClient,
  revision: unknown
): void {
  const workspace = queryClient.getQueryData<WorkspaceInfo>(queryKeys.workspace)
  const known = workspace?.navigation?.revision ?? 0
  if (typeof revision === "number" && revision <= known) return
  void queryClient.invalidateQueries({
    queryKey: queryKeys.workspace,
    exact: true,
  })
}

// ── Changes ───────────────────────────────────────────────────

const rest = ({ groups, spaceGroups, pins }: PersonalNavigation) => ({
  groups,
  spaceGroups,
  pins,
})

export function sortedGroups<T extends { name: string }>(groups: readonly T[]): T[] {
  return [...groups].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  )
}

export const togglePin =
  (spaceId: string): NavigationChange =>
  (current) => ({
    ...rest(current),
    pins: current.pins.includes(spaceId)
      ? current.pins.filter((id) => id !== spaceId)
      : [...current.pins, spaceId],
  })

export const moveToGroup =
  (spaceId: string, groupId: string | null): NavigationChange =>
  (current) => {
    const spaceGroups = { ...current.spaceGroups }
    if (groupId && current.groups.some((group) => group.id === groupId)) {
      spaceGroups[spaceId] = groupId
    } else {
      delete spaceGroups[spaceId]
    }
    return { ...rest(current), spaceGroups }
  }

/** Adds the group unless one with that name exists, then moves the Space into it. */
export const addGroup =
  (id: string, name: string, spaceId?: string): NavigationChange =>
  (current) => {
    const existing = current.groups.find(
      (group) => group.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase()
    )
    const groupId = existing?.id ?? id
    const groups = existing
      ? current.groups
      : [...current.groups, { id, name: name.trim() }]
    const spaceGroups = { ...current.spaceGroups }
    if (spaceId) spaceGroups[spaceId] = groupId
    return { ...rest(current), groups, spaceGroups }
  }

export const renameGroup =
  (groupId: string, name: string): NavigationChange =>
  (current) => ({
    ...rest(current),
    groups: current.groups.map((group) =>
      group.id === groupId ? { ...group, name: name.trim() } : group
    ),
  })

export const removeGroup =
  (groupId: string): NavigationChange =>
  (current) => ({
    ...rest(current),
    groups: current.groups.filter((group) => group.id !== groupId),
    spaceGroups: Object.fromEntries(
      Object.entries(current.spaceGroups).filter(([, id]) => id !== groupId)
    ),
  })

/** Puts back a group and its Spaces as they were before it was removed. */
export const restoreGroup =
  (
    group: { id: string; name: string },
    index: number,
    spaceIds: readonly string[]
  ): NavigationChange =>
  (current) => {
    if (current.groups.some((existing) => existing.id === group.id)) {
      return rest(current)
    }
    const groups = [...current.groups]
    groups.splice(Math.min(index, groups.length), 0, group)
    const spaceGroups = { ...current.spaceGroups }
    for (const spaceId of spaceIds) spaceGroups[spaceId] ??= group.id
    return { ...rest(current), groups, spaceGroups }
  }
