import { createHtmlDocument } from "../html-document-create.ts"
import { ensureSpaceDirectories, writeDoc } from "../store.ts"
import { writeWidget } from "../widget-store.ts"
import { ensureWorkspaceManifest } from "../workspace.ts"

/** Product fixtures use the same durable identity admission as REST and MCP. */
export async function writeManagedFixtureDoc(
  ...[spaceId, path, content, options]: Parameters<typeof writeDoc>
) {
  await ensureSpaceDirectories(spaceId)
  return writeDoc(spaceId, path, content, { managedIdentity: true, ...options })
}

export async function writeManagedFixtureHtml(
  ...[spaceId, widget, html, options]: Parameters<typeof writeWidget>
): ReturnType<typeof writeWidget> {
  await ensureSpaceDirectories(spaceId)
  if (options?.documentId || ensureWorkspaceManifest().version === 1) {
    return writeWidget(spaceId, widget, html, options)
  }
  const result = await createHtmlDocument({
    ...widget,
    spaceId,
    explicitId: widget.id,
    html,
    versionSource: "fixture",
    versionUpdatedBy: widget.createdBy,
    recordVersion: false,
  })
  return { data: result.data ?? null, error: result.error ?? null }
}
