import { useMemo } from "react"
import type { EditorFiles } from "@/components/editor/editor"
import { embedSourceUrl, uploadEmbeddedFile } from "@/lib/file-embeds"
import { useDeploymentInfo } from "./use-deployment-info"

/**
 * A rich Doc's files, once files are on: embeds load from the Doc's Space,
 * and, where it can be edited, pasted or dropped files go in its folder.
 */
export function useEditorFiles(
  spaceId: string,
  docPath: string,
  options: {
    upload: boolean
    /** The versions of the Doc's files, from its page. */
    versions?: Readonly<Record<string, string>>
    /** For an old version: its files as they were at this time. */
    at?: string
  }
): EditorFiles | undefined {
  const filesOn = useDeploymentInfo().data?.capabilities.files ?? false
  return useMemo(
    () =>
      filesOn
        ? {
            resolve: (url: string) =>
              embedSourceUrl(spaceId, docPath, url, {
                versions: options.versions,
                at: options.at,
              }),
            ...(options.upload
              ? {
                  upload: (file: File) =>
                    uploadEmbeddedFile(spaceId, docPath, file),
                }
              : {}),
          }
        : undefined,
    [filesOn, spaceId, docPath, options.upload, options.versions, options.at]
  )
}
