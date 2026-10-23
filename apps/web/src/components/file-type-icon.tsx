import {
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Paperclip,
  type LucideIcon,
} from "lucide-react"

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
