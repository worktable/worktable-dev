import { buttonVariants } from "@worktable/ui/components/button"

export function SourceCodeLink({ sourceUrl }: { sourceUrl?: string }) {
  if (!sourceUrl) return null
  try {
    const url = new URL(sourceUrl)
    if (url.protocol !== "https:" || url.username || url.password) return null
  } catch {
    return null
  }
  return (
    <a
      href={sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonVariants({ variant: "link", className: "self-start" })}
    >
      Source code
    </a>
  )
}
