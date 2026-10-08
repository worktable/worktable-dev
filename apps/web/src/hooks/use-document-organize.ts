import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { Clock3, Pin, PinOff, Infinity as InfinityIcon } from "lucide-react"
import { START_HERE_LIMIT } from "@worktable/types"
import { toast } from "@worktable/ui/components/sonner"
import type { PageOverflowAction } from "@/hooks/use-page-meta"
import { activityQueryKeys } from "@/lib/activity"
import { mutateDocument } from "@/lib/documents-api"
import {
  formatArchiveDate,
  setDocumentLifetime,
  setStartHere,
  useDocumentSummary,
  useRefreshDocumentLists,
} from "@/lib/lifetime"
import { spaceQueryOptions, useSpace } from "@/lib/queries"

export function useLifetimeActions(spaceId: string, path: string) {
  const refresh = useRefreshDocumentLists(spaceId)
  const navigate = useNavigate()
  const run = async (action: () => Promise<unknown>, failure: string) => {
    try {
      await action()
      await refresh()
      return true
    } catch (error) {
      console.error(failure, error)
      toast.error(failure)
      return false
    }
  }
  return {
    keep: () =>
      run(
        () => setDocumentLifetime(spaceId, path, "durable"),
        "Couldn’t keep this document."
      ),
    makeTemporary: (archiveOn?: string) =>
      run(
        () => setDocumentLifetime(spaceId, path, "temporary", archiveOn),
        "Couldn’t change when this document archives."
      ),
    archiveNow: () =>
      run(async () => {
        await mutateDocument(spaceId, "archive", path)
        toast.success("Archived")
        await navigate({ to: "/spaces/$spaceId", params: { spaceId } })
      }, "Couldn’t archive this document."),
  }
}

/** When a temporary document archives; durable documents have no label. */
export function useTemporaryArchiveLabel(
  spaceId: string,
  path: string
): string | null {
  const summary = useDocumentSummary(spaceId, path)
  if (summary?.lifetime !== "temporary" || !summary.archiveOn) return null
  return `Archives ${formatArchiveDate(summary.archiveOn)}`
}

/** Lifetime and pin actions for a document's More menu. */
export function useDocumentOrganizeActions(
  spaceId: string,
  path: string
): PageOverflowAction[] {
  const summary = useDocumentSummary(spaceId, path)
  const actions = useLifetimeActions(spaceId, path)
  const { data: space } = useSpace(spaceId)
  const queryClient = useQueryClient()
  const pins = space?.startHere ?? []
  const pinned = pins.some((pin) => pin.path === path)
  if (!summary || summary.archived || !summary.lifetime) return []

  const updatePins = async (next: Array<{ path: string; note?: string }>) => {
    try {
      await setStartHere(spaceId, next)
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: spaceQueryOptions(spaceId).queryKey,
        }),
        queryClient.invalidateQueries({ queryKey: activityQueryKeys.all }),
      ])
      toast.success(pinned ? "Unpinned" : "Pinned")
    } catch (error) {
      console.error("Failed to update pins:", error)
      toast.error(pinned ? "Couldn’t unpin." : "Couldn’t pin.")
    }
  }
  const currentPins = pins.map((pin) => ({
    path: pin.path,
    ...(pin.note ? { note: pin.note } : {}),
  }))

  return [
    summary.lifetime === "temporary"
      ? {
          id: "keep",
          label: "Keep",
          icon: InfinityIcon,
          onSelect: () => void actions.keep(),
        }
      : {
          id: "make-temporary",
          label: "Make temporary",
          icon: Clock3,
          onSelect: () => void actions.makeTemporary(),
        },
    pinned
      ? {
          id: "unpin",
          label: "Unpin",
          icon: PinOff,
          onSelect: () =>
            void updatePins(currentPins.filter((pin) => pin.path !== path)),
        }
      : {
          id: "pin",
          label: "Pin",
          icon: Pin,
          disabled: pins.length >= START_HERE_LIMIT,
          onSelect: () => void updatePins([...currentPins, { path }]),
        },
  ]
}
