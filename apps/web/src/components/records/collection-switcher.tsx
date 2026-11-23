import { Link } from "@tanstack/react-router"
import { Check, ChevronsUpDown, Database } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { useRecordCollections } from "@/lib/queries"

/**
 * The open collection's name, opening a menu of the Space's collections to
 * switch to, as the Worktable switcher does in the sidebar.
 */
export function CollectionSwitcher({
  spaceId,
  collectionId,
  name,
}: {
  spaceId: string
  collectionId: string
  name: string
}) {
  const { data: collections } = useRecordCollections(spaceId)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button type="button" />}
        className="flex h-9 max-w-64 min-w-0 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent data-popup-open:bg-accent"
      >
        <Database className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(70vh,32rem)] w-auto max-w-80 min-w-60">
        {(collections ?? []).map((collection) => {
          const current = collection.id === collectionId
          return (
            <DropdownMenuItem
              key={collection.id}
              className={current ? "font-medium text-primary-text" : undefined}
              render={
                <Link
                  to="/spaces/$spaceId/records/$"
                  params={{ spaceId, _splat: collection.id }}
                  aria-current={current ? "page" : undefined}
                />
              }
            >
              <Database className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{collection.name}</span>
              {current ? (
                <Check className="text-primary" />
              ) : (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {collection.count}
                </span>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
