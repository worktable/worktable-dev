import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "@worktable/ui/components/button"
import { Popover, PopoverContent } from "@worktable/ui/components/popover"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import type { ArchivingItem } from "@/components/home/home-cards"
import { useLifetimeActions } from "@/hooks/use-document-organize"

function ArchivingRow({ item }: { item: ArchivingItem }) {
  const { keep } = useLifetimeActions(item.spaceId, item.document.path)
  const [keeping, setKeeping] = useState(false)
  return (
    <li className="group flex h-9 min-w-0 items-center gap-2.5">
      <DocumentFormatIcon
        formatId={item.document.format.id}
        name={item.document.path}
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <Link
        to="/spaces/$spaceId/documents/$"
        params={{ spaceId: item.spaceId, _splat: item.document.path }}
        className="min-w-0 flex-1 truncate text-[0.8125rem] text-foreground hover:text-primary-text"
      >
        {item.document.title}
      </Link>
      <Button
        size="xs"
        variant="outline"
        disabled={keeping}
        onClick={() => {
          setKeeping(true)
          void keep().finally(() => setKeeping(false))
        }}
      >
        Keep
      </Button>
    </li>
  )
}

/** The docs that archive on one day, each with Keep, beside that day. */
export default function ArchivingDay({
  label,
  items,
  anchor,
  onClose,
}: {
  label: string
  items: ArchivingItem[]
  anchor: HTMLElement
  onClose: () => void
}) {
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <PopoverContent anchor={anchor} align="end" className="w-80 gap-1">
        <p className="px-0.5 text-xs font-medium text-muted-foreground">
          {label}
        </p>
        <ul className="max-h-72 overflow-y-auto">
          {items.map((item) => (
            <ArchivingRow
              key={`${item.spaceId}/${item.document.path}`}
              item={item}
            />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
