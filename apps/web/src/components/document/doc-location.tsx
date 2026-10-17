import { cn } from "@worktable/ui/lib/utils"

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
