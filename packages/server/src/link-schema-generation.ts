import { onRecordChanged } from "./record-events.ts"
import { onWorkspaceChange } from "./workspace-events.ts"

// A record-schema edit must invalidate visitor validation without rebuilding
// the member document catalog or reloading schemas on every visitor query.
let clock = 0
let resetAt = 0
const spaces = new Map<string, number>()
const records = new Map<string, number>()
export function linkSchemaGeneration(spaceId: string): number {
  return Math.max(resetAt, spaces.get(spaceId) ?? 0)
}
export function linkRecordGeneration(
  spaceId: string,
  collections: readonly string[]
): number {
  let generation = resetAt
  for (const collection of collections)
    generation = Math.max(
      generation,
      records.get(`${spaceId}\0${collection}`) ?? 0
    )
  return generation
}
onRecordChanged((event) => {
  const collection =
    event.kind === "write" ? event.record.collectionId : event.collectionId
  records.set(`${event.spaceId}\0${collection}`, ++clock)
  if (event.kind === "collection") spaces.set(event.spaceId, ++clock)
})
onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") {
    resetAt = ++clock
    spaces.clear()
    records.clear()
  } else if (
    event.type === "recordCollection" ||
    event.type === "recordCollectionReconcile"
  ) {
    spaces.set(event.spaceId, ++clock)
  }
  if (
    event.type === "record" ||
    event.type === "recordCollection" ||
    event.type === "recordCollectionReconcile"
  )
    records.set(`${event.spaceId}\0${event.collectionId}`, ++clock)
})
