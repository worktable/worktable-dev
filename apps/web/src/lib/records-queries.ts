import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { toast } from "@worktable/ui/components/sonner"
import type { RecordFile } from "@worktable/types"
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
import {
  applyRecordChange,
  patchRecordInPages,
  recordPagesKey,
  relationGridsShowing,
} from "./record-cache"
import { isSpaceLive } from "./space-observation"

/**
 * Record mutations for one collection, shaped like the annotations module.
 * Each response is applied to the cached grids at once; what still needs the
 * server is refreshed by the Space's socket when it is live (its echo of this
 * change arrives there), or here when it is not. Field updates also patch the
 * cached grid pages optimistically — inline editing must not flicker through
 * a refetch round-trip.
 */
export function useRecordMutations(spaceId: string, collectionId: string) {
  const queryClient = useQueryClient()
  const recordsKey = queryKeys.records(spaceId, collectionId)
  const applyChange = (recordId: string, record: RecordFile | null) => {
    const refresh = applyRecordChange(queryClient, spaceId, collectionId, recordId, record)
    if (isSpaceLive(spaceId)) return
    for (const filters of refresh) void queryClient.invalidateQueries(filters)
  }
  // recordCollections(spaceId) is ["spaces", spaceId, "records"] — the PREFIX
  // of every record query key (summaries, grid pages, point reads, health).
  // After a failure the cache may hold an optimistic edit, so read it all.
  const resync = () => {
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
      resync()
    },
    onSuccess: (record, { recordId, data }) => {
      applyChange(recordId, record)
      // The optimistic patch already holds the new links, so neither this
      // response nor its echo looks like a change: read their titles now.
      for (const filters of relationGridsShowing(queryClient, spaceId, collectionId, Object.keys(data))) {
        void queryClient.invalidateQueries(filters)
      }
    },
  })

  const create = useMutation({
    mutationFn: (data: Record<string, unknown>) => createRecord(spaceId, collectionId, { data }),
    onSuccess: (result) => {
      applyChange(result.recordId, result.record)
      toast.success("Record created")
    },
    onError: (err) => toastRecordError(err, "Failed to create record"),
  })

  const duplicate = useMutation({
    mutationFn: (record: RecordFile) => createRecord(spaceId, collectionId, { data: record.data }),
    onSuccess: (result) => {
      applyChange(result.recordId, result.record)
      toast.success("Record duplicated")
    },
    onError: (err) => toastRecordError(err, "Failed to duplicate record"),
  })

  const archive = useMutation({
    mutationFn: (recordId: string) => archiveRecord(spaceId, collectionId, recordId),
    onSuccess: (record, recordId) => {
      applyChange(recordId, record)
      toast.success("Record archived")
    },
    onError: (err) => toastRecordError(err, "Failed to archive record"),
  })

  const restore = useMutation({
    mutationFn: (recordId: string) => restoreRecord(spaceId, collectionId, recordId),
    onSuccess: (record, recordId) => {
      applyChange(recordId, record)
      toast.success("Record restored")
    },
    onError: (err) => toastRecordError(err, "Failed to restore record"),
  })

  const remove = useMutation({
    mutationFn: (recordId: string) => deleteRecord(spaceId, collectionId, recordId),
    onSuccess: (_result, recordId) => {
      applyChange(recordId, null)
      toast.success("Record deleted")
    },
    // The 409 message lists the restricting referrers — surface it verbatim.
    onError: (err) => toastRecordError(err, "Failed to delete record"),
  })

  const reconcile = useMutation({
    mutationFn: () => reconcileRecordCollection(spaceId, collectionId),
    onSuccess: (projection) => {
      resync()
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
    ...queryClient.getQueriesData({ queryKey: recordPagesKey(spaceId, collectionId) }),
    ...queryClient.getQueriesData({ queryKey: [...queryKeys.records(spaceId, collectionId), "record"] }),
  ]
}

function restorePages(queryClient: QueryClient, snapshots: PageSnapshot | undefined) {
  for (const [key, data] of snapshots ?? []) {
    queryClient.setQueryData(key, data)
  }
}
