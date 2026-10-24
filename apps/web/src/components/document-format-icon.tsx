import {
  AppWindow,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Paperclip,
  Pencil,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@worktable/ui/lib/utils"

/** The icon the sidebar uses for a document format, for lists elsewhere. */
export function DocumentFormatIcon({
  formatId,
  name,
  className = "size-4",
}: {
  formatId?: string
  /** A file's name, which says what kind of file it is. */
  name?: string
  className?: string
}) {
  if (formatId === "worktable.file") {
    return <FileTypeIcon name={name ?? ""} className={className} />
  }
  if (formatId === "worktable.html") return <AppWindow className={className} />
  if (formatId === "worktable.quickdraw") return <Pencil className={className} />
  if (formatId === "worktable.markdown") return <File className={className} />
  return <FileText className={className} />
}

// Kept beside the icon, which every page already loads with the sidebar, so
// lists of documents on Home and in a Doc's byline share no extra chunk.
/** Where a doc lives, set like a file path: Space, then its folders. */
export function DocLocation({
  spaceName,
  path,
  className,
}: {
  spaceName?: string
  path: string
  className?: string
}) {
  const parts = [spaceName, ...path.split("/").slice(0, -1)].filter(
    (part): part is string => Boolean(part)
  )
  return (
    <span
      className={cn(
        "min-w-0 flex-1 truncate font-mono text-[0.7rem] text-muted-foreground/80",
        className
      )}
    >
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && (
            <span className="px-0.5 text-muted-foreground/40">/</span>
          )}
          {part}
        </span>
      ))}
    </span>
  )
}

const BY_EXTENSION: ReadonlyArray<[RegExp, LucideIcon]> = [
  [/\.(?:avif|gif|jpe?g|png|svg|webp|heic)$/i, FileImage],
  [/\.(?:csv|tsv|xlsx?|ods|numbers)$/i, FileSpreadsheet],
  [/\.(?:pdf|txt|log|rtf|docx?)$/i, FileText],
  [/\.(?:mp3|wav|m4a|ogg|flac)$/i, FileAudio],
  [/\.(?:mp4|mov|webm|mkv)$/i, FileVideo],
  [/\.(?:zip|tar|gz|tgz|7z|rar)$/i, FileArchive],
  [/\.(?:json|jsonl|ya?ml|xml|toml|ini)$/i, FileCode],
]

/** The icon for a file Worktable doesn't edit, by the kind its name says. */
export function FileTypeIcon({
  name,
  className,
}: {
  name: string
  className?: string
}) {
  const Icon = BY_EXTENSION.find(([pattern]) => pattern.test(name))?.[1] ?? Paperclip
  return <Icon className={className} />
}
