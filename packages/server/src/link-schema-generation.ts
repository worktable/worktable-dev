import { onRecordChanged } from "./record-events.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { onDocContentChanged, onHtmlContentChanged } from "./content-events.ts"

// A record-schema edit must invalidate visitor validation without rebuilding
// the member document catalog or reloading schemas on every visitor query.
let clock = 0
let resetAt = 0
const spaces = new Map<string, number>()
const documents = new Map<string, number>()
const schemas = new Map<string, number>()
const schemaSpaces = new Map<string, number>()
const records = new Map<string, number>()
export function linkDocumentGeneration(spaceId: string, path: string): number {
  return Math.max(
    resetAt,
    spaces.get(spaceId) ?? 0,
    documents.get(`${spaceId}\0${path}`) ?? 0
  )
}
export function linkSchemaGeneration(
  spaceId: string,
  collections: readonly string[]
): number {
  let generation = resetAt
  for (const collection of collections)
    generation = Math.max(
      generation,
      schemas.get(`${spaceId}\0${collection}`) ?? 0
    )
  return generation
}
// Explicit access checks discover collections while running, so fence every
// schema change in their Space. Visitor reads keep their collection scope.
export function linkSpaceSchemaGeneration(spaceId: string): number {
  return Math.max(resetAt, schemaSpaces.get(spaceId) ?? 0)
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
  const key = `${event.spaceId}\0${collection}`
  records.set(key, ++clock)
  if (event.kind === "collection") {
    schemas.set(key, clock)
    schemaSpaces.set(event.spaceId, clock)
  }
})
const documentChanged = (spaceId: string, path: string) => {
  documents.set(`${spaceId}\0${path}`, ++clock)
}
onDocContentChanged(documentChanged)
onHtmlContentChanged(documentChanged)
onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") {
    resetAt = ++clock
    spaces.clear()
    documents.clear()
    schemas.clear()
    schemaSpaces.clear()
    records.clear()
  } else if (event.type === "doc" || event.type === "widget") {
    documentChanged(
      event.spaceId,
      event.type === "doc" ? event.docPath : event.widgetId
    )
  } else if (
    event.type === "space" ||
    event.type === "docAliases" ||
    event.type === "documentCorpus"
  ) {
    // These events do not identify a document, so remain conservative.
    spaces.set(event.spaceId, ++clock)
  } else if (
    event.type === "recordCollection" ||
    event.type === "recordCollectionReconcile"
  ) {
    schemas.set(`${event.spaceId}\0${event.collectionId}`, ++clock)
    schemaSpaces.set(event.spaceId, clock)
  }
  if (
    event.type === "record" ||
    event.type === "recordCollection" ||
    event.type === "recordCollectionReconcile"
  )
    records.set(`${event.spaceId}\0${event.collectionId}`, ++clock)
})
