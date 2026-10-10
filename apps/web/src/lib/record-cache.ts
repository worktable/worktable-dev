import type {
  InfiniteData,
  InvalidateQueryFilters,
  QueryClient,
} from "@tanstack/react-query"
import type {
  RecordCollectionSchema,
  RecordFile,
  RecordQueryResult,
} from "@worktable/types"
import { queryKeys, type RecordPageParams } from "./queries"

export const recordPagesKey = (spaceId: string, collectionId: string) =>
  [...queryKeys.records(spaceId, collectionId), "pages"] as const

export const recordPointKey = (
  spaceId: string,
  collectionId: string,
  recordId: string
) => [...queryKeys.records(spaceId, collectionId), "record", recordId] as const

/** Apply `patch` to the record wherever it appears in cached grid pages and
 *  the peek's single-record cache. */
export function patchRecordInPages(
  queryClient: QueryClient,
  spaceId: string,
  collectionId: string,
  recordId: string,
  patch: (record: RecordFile) => RecordFile
): void {
  queryClient.setQueriesData<InfiniteData<RecordQueryResult>>(
    { queryKey: recordPagesKey(spaceId, collectionId) },
    (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              records: page.records.map((record) =>
                record.id === recordId ? patch(record) : record
              ),
            })),
          }
        : data
  )
  queryClient.setQueriesData<RecordFile>(
    { queryKey: recordPointKey(spaceId, collectionId, recordId) },
    (record) => (record ? patch(record) : record)
  )
}

/** Which of these fields link to records, by the collection's cached schema. */
export function relationFieldsAmong(
  queryClient: QueryClient,
  spaceId: string,
  collectionId: string,
  fields: string[]
): string[] {
  const schema =
    queryClient.getQueryData<{ schema?: RecordCollectionSchema | null }>([
      ...queryKeys.records(spaceId, collectionId),
      "health",
    ])?.schema ??
    queryClient
      .getQueryData<
        Array<{ id: string; schema?: RecordCollectionSchema | null }>
      >(queryKeys.recordCollections(spaceId))
      ?.find((collection) => collection.id === collectionId)?.schema
  return fields.filter((field) => {
    const type = schema?.fields?.[field]?.type
    return type === "relation" || type === "reference"
  })
}

/** Grids that expand any of these relation fields into linked titles. */
export function relationGridsShowing(
  queryClient: QueryClient,
  spaceId: string,
  collectionId: string,
  fields: string[]
): InvalidateQueryFilters[] {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: recordPagesKey(spaceId, collectionId) })
    .filter((query) => {
      const params = (query.queryKey[5] ?? {}) as RecordPageParams
      return fields.some((field) => params.expand?.[field])
    })
    .map((query) => ({ queryKey: query.queryKey, exact: true }))
}

const sameValue = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right)

/**
 * Apply a record's new state (null once deleted) to every cached grid of its
 * collection and to the peek. Returns what still needs the server: grids whose
 * filter, search, sort or expanded relations may now place or show the record
 * differently, grids that should hold it but do not, the collection's group
 * totals, and its counts and health when the set of active records changed.
 */
export function applyRecordChange(
  queryClient: QueryClient,
  spaceId: string,
  collectionId: string,
  recordId: string,
  record: RecordFile | null
): InvalidateQueryFilters[] {
  const refresh: InvalidateQueryFilters[] = [
    { queryKey: [...queryKeys.records(spaceId, collectionId), "groups"] },
    // The legacy full listing, if anything still reads it.
    { queryKey: queryKeys.records(spaceId, collectionId), exact: true },
  ]
  let previous: RecordFile | undefined
  let relationsChanged = false
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: recordPagesKey(spaceId, collectionId) })) {
    const data = query.state.data as InfiniteData<RecordQueryResult> | undefined
    const params = (query.queryKey[5] ?? {}) as RecordPageParams
    const held = data?.pages
      .flatMap((page) => page.records)
      .find((candidate) => candidate.id === recordId)
    previous ??= held
    const visible =
      record !== null && (params.includeArchived === true || !record.archive)
    if (data && held) {
      queryClient.setQueryData<InfiniteData<RecordQueryResult>>(
        query.queryKey,
        {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            records: visible
              ? page.records.map((candidate) =>
                  candidate.id === recordId ? record : candidate
                )
              : page.records.filter((candidate) => candidate.id !== recordId),
          })),
        }
      )
    }
    const relationChanged = Boolean(
      record &&
      held &&
      params.expand &&
      Object.keys(params.expand).some(
        (field) => !sameValue(held.data[field], record.data[field])
      )
    )
    relationsChanged ||= relationChanged
    const scoped = Boolean(
      params.search?.trim() || params.where || params.orderBy?.length
    )
    // Default order is newest first: a record older than the last loaded row
    // belongs to a page this grid has not loaded yet.
    const lastPage = data?.pages.at(-1)
    const oldestLoaded = lastPage?.records.at(-1)?.createdAt
    const beyondLoaded = Boolean(
      record &&
      lastPage?.nextCursor &&
      oldestLoaded &&
      Date.parse(record.createdAt) < Date.parse(oldestLoaded)
    )
    if (scoped || relationChanged || (!held && visible && !beyondLoaded)) {
      refresh.push({ queryKey: query.queryKey, exact: true })
    }
  }
  // Other collections' grids embed this record as a related title, or may
  // filter and sort through relation fields: read those again too.
  for (const query of queryClient.getQueryCache().findAll({
    predicate: (candidate) =>
      candidate.queryKey[0] === "spaces" &&
      candidate.queryKey[1] === spaceId &&
      candidate.queryKey[2] === "records" &&
      candidate.queryKey[3] !== collectionId &&
      candidate.queryKey[4] === "pages",
  })) {
    const data = query.state.data as InfiniteData<RecordQueryResult> | undefined
    const params = (query.queryKey[5] ?? {}) as RecordPageParams
    const shows = data?.pages.some(
      (page) => page.expanded?.[collectionId]?.[recordId] !== undefined
    )
    const throughRelations = Boolean(
      params.expand &&
      (params.search?.trim() || params.where || params.orderBy?.length)
    )
    if (shows || throughRelations) {
      refresh.push({ queryKey: query.queryKey, exact: true })
    }
  }
  const pointKey = recordPointKey(spaceId, collectionId, recordId)
  if (record) {
    queryClient.setQueryData<RecordFile>(pointKey, (current) =>
      current ? record : current
    )
  } else {
    refresh.push({ queryKey: pointKey, exact: true })
  }
  // Counts and integrity change only when the active set or links change.
  const activeSetChanged =
    !previous || !record || !!previous.archive !== !!record.archive
  if (activeSetChanged) {
    refresh.push({
      queryKey: queryKeys.recordCollections(spaceId),
      exact: true,
    })
  }
  if (activeSetChanged || relationsChanged) {
    refresh.push({
      queryKey: [...queryKeys.records(spaceId, collectionId), "health"],
      exact: true,
    })
  }
  return refresh
}
