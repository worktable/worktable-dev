import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@worktable/ui/components/dropdown-menu"
import {
  Trash,
  Pencil,
  MoreVertical,
  Archive,
  RotateCcw,
  Copy,
  Download,
} from "lucide-react"

interface DocContextMenuProps {
  documentName: string
  isFolder: boolean
  archived?: boolean
  // Optional so callers can hide folder actions that every member does not
  // support.
  onRename?: () => void
  onDelete?: () => void
  onArchive?: () => void
  onRestore?: () => void
  onCopyMarkdown?: () => void
  onDownload?: () => void
}

export function DocContextMenuButton({
  documentName,
  isFolder,
  archived,
  onRename,
  onDelete,
  onArchive,
  onRestore,
  onCopyMarkdown,
  onDownload,
}: DocContextMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex size-9 items-center justify-center rounded-md text-sidebar-foreground/30 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground sm:size-6"
        render={
          <button type="button" aria-label={`Actions for ${documentName}`} />
        }
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-44">
        {onCopyMarkdown && (
          <DropdownMenuItem onClick={onCopyMarkdown}>
            <Copy className="mr-2 h-4 w-4" />
            Copy Markdown
          </DropdownMenuItem>
        )}
        {onDownload && (
          <DropdownMenuItem onClick={onDownload}>
            <Download className="mr-2 h-4 w-4" />
            Download Markdown
          </DropdownMenuItem>
        )}
        {onRename && (
          <DropdownMenuItem onClick={onRename}>
            <Pencil className="mr-2 h-4 w-4" />
            {isFolder ? "Rename Folder" : "Rename"}
          </DropdownMenuItem>
        )}
        {(archived ? onRestore : onArchive) && (
          <DropdownMenuItem onClick={archived ? onRestore : onArchive}>
            {archived ? (
              <RotateCcw className="mr-2 h-4 w-4" />
            ) : (
              <Archive className="mr-2 h-4 w-4" />
            )}
            {archived
              ? isFolder
                ? "Restore Folder"
                : "Restore"
              : isFolder
                ? "Archive Folder"
                : "Archive"}
          </DropdownMenuItem>
        )}
        {onDelete && (
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash className="mr-2 h-4 w-4" />
            {isFolder ? "Delete Folder" : "Delete"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
