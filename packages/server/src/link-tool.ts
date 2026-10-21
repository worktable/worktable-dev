import { createHash } from "node:crypto"
import { createLinkKey, type LinkKey } from "./link-grant-view.ts"
import { injectWidgetRuntime } from "./widget-authoring.ts"
import type { WidgetFile, RecordCollectionSchema } from "@worktable/types"
import { readWidgetDocument } from "./widget-store.ts"
import { readLinkGrantSchemas } from "./link-grant.ts"
import { useResolvedDocumentHandle } from "./document-query.ts"
import { publicShareKind } from "./document-page-service.ts"
import { spaceGeneration } from "./workspace-read-model.ts"
import { workspaceCacheKey } from "./workspace.ts"
import { runAsLinkVisitor, withLinkGrantRead } from "./team-policy.ts"
import type { ShareLinkView } from "./share-link-views.ts"

export interface LinkTool {
  html: string
  revision: string
  key: LinkKey
  permissions: WidgetFile["permissions"]
  generation: number
  schemas: ReadonlyMap<string, RecordCollectionSchema>
}

// Source and permissions share one snapshot. A metadata edit invalidates it
// even when the HTML's content digest did not change. Warm reads do no file I/O.
const tools = new Map<
  string,
  { value: Promise<LinkTool | null>; bytes: number }
>()
let bytes = 0
const MAX_BYTES = 16 * 1024 * 1024

export function readLinkTool(view: ShareLinkView): Promise<LinkTool | null> {
  const generation = spaceGeneration(view.link.spaceId)
  const key = `${workspaceCacheKey()}\0${view.link.id}\0${view.link.spaceId}\0${view.link.documentId}\0${view.path}\0${view.link.grantRevision}\0${generation}`
  const cached = tools.get(key)
  if (cached) return cached.value
  const entry = {
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
            return { tool: null }
          const [{ data }, schemas] = await Promise.all([
            readWidgetDocument(view.link.spaceId, view.path),
            readLinkGrantSchemas(view.link.spaceId, grant),
          ])
          if (
            !data ||
            data.widget.archive ||
            spaceGeneration(view.link.spaceId) !== generation
          )
            return { tool: null }
          const html = injectWidgetRuntime(data.html, "", "", { mode: "share" })
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
            schemas,
          }
          for (const [oldKey, old] of tools) {
            if (tools.size <= 32 && bytes <= MAX_BYTES) break
            tools.delete(oldKey)
            bytes -= old.bytes
          }
          return { tool }
        }
      )
      return "tool" in resolved ? resolved.tool : null
    })
  ).catch((error) => {
    if (tools.get(key) === entry) tools.delete(key)
    throw error
  })
  tools.set(key, entry)
  return entry.value
}
