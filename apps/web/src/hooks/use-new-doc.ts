import { useRef } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "@worktable/ui/components/sonner"
import { createDoc } from "@/lib/docs-api"
import { docQueryKeys } from "@/lib/docs-queries"
import { documentQueryKeys } from "@/lib/documents-queries"
import { useNewDocumentLifetime } from "@/lib/lifetime"

/**
 * Create a doc instantly and open it. The server names it untitled /
 * untitled-2 / … and the title follows the doc's H1 once there is one.
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
          undefined,
          lifetime
        )
        await queryClient.invalidateQueries({
          queryKey: docQueryKeys.docs(spaceId),
        })
        await queryClient.invalidateQueries({
          queryKey: documentQueryKeys.list(spaceId),
        })
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
