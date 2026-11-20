import { File as FileIcon } from "lucide-react"

/** A file Worktable isn't showing: its name, its type and why. */
export function FileCard({ name, status }: { name: string; status: string }) {
  const dot = name.lastIndexOf(".")
  const type = dot > 0 ? name.slice(dot + 1).toUpperCase() : "File"
  return (
    <div className="not-prose my-6 flex items-center gap-3 rounded-xl card-surface p-4">
      <div className="flex size-10 items-center justify-center rounded-lg bg-surface-tint text-muted-foreground">
        <FileIcon className="size-5" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {name}
        </div>
        <div className="text-sm text-muted-foreground">
          {type} · {status}
        </div>
      </div>
    </div>
  )
}
