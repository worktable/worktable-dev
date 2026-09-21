import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@worktable/ui/components/dropdown-menu"
import {
  Trash,
  Pencil,
  FilePlus,
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
  onNewDoc?: () => void
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
  onNewDoc,
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
        {isFolder && onNewDoc && (
          <>
            <DropdownMenuItem onClick={onNewDoc}>
              <FilePlus className="mr-2 h-4 w-4" />
              New Doc
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
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
            {isFolder ? "Rename folder" : "Rename"}
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
                ? "Restore folder"
                : "Restore"
              : isFolder
                ? "Archive folder"
                : "Archive"}
          </DropdownMenuItem>
        )}
        {onDelete && (
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash className="mr-2 h-4 w-4" />
            {isFolder ? "Delete folder" : "Delete"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
