import { PinOff } from "lucide-react"
import { useDocumentOrganizeActions } from "@/hooks/use-document-organize"

/** Loaded only when the sidebar has a pinned document. */
export function UnpinDocumentButton({
  spaceId,
  path,
  title,
}: {
  spaceId: string
  path: string
  title: string
}) {
  const unpin = useDocumentOrganizeActions(spaceId, path).find(
    (action) => action.id === "unpin"
  )
  if (!unpin) return null
  return (
    <button
      type="button"
      aria-label={`Unpin ${title}`}
      title="Unpin"
      onClick={unpin.onSelect}
      className="flex size-9 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/30 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground sm:size-6"
    >
      <PinOff className="size-3.5" />
    </button>
  )
}
