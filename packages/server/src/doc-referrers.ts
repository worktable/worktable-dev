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
import { onHtmlContentChanged } from "./content-events.ts"
import { logError } from "./debug-log.ts"
import { createDocAliasResolver, readDocAliases } from "./doc-aliases.ts"
import { readDocumentCatalogSnapshot } from "./document-query.ts"
import { wsManager } from "./ws.ts"
import { listRecordCollections, listRecords } from "./record-store.ts"
import { listWidgets, readWidgetHtml } from "./widget-store.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { workspaceCacheKey } from "./workspace.ts"

type RecordReferrer = Extract<DocumentReferrer, { kind: "record" }>

interface SpaceReferrers {
  /** Per collection id: the records pointing at each doc path. */
  collections: Map<string, Map<string, RecordReferrer[]>>
  /** Per HTML Doc path: the docs it opens, with the label of what opens each. */
  html: Map<string, OpenedDocument[]>
  /** Whether a first read has landed. */
  ready: boolean
  /** Whether anything changed since the last read. */
  changed: boolean
  /** Collections and HTML Docs to read again; the rest are listed only. */
  stale: { collections: Set<string>; html: Set<string> }
  building: Promise<void> | null
  /** After a failed read, when the next may start. */
  retryAt: number
}

/** How long a Space waits to read again after a read failed. */
const RETRY_MS = 30_000

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

/** A doc an HTML Doc opens, and the words on the button or link that opens it. */
export interface OpenedDocument {
  path: string
  label?: string
}

