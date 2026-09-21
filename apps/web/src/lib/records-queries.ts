import { useMutation, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query"
import { toast } from "@worktable/ui/components/sonner"
import type { RecordFile, RecordQueryResult } from "@worktable/types"
import { queryKeys } from "./queries"
import {
  archiveRecord,
  createRecord,
  deleteRecord,
  reconcileRecordCollection,
  restoreRecord,
  updateRecord,
} from "./records-api"
import { toastRecordError } from "./records"

/**
 * Record mutations for one collection, shaped like the annotations module:
 * every mutation invalidates the record prefix on settle (the WS echo does
 * too, so this is belt and braces). Field updates additionally patch the
 * cached grid pages optimistically — inline editing must not flicker through
 * a refetch round-trip.
 */
export function useRecordMutations(spaceId: string, collectionId: string) {
  const queryClient = useQueryClient()
  const recordsKey = queryKeys.records(spaceId, collectionId)
  // recordCollections(spaceId) is ["spaces", spaceId, "records"] — the PREFIX
  // of every record query key (summaries, grid pages, point reads, health).
  // React Query invalidation is prefix-matched, so this one call refetches
  // them all; the WS echo is belt and braces, not the only invalidator.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.recordCollections(spaceId) })
  }

  const updateField = useMutation({
    mutationFn: ({ recordId, data }: { recordId: string; data: Record<string, unknown> }) =>
      updateRecord(spaceId, collectionId, recordId, { data }),
    onMutate: async ({ recordId, data }) => {
      await queryClient.cancelQueries({ queryKey: recordsKey })
      const snapshots = snapshotPages(queryClient, spaceId, collectionId)
      patchRecordInPages(queryClient, spaceId, collectionId, recordId, (record) => ({
        ...record,
        data: { ...record.data, ...data },
      }))
      return { snapshots }
    },
    onError: (err, _vars, context) => {
      restorePages(queryClient, context?.snapshots)
      toastRecordError(err, "Failed to update record")
    },
    onSettled: invalidate,
  })

  const create = useMutation({
    mutationFn: (data: Record<string, unknown>) => createRecord(spaceId, collectionId, { data }),
    onSuccess: () => {
      invalidate()
      toast.success("Record created")
    },
    onError: (err) => toastRecordError(err, "Failed to create record"),
  })

  const duplicate = useMutation({
    mutationFn: (record: RecordFile) => createRecord(spaceId, collectionId, { data: record.data }),
    onSuccess: () => {
      invalidate()
      toast.success("Record duplicated")
    },
    onError: (err) => toastRecordError(err, "Failed to duplicate record"),
  })

  const archive = useMutation({
    mutationFn: (recordId: string) => archiveRecord(spaceId, collectionId, recordId),
    onSuccess: () => {
      invalidate()
      toast.success("Record archived")
    },
    onError: (err) => toastRecordError(err, "Failed to archive record"),
  })

  const restore = useMutation({
    mutationFn: (recordId: string) => restoreRecord(spaceId, collectionId, recordId),
    onSuccess: () => {
      invalidate()
      toast.success("Record restored")
    },
    onError: (err) => toastRecordError(err, "Failed to restore record"),
  })

  const remove = useMutation({
    mutationFn: (recordId: string) => deleteRecord(spaceId, collectionId, recordId),
    onSuccess: () => {
      invalidate()
      toast.success("Record deleted")
    },
    // The 409 message lists the restricting referrers — surface it verbatim.
    onError: (err) => toastRecordError(err, "Failed to delete record"),
  })

  const reconcile = useMutation({
    mutationFn: () => reconcileRecordCollection(spaceId, collectionId),
    onSuccess: (projection) => {
      invalidate()
      toast.success(
        projection.changedRecordCount > 0
          ? `Reconciled ${projection.changedRecordCount} ${projection.changedRecordCount === 1 ? "record" : "records"}`
          : "Projection already current"
      )
    },
    onError: (err) => toastRecordError(err, "Failed to reconcile collection"),
  })

  return { updateField, create, duplicate, archive, restore, remove, reconcile }
}

type PageSnapshot = Array<[readonly unknown[], unknown]>

function snapshotPages(queryClient: QueryClient, spaceId: string, collectionId: string): PageSnapshot {
  // Both caches an optimistic patch touches: the grid pages AND the peek's
  // single-record point reads — a failed edit must roll back everywhere.
  return [
    ...queryClient.getQueriesData({ queryKey: [...queryKeys.records(spaceId, collectionId), "pages"] }),
    ...queryClient.getQueriesData({ queryKey: [...queryKeys.records(spaceId, collectionId), "record"] }),
  ]
}

function restorePages(queryClient: QueryClient, snapshots: PageSnapshot | undefined) {
  for (const [key, data] of snapshots ?? []) {
    queryClient.setQueryData(key, data)
  }
}

/** Apply `patch` to the record wherever it appears in cached grid pages and
 *  the peek's single-record cache. */
function patchRecordInPages(
  queryClient: QueryClient,
  spaceId: string,
  collectionId: string,
  recordId: string,
  patch: (record: RecordFile) => RecordFile
) {
  queryClient.setQueriesData<InfiniteData<RecordQueryResult>>(
    { queryKey: [...queryKeys.records(spaceId, collectionId), "pages"] },
    (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              records: page.records.map((record) => (record.id === recordId ? patch(record) : record)),
            })),
          }
        : data
  )
  queryClient.setQueriesData<RecordFile>(
    { queryKey: [...queryKeys.records(spaceId, collectionId), "record", recordId] },
    (record) => (record ? patch(record) : record)
  )
}
