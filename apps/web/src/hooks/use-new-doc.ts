import { useRef } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "@worktable/ui/components/sonner"
import { createDoc } from "@/lib/docs-api"
import { docQueryKeys } from "@/lib/docs-queries"
import { documentQueryKeys } from "@/lib/documents-queries"
import { useNewDocumentLifetime } from "@/lib/lifetime"

// Docs this tab just created, so their page can start in the title.
const justCreated = new Set<string>()

/** Whether this tab just created the doc; true only the first time asked. */
export function takeJustCreated(spaceId: string, path: string): boolean {
  return justCreated.delete(`${spaceId}\0${path}`)
}

/**
 * Create a doc instantly and open it on its empty title. The server names it
 * untitled / untitled-2 / …, and the doc takes the title's name when the
 * title is first left.
 */
export function useNewDocIn(onCreated?: () => void) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [lifetime] = useNewDocumentLifetime()
  const pendingRef = useRef(false)

  return (spaceId: string, folder?: string) => {
    if (pendingRef.current) return
    pendingRef.current = true
    void (async () => {
      try {
        const { path } = await createDoc(
          spaceId,
          folder ? `${folder}/Untitled` : "Untitled",
          [{ type: "heading", props: { level: 1 }, content: [] }],
          lifetime
        )
        justCreated.add(`${spaceId}\0${path}`)
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: docQueryKeys.docs(spaceId),
            exact: true,
          }),
          queryClient.invalidateQueries({
            queryKey: documentQueryKeys.list(spaceId),
            exact: true,
          }),
        ])
        onCreated?.()
        void navigate({
          to: "/spaces/$spaceId/documents/$",
          params: { spaceId, _splat: path },
        })
        toast.success("Doc created")
      } catch (err) {
        toast.error("Failed to create doc")
        console.error("Failed to create doc:", err)
      } finally {
        pendingRef.current = false
      }
    })()
  }
}

export function useNewDoc(spaceId: string, onCreated?: () => void) {
  const newDocIn = useNewDocIn(onCreated)
  return (folder?: string) => newDocIn(spaceId, folder)
}
