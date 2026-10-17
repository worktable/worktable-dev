// ============================================================
// What else points at a Doc: records and HTML Docs
// ============================================================
//
// Docs link to Docs through the link graph. Records point at Docs through
// document fields, and HTML Docs open them with
// worktable.navigation.openDocument("path"). This keeps, per Space, which
// records and HTML Docs point at each Doc path, built in the background and
// re-read only for the collections and HTML Docs that changed, so a Doc page
// answers without reading files.

import {
  normalizeRecordFieldType,
  parseDocumentReference,
  type DocumentReferrer,
  type RecordCollectionSchema,
  type RecordFile,
} from "@worktable/types"
import { logError } from "./debug-log.ts"
import { listRecordCollections, listRecords } from "./record-store.ts"
import { listWidgets, readWidgetHtml } from "./widget-store.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { workspaceCacheKey } from "./workspace.ts"

type RecordReferrer = Extract<DocumentReferrer, { kind: "record" }>

interface SpaceReferrers {
  /** Per collection id: the records pointing at each doc path. */
  collections: Map<string, Map<string, RecordReferrer[]>>
  /** Per HTML Doc path: the doc paths it opens. */
  html: Map<string, string[]>
  /** Whether a first read has landed. */
  ready: boolean
  /** Whether anything changed since the last read. */
  changed: boolean
  /** Collections and HTML Docs to read again; the rest are listed only. */
  stale: { collections: Set<string>; html: Set<string> }
  building: Promise<void> | null
}

const spaces = new Map<string, SpaceReferrers>()

function spaceKey(spaceId: string): string {
  return `${workspaceCacheKey()}\0${spaceId}`
}

function documentPaths(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value]
  return values.flatMap((item) => {
    const parsed = parseDocumentReference(item)
    return parsed.path ? [parsed.path] : []
  })
}

