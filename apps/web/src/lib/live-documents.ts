import type * as Y from "yjs"

// Rich documents open for editing in this tab. While a document's Yjs
// provider is synced, the tab already has every saved change, so the server's
// echo of a collaborative save carries nothing new for it except metadata.

interface LiveDocument {
  synced: () => boolean
  /** The document's first heading, which names it in lists. */
  label: () => string | undefined
  /** The label lists last read, once a save has been checked against them. */
  announced: { label: string | undefined } | null
}

interface LiveDocumentGlobal {
  __worktableLiveDocuments?: Map<string, LiveDocument>
}

const browserGlobal = globalThis as typeof globalThis & LiveDocumentGlobal
const liveDocuments =
  browserGlobal.__worktableLiveDocuments ??
  (browserGlobal.__worktableLiveDocuments = new Map())

const key = (spaceId: string, path: string) => `${spaceId}\0${path}`

export function registerLiveDocument(
  spaceId: string,
  path: string,
  document: Pick<LiveDocument, "synced" | "label">
): () => void {
  const entry: LiveDocument = { ...document, announced: null }
  liveDocuments.set(key(spaceId, path), entry)
  return () => {
    if (liveDocuments.get(key(spaceId, path)) === entry) {
      liveDocuments.delete(key(spaceId, path))
    }
  }
}

/** Whether this tab holds the document's current collaborative state. */
export function isLiveDocumentSynced(spaceId: string, path: string): boolean {
  return liveDocuments.get(key(spaceId, path))?.synced() === true
}

/**
 * Whether the document's label changed since lists last read it: against the
 * label the list shows for the first save, then against the label at the
 * previous save. The local reading only detects a change; lists still take
 * the label the server computes, so a reading that differs from the server's
 * costs one list read, not one per save.
 */
export function takeLiveDocumentLabelChange(
  spaceId: string,
  path: string,
  listedLabel: string | undefined
): boolean {
  const entry = liveDocuments.get(key(spaceId, path))
  if (!entry) return true
  const label = entry.label()?.trim() || undefined
  const previous = entry.announced
    ? entry.announced.label
    : listedLabel?.trim() || undefined
  entry.announced = { label }
  return label !== previous
}

const COLLABORATIVE_SOURCES = new Set(["browser-yjs", "browser-yjs-sync"])

export interface DocEventLike {
  type: string
  spaceId?: string
  docPath?: string
  origin?: string
  data?: unknown
}

/**
 * A save of a collaborative editing session: marked by its origin, or, from
 * servers that do not mark it, by a browser Yjs provenance with no content,
 * format, or archive change attached.
 */
export function isCollaborativeSave(message: DocEventLike): boolean {
  if (message.type !== "doc_update" || !message.docPath) return false
  const data = (message.data ?? {}) as Record<string, unknown>
  if (message.origin === "yjs" || data["origin"] === "yjs") return true
  if ("content" in data || "format" in data || "archived" in data) return false
  const provenance = data["provenance"] as { source?: unknown } | undefined
  return (
    typeof provenance?.source === "string" &&
    COLLABORATIVE_SOURCES.has(provenance.source)
  )
}

/** A collaborative save of a document this tab has open and synced. */
export function isOwnCollaborativeSave(message: DocEventLike): boolean {
  return (
    isCollaborativeSave(message) &&
    !!message.spaceId &&
    isLiveDocumentSynced(message.spaceId, message.docPath!)
  )
}

type YNode = Y.XmlElement | Y.XmlText | Y.XmlHook

function isElement(node: YNode | undefined): node is Y.XmlElement {
  return !!node && "nodeName" in node && typeof node.toArray === "function"
}

function headingText(heading: Y.XmlElement): string {
  let text = ""
  for (const child of heading.toArray()) {
    if (isElement(child) || !("toDelta" in child)) continue
    for (const part of child.toDelta() as Array<{
      insert?: unknown
      attributes?: Record<string, unknown>
    }>) {
      // Lists name documents from plain heading text; link text is left out.
      // Overlapping marks are stored under suffixed names such as link--abc.
      const linked = Object.keys(part.attributes ?? {}).some(
        (name) => name === "link" || name.startsWith("link--")
      )
      if (typeof part.insert === "string" && !linked) text += part.insert
    }
  }
  return text
}

/**
 * The first non-empty heading in a BlockNote document, depth first, read
 * directly from its Yjs fragment.
 */
export function firstHeadingText(fragment: Y.XmlFragment): string | undefined {
  const visitGroup = (group: Y.XmlElement): string | undefined => {
    for (const container of group.toArray()) {
      if (!isElement(container)) continue
      for (const child of container.toArray()) {
        if (!isElement(child)) continue
        if (child.nodeName === "heading") {
          const text = headingText(child)
          if (text) return text
        } else if (child.nodeName === "blockGroup") {
          const nested = visitGroup(child)
          if (nested) return nested
        }
      }
    }
    return undefined
  }
  for (const node of fragment.toArray()) {
    if (isElement(node) && node.nodeName === "blockGroup") {
      const text = visitGroup(node)
      if (text) return text
    }
  }
  return undefined
}
