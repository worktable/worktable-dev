import { useEffect, useMemo, useState } from "react"
import type { RecordCollectionSchema, RecordFile } from "@worktable/types"
import { recordFieldColumns, type RecordFieldColumn } from "@/lib/records"

/** Keep discovered fields stable for this collection visit, even when a view
 * contains no values for them. Schema fields always use the current schema. */
export function useRecordFieldColumns(collectionKey: string, schema: RecordCollectionSchema | undefined, records: RecordFile[]) {
  const [known, setKnown] = useState<{ collectionKey: string; keys: string[] }>({ collectionKey, keys: [] })
  const columns = useMemo(() => {
    const current = recordFieldColumns(schema, records)
    const modeled = current.filter((column) => column.field)
    const inferred = new Map<string, RecordFieldColumn>(
      (known.collectionKey === collectionKey ? known.keys : []).map((key) => [key, { key, field: null, type: "unknown" }])
    )
    for (const column of current) {
      if (!column.field) inferred.set(column.key, column)
    }
    for (const column of modeled) inferred.delete(column.key)
    return [...modeled, ...inferred.values()]
  }, [collectionKey, schema, records, known])

  useEffect(() => {
    const keys = columns.filter((column) => !column.field).map((column) => column.key)
    setKnown((previous) => previous.collectionKey === collectionKey &&
      previous.keys.length === keys.length && previous.keys.every((key, index) => key === keys[index])
      ? previous
      : { collectionKey, keys })
  }, [collectionKey, columns])

  return columns
}