/** A call on some receiver, such as worktable.navigation.openDocument("plans/brief"). */
const OPEN_CALL = /[\w$)\]]\s*\.\s*openDocument\(\s*(["'`])([^"'`$\n]+)\1\s*\)/

/** Script without its comments, so a commented-out call does not count. */
function withoutComments(script: string): string {
  return script
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
}

function openedPath(raw: string): string | undefined {
  return parseDocumentReference(raw.trim().replace(/^\/+/, "")).path
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

/**
 * The docs an HTML Doc opens with worktable.navigation.openDocument and a
 * literal path, read from its scripts and event handlers only: a call shown
 * as text or in a comment does not count. When the call sits on the
 * element people click (an onclick or a javascript: href), its visible words
 * are the label; an element without words uses its aria-label, title or
 * value. Calls made from the script alone have no label. Paths built at run
 * time are not found.
 */
export async function openedDocuments(html: string): Promise<OpenedDocument[]> {
  const labels = new Map<string, string>()
  const open: Array<{ path: string; text: string; name?: string }> = []
  const code: string[] = []
  let script = ""
  await new HTMLRewriter()
    .on("script", {
      element(element) {
        const type = element.getAttribute("type")?.trim().toLowerCase()
        const runs =
          !type || type === "module" || /javascript|ecmascript/.test(type)
        if (!runs || element.getAttribute("src")) return
        script = ""
        element.onEndTag(() => {
          code.push(withoutComments(script))
          script = ""
        })
      },
      text(chunk) {
        script += chunk.text
      },
    })
    .on("*", {
      element(element) {
        for (const [attribute, value] of element.attributes) {
          if (!/^on|^href$/i.test(attribute)) continue
          const handler = decodeEntities(value)
          code.push(withoutComments(handler))
          const path = openedPath(OPEN_CALL.exec(handler)?.[2] ?? "")
          if (!path) continue
          const entry = {
            path,
            text: "",
            name:
              element.getAttribute("aria-label") ??
              element.getAttribute("title") ??
              element.getAttribute("value") ??
              undefined,
          }
          open.push(entry)
          const close = () => {
            open.splice(open.indexOf(entry), 1)
            const text = entry.text.replace(/\s+/g, " ").trim()
            const label = /[\p{L}\p{N}]/u.test(text) ? text : entry.name?.trim()
            if (label && !labels.has(path)) labels.set(path, label.slice(0, 120))
          }
          if (element.canHaveContent) element.onEndTag(close)
          else close()
          break
        }
      },
    })
    .onDocument({
      text(chunk) {
        for (const entry of open) entry.text += chunk.text
      },
    })
    .transform(new Response(html))
    .text()

  const opened = new Map<string, OpenedDocument>()
  const call = new RegExp(OPEN_CALL.source, "g")
  for (const match of code.join("\n").matchAll(call)) {
    const path = openedPath(match[2]!)
    if (!path || opened.has(path)) continue
    const label = labels.get(path)
    opened.set(path, { path, ...(label ? { label } : {}) })
  }
  return [...opened.values()]
}

/** Per doc path: what points at it, as text that changes when it does. */
function signatures(space: SpaceReferrers): Map<string, string> {
  const lines = new Map<string, string[]>()
  const add = (path: string, line: string) =>
    lines.set(path, [...(lines.get(path) ?? []), line])
  for (const byDoc of space.collections.values()) {
    for (const [path, records] of byDoc) {
      for (const record of records) {
        add(path, `record ${record.collectionId}/${record.recordId} ${record.title} ${record.field}`)
      }
    }
  }
  for (const [htmlPath, opened] of space.html) {
    for (const link of opened) add(link.path, `html ${htmlPath} ${link.label ?? ""}`)
  }
  return new Map([...lines].map(([path, list]) => [path, list.sort().join("\n")]))
}

/**
 * Tell open pages of the docs whose referrers changed to read again: a
 * page asked before this read landed, or before a record or HTML Doc changed.
 */
async function announceChanges(
  spaceId: string,
  before: Map<string, string>,
  after: Map<string, string>
): Promise<void> {
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) => before.get(path) !== after.get(path)
  )
  if (changed.length === 0) return
  const { aliases } = await readDocAliases(spaceId)
  const resolve = aliases ? createDocAliasResolver(aliases) : () => null
  const docPaths = [...new Set(changed.map((path) => resolve(path) ?? path))]
  for (let offset = 0; offset < docPaths.length; offset += 500) {
    wsManager.broadcast(spaceId, {
      type: "doc_links_update",
      spaceId,
      data: { docPaths: docPaths.slice(offset, offset + 500) },
    })
  }
}

async function build(
  spaceId: string,
  space: SpaceReferrers,
  stale: SpaceReferrers["stale"]
): Promise<void> {
  const before = signatures(space)

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

  // One catalog for the whole pass: each HTML Doc read would build it again.
  const catalog = await readDocumentCatalogSnapshot(spaceId)
  const widgets = await listWidgets(spaceId, { catalog: async () => catalog })
  const htmlPaths = new Set(widgets.map((widget) => widget.id))
  for (const path of space.html.keys()) {
    if (!htmlPaths.has(path)) space.html.delete(path)
  }
  for (const widget of widgets) {
    if (!stale.html.has(widget.id) && space.html.has(widget.id)) continue
    const { data } = await readWidgetHtml(spaceId, widget.id, { catalog })
    space.html.set(widget.id, data ? await openedDocuments(data) : [])
  }
  await announceChanges(spaceId, before, signatures(space))
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
      retryAt: 0,
    }
    spaces.set(key, space)
  }
  return space
}

function startBuild(spaceId: string, space: SpaceReferrers): void {
  if (space.building || Date.now() < space.retryAt) return
  const stale = space.stale
  space.stale = { collections: new Set(), html: new Set() }
  space.changed = false
  space.building = build(spaceId, space, stale)
    .then(() => {
      space.ready = true
    })
    .catch((error) => {
      // Keep answering from what was read, and read what was pending again
      // after a pause rather than on every page.
      for (const id of stale.collections) space.stale.collections.add(id)
      for (const path of stale.html) space.stale.html.add(path)
      space.changed = true
      space.retryAt = Date.now() + RETRY_MS
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
    const link = opened.find(
      ({ path }) => path === docPath || current(path) === docPath
    )
    if (link) {
      referrers.push({
        kind: "html",
        path: htmlPath,
        ...(link.label ? { label: link.label } : {}),
      })
    }
  }
  return referrers
}

/** Wait for a read of the Space already started; tests use this. */
export async function settleDocReferrers(spaceId: string): Promise<void> {
  await spaces.get(spaceKey(spaceId))?.building
}

// Writes from this process do not reach the watcher, so they say so here.
onHtmlContentChanged((spaceId, path) => {
  const space = spaces.get(spaceKey(spaceId))
  if (!space) return
  space.stale.html.add(path)
  space.changed = true
})

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