/** A record's name as its collection shows it: title or name, else the first required text field, else its id. */
function recordName(record: RecordFile, schema: RecordCollectionSchema | undefined): string {
  const data = record.data as Record<string, unknown>
  const keys = ["title", "name"]
  for (const [key, field] of Object.entries(schema?.fields ?? {})) {
    if (field.required && normalizeRecordFieldType(field.type) === "string") keys.push(key)
  }
  for (const key of keys) {
    const value = data[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return record.id
}

/** A field's label as the collection shows it: its name, else its key in words. */
function fieldLabel(key: string, name: string | undefined): string {
  if (name?.trim()) return name
  const words = key.replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2").replace(/[-_]+/g, " ").trim()
  return words.replace(/(^|\s)\p{L}/gu, (letter) => letter.toUpperCase())
}

async function readCollection(
  spaceId: string,
  collectionId: string,
  name: string,
  schema: RecordCollectionSchema | undefined,
  fields: Array<[string, string]>
): Promise<Map<string, RecordReferrer[]>> {
  const byDoc = new Map<string, RecordReferrer[]>()
  if (fields.length === 0) return byDoc
  const records: RecordFile[] = await listRecords(spaceId, collectionId, {
    includeArchived: false,
  })
  for (const record of records) {
    const data = record.data as Record<string, unknown>
    for (const [key, field] of fields) {
      for (const path of documentPaths(data[key])) {
        const list = byDoc.get(path) ?? []
        if (list.some((known) => known.recordId === record.id)) continue
        list.push({
          kind: "record",
          collectionId,
          recordId: record.id,
          title: recordName(record, schema),
          collection: name,
          field,
        })
        byDoc.set(path, list)
      }
    }
  }
  return byDoc
}

/** Literal paths an HTML Doc's script opens. Paths it builds at run time are not found. */
export function openedDocumentPaths(html: string): string[] {
  const paths = new Set<string>()
  const call = /openDocument\(\s*(["'`])([^"'`$\n]+)\1\s*\)/g
  let match: RegExpExecArray | null
  while ((match = call.exec(html)) !== null) {
    const parsed = parseDocumentReference(match[2]!.trim().replace(/^\/+/, ""))
    if (parsed.path) paths.add(parsed.path)
  }
  return [...paths]
}

async function build(spaceId: string, space: SpaceReferrers): Promise<void> {
  const stale = space.stale
  space.stale = { collections: new Set(), html: new Set() }
  space.changed = false

  const collections = await listRecordCollections(spaceId)
  const present = new Set(collections.map((collection) => collection.id))
  for (const id of space.collections.keys()) {
    if (!present.has(id)) space.collections.delete(id)
  }
  for (const collection of collections) {
    if (!stale.collections.has(collection.id) && space.collections.has(collection.id)) {
      continue
    }
    const fields = Object.entries(collection.schema?.fields ?? {}).flatMap(
      ([key, field]) =>
        normalizeRecordFieldType(field.type) === "document"
          ? [[key, fieldLabel(key, field.name)] as [string, string]]
          : []
    )
    space.collections.set(
      collection.id,
      await readCollection(spaceId, collection.id, collection.name, collection.schema, fields)
    )
  }

  const widgets = await listWidgets(spaceId)
  const htmlPaths = new Set(widgets.map((widget) => widget.id))
  for (const path of space.html.keys()) {
    if (!htmlPaths.has(path)) space.html.delete(path)
  }
  for (const widget of widgets) {
    if (!stale.html.has(widget.id) && space.html.has(widget.id)) continue
    const { data } = await readWidgetHtml(spaceId, widget.id)
    space.html.set(widget.id, data ? openedDocumentPaths(data) : [])
  }
}

function spaceFor(spaceId: string): SpaceReferrers {
  const key = spaceKey(spaceId)
  let space = spaces.get(key)
  if (!space) {
    space = {
      collections: new Map(),
      html: new Map(),
      ready: false,
      changed: true,
      stale: { collections: new Set(), html: new Set() },
      building: null,
    }
    spaces.set(key, space)
  }
  return space
}

function startBuild(spaceId: string, space: SpaceReferrers): void {
  if (space.building) return
  space.building = build(spaceId, space)
    .then(() => {
      space.ready = true
    })
    .catch((error) => {
      // Read everything again next time.
      space.collections.clear()
      space.html.clear()
      space.changed = true
      console.error("[referrers] could not read records and HTML Docs:", logError(error))
    })
    .finally(() => {
      space.building = null
    })
}

/**
 * The records and HTML Docs pointing at a Doc, without waiting. `current`
 * maps a recorded path to where that Doc is now. A Space not read yet answers
 * null and starts reading in the background; one with changes answers from
 * what it knew and catches up in the background.
 */
export function peekDocReferrers(
  spaceId: string,
  docPath: string,
  current: (path: string) => string = (path) => path
): DocumentReferrer[] | null {
  const space = spaceFor(spaceId)
  if (space.changed) startBuild(spaceId, space)
  if (!space.ready) return null
  const referrers: DocumentReferrer[] = []
  for (const byDoc of space.collections.values()) {
    for (const [path, records] of byDoc) {
      if (path === docPath || current(path) === docPath) referrers.push(...records)
    }
  }
  for (const [htmlPath, opened] of space.html) {
    if (opened.some((path) => path === docPath || current(path) === docPath)) {
      referrers.push({ kind: "html", path: htmlPath })
    }
  }
  return referrers
}

/** Wait for a read of the Space already started; tests use this. */
export async function settleDocReferrers(spaceId: string): Promise<void> {
  await spaces.get(spaceKey(spaceId))?.building
}

onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") {
    spaces.clear()
    return
  }
  if (!("spaceId" in event) || typeof event.spaceId !== "string") return
  const space = spaces.get(spaceKey(event.spaceId))
  if (!space) return
  switch (event.type) {
    case "record":
    case "recordCollection":
    case "recordCollectionReconcile":
      space.stale.collections.add(event.collectionId)
      space.changed = true
      break
    case "widget":
      space.stale.html.add(event.widgetId)
      space.changed = true
      break
    case "documentCorpus":
    case "space":
      // Documents came or went: list again, read what is new.
      space.changed = true
      break
  }
})
