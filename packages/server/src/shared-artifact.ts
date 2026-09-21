import { existsSync } from "node:fs"
import { join } from "node:path"
import { CanonicalIdSchema } from "@worktable/types"
import { z } from "zod"
import type { ShareArtifact } from "./share-store.ts"
import {
  getDocArchiveInfo,
  getSpacesBaseDir,
  getSpaceArchiveInfo,
  docExists,
  readDoc,
  readSpace,
  sanitizeDocPath,
} from "./store.ts"
import {
  getWidgetContentPath,
  getWidgetPath,
  readWidget,
  readWidgetDocument,
} from "./widget-store.ts"
import {
  htmlDocumentSourceExistsV2,
  usesHtmlDocumentStorageV2,
} from "./html-document-storage-v2.ts"
import { analyzeDocumentPath } from "./document-path.ts"

const DocArtifact = z
  .object({
    kind: z.literal("doc"),
    spaceId: CanonicalIdSchema,
    artifactKey: z.string().min(1).max(2048),
  })
  .strict()
  .refine(
    (artifact) =>
      sanitizeDocPath(artifact.artifactKey) === artifact.artifactKey,
    { path: ["artifactKey"], message: "Invalid document path" }
  )

const HtmlArtifact = z
  .object({
    kind: z.literal("html"),
    spaceId: CanonicalIdSchema,
    artifactKey: z.string().min(1).max(4096),
  })
  .strict()
  .refine(
    (artifact) => {
      const path = analyzeDocumentPath(artifact.artifactKey)
      return path.safe && path.canonicalPath === artifact.artifactKey
    },
    { path: ["artifactKey"], message: "Invalid HTML document path" }
  )

export const ShareArtifactInput = z.discriminatedUnion("kind", [
  DocArtifact,
  HtmlArtifact,
])

export type ReadableSharedArtifact =
  | {
      kind: "doc"
      title: string
      content: unknown[] | string
      format: "blocknote" | "markdown"
    }
  | { kind: "html"; title: string; html: string }

function titleFromDocPath(path: string): string {
  const segment = path.split("/").at(-1) ?? path
  return segment.replace(/[-_]+/g, " ").trim() || "Shared document"
}

/**
 * Tell lifecycle reconciliation whether a Space still represents the same
 * guest-eligible identity. A malformed file remains an existing identity and
 * fails closed at read time; disappearance or archive is permanent.
 */
export async function sharedSpaceIdentityIsCurrent(
  spaceId: string
): Promise<boolean> {
  if (!existsSync(join(getSpacesBaseDir(), spaceId, "space.json"))) return false
  const { data: space } = await readSpace(spaceId)
  return !space || !getSpaceArchiveInfo(space)
}

/** Distinguish removal from a temporarily unreadable external edit. */
export async function sharedArtifactIdentityIsCurrent(
  artifact: ShareArtifact
): Promise<boolean> {
  if (!(await sharedSpaceIdentityIsCurrent(artifact.spaceId))) return false

  if (artifact.kind === "doc") {
    if (!(await docExists(artifact.spaceId, artifact.artifactKey))) return false
    return !(await getDocArchiveInfo(artifact.spaceId, artifact.artifactKey))
  }

  if (await usesHtmlDocumentStorageV2()) {
    if (
      !(await htmlDocumentSourceExistsV2(
        artifact.spaceId,
        artifact.artifactKey
      ))
    ) {
      return false
    }
  } else if (
    !existsSync(getWidgetPath(artifact.spaceId, artifact.artifactKey)) ||
    !existsSync(getWidgetContentPath(artifact.spaceId, artifact.artifactKey))
  ) {
    return false
  }
  const { data: widget } = await readWidget(
    artifact.spaceId,
    artifact.artifactKey
  )
  return !widget?.archive
}

/** Read the latest saved artifact only while it remains guest-eligible. */
export async function readSharedArtifact(
  artifact: ShareArtifact
): Promise<ReadableSharedArtifact | null> {
  const { data: space } = await readSpace(artifact.spaceId)
  if (!space || getSpaceArchiveInfo(space)) return null

  if (artifact.kind === "doc") {
    const [doc, archive] = await Promise.all([
      readDoc(artifact.spaceId, artifact.artifactKey),
      getDocArchiveInfo(artifact.spaceId, artifact.artifactKey),
    ])
    if (archive || doc.error || doc.data === null || doc.format === null) {
      return null
    }
    return {
      kind: "doc",
      title: titleFromDocPath(artifact.artifactKey),
      content: doc.data,
      format: doc.format,
    }
  }

  const { data } = await readWidgetDocument(artifact.spaceId, artifact.artifactKey)
  if (!data || data.widget.archive) return null
  return { kind: "html", title: data.widget.name, html: data.html }
}
