import {
  linkDocumentGeneration,
  linkSchemaGeneration,
} from "./link-schema-generation.ts"
import { createHash } from "node:crypto"
import { createLinkKey, type LinkKey } from "./link-grant-view.ts"
import { htmlIconsRevision } from "./html-icons.ts"
import { injectWidgetRuntime } from "./widget-authoring.ts"
import {
  htmlImagesStamp,
  htmlSpaceImagesEnabled,
  inlineHtmlSpaceImages,
} from "./html-space-images.ts"
import type { WidgetFile, RecordCollectionSchema } from "@worktable/types"
import { readWidgetDocument } from "./widget-store.ts"
import { readLinkGrantSchemas } from "./link-grant.ts"
import { useResolvedDocumentHandle } from "./document-query.ts"
import { publicShareKind } from "./document-page-service.ts"
import { workspaceCacheKey } from "./workspace.ts"
import { runAsLinkVisitor, withLinkGrantRead } from "./team-policy.ts"
import type { ShareLinkView } from "./share-link-views.ts"

export class LinkToolChanged extends Error {
  override name = "LinkToolChanged"
}

export interface LinkTool {
  html: string
  revision: string
  key: LinkKey
  permissions: WidgetFile["permissions"]
  generation: number
  schemaGeneration: number
  schemas: ReadonlyMap<string, RecordCollectionSchema>
}

// Source and permissions share one snapshot. A metadata edit invalidates it
// even when the HTML's content digest did not change. Warm reads do no file
// I/O; a page that shows Space images checks their stamps in the Space's
// catalog snapshot, so a replaced or archived image builds it again.
interface ToolEntry {
  value: Promise<LinkTool | null>
  bytes: number
  /** What the page showed of its Space images, once it was built. */
  images?: { sourceSha256: string; stamp: string | undefined }
}
const tools = new Map<string, ToolEntry>()
let bytes = 0
const MAX_BYTES = 16 * 1024 * 1024

function trimTools(): void {
  for (const [oldKey, old] of tools) {
    if (tools.size <= 32 && bytes <= MAX_BYTES) break
    tools.delete(oldKey)
    bytes -= old.bytes
  }
}

/** Whether the Space images a built page showed are as they were. */
async function imagesUnchanged(
  view: ShareLinkView,
  entry: ToolEntry
): Promise<boolean> {
  if (!entry.images) return true
  const stamp = await htmlImagesStamp({
    spaceId: view.link.spaceId,
    path: view.path,
    sourceSha256: entry.images.sourceSha256,
    html: async () => null,
  })
  return stamp === entry.images.stamp
}

export async function readLinkTool(
  view: ShareLinkView
): Promise<LinkTool | null> {
  const collections = Object.keys(view.link.grant?.collections ?? {})
  const generation = linkDocumentGeneration(view.link.spaceId, view.path)
  const schemaGeneration = linkSchemaGeneration(view.link.spaceId, collections)
  // Whether pages show Space images is part of what one is built as.
  const imageMode = htmlSpaceImagesEnabled() ? "images" : "plain"
  // So is whether they draw the icons they name.
  const iconMode = htmlIconsRevision() ?? "plain"
  const key = `${workspaceCacheKey()}\0${view.link.id}\0${view.link.spaceId}\0${view.link.documentId}\0${view.path}\0${view.link.grantRevision}\0${generation}\0${schemaGeneration}\0${imageMode}\0${iconMode}`
  const cached = tools.get(key)
  if (cached && (await imagesUnchanged(view, cached))) return cached.value
  // Another request may have replaced the stale entry while this one checked.
  const current = tools.get(key)
  if (current && current !== cached) return current.value
  if (cached && current === cached) {
    tools.delete(key)
    bytes -= cached.bytes
  }
  const entry: ToolEntry = {
    value: Promise.resolve(null) as Promise<LinkTool | null>,
    bytes: 0,
  }
  entry.value = runAsLinkVisitor(() =>
    withLinkGrantRead(view.link.spaceId, async () => {
      const grant = view.link.grant
      if (!grant) return null
      const resolved = await useResolvedDocumentHandle(
        { spaceId: view.link.spaceId, path: view.path, snapshot: true },
        async (handle) => {
          if (
            handle.documentId !== view.link.documentId ||
            handle.document.health !== "supported" ||
            (await publicShareKind(handle)) !== "html"
          )
            return { read: null }
          const [{ data }, schemas] = await Promise.all([
            readWidgetDocument(view.link.spaceId, view.path),
            readLinkGrantSchemas(view.link.spaceId, grant),
          ])
          if (
            linkDocumentGeneration(view.link.spaceId, view.path) !==
              generation ||
            linkSchemaGeneration(view.link.spaceId, collections) !==
              schemaGeneration
          )
            throw new LinkToolChanged()
          if (!data || data.widget.archive) return { read: null }
          return { read: { data, schemas } }
        }
      )
      if (!("read" in resolved) || !resolved.read) return null
      const { data, schemas } = resolved.read
      // Outside the Space's lock, since it reads them: the Space images the
      // page names, stamped first, so a change meanwhile builds it again.
      const sourceSha256 = createHash("sha256")
        .update(data.sourceBytes)
        .digest("hex")
      const page = injectWidgetRuntime(data.html, "", "", { mode: "share" })
      // Only a page whose writer could read the Space's files shows them.
      const shows = data.widget.spaceImages === true
      const images = shows
        ? {
            sourceSha256,
            stamp: await htmlImagesStamp({
              spaceId: view.link.spaceId,
              path: view.path,
              sourceSha256,
              html: data.html,
            }),
          }
        : undefined
      const { html } = shows
        ? await inlineHtmlSpaceImages(view.link.spaceId, view.path, page)
        : { html: page }
      if (images) entry.images = images
      entry.bytes =
        Buffer.byteLength(html) +
        Buffer.byteLength(JSON.stringify([...schemas]))
      if (tools.get(key) === entry) bytes += entry.bytes
      const tool = {
        html,
        revision: createHash("sha256").update(html).digest("base64url"),
        key: createLinkKey(view.link.linkKey),
        permissions: data.widget.permissions,
        generation,
        schemaGeneration,
        schemas,
      }
      trimTools()
      return tool
    })
  ).catch((error) => {
    if (tools.get(key) === entry) {
      tools.delete(key)
      bytes -= entry.bytes
    }
    throw error
  })
  tools.set(key, entry)
  trimTools()
  return entry.value
}
