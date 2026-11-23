import { Clock3 } from "lucide-react"
import { formatArchiveDate } from "@/lib/lifetime"

/** Within this long of its date, a temporary doc's clock turns amber. */
const SOON_MS = 2 * 86_400_000

function archivesSoon(archiveOn: string | undefined): boolean {
  const at = archiveOn ? Date.parse(archiveOn) : Number.NaN
  return !Number.isNaN(at) && at - Date.now() < SOON_MS
}

/**
 * A temporary document's clock, at the end of its row. Pointing at it says
 * when the document archives; it turns amber when that is close.
 */
export function TemporaryMark({
  archiveOn,
  className = "",
}: {
  archiveOn?: string
  className?: string
}) {
  const soon = archivesSoon(archiveOn)
  const label = archiveOn ? `Archives ${formatArchiveDate(archiveOn)}` : "Temporary"
  return (
    <span
      className={`group/clock relative flex size-6 shrink-0 items-center justify-center ${className}`}
    >
      <Clock3
        aria-label={label}
        className={`size-3.5 ${soon ? "text-warning" : "text-sidebar-foreground/30"}`}
      />
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute right-0 bottom-full z-20 mb-1 translate-y-1 rounded-md bg-foreground px-2 py-1 text-xs leading-4 whitespace-nowrap text-background opacity-0 transition-[opacity,translate,visibility] duration-150 ease-out group-hover/clock:visible group-hover/clock:translate-y-0 group-hover/clock:opacity-100"
      >
        {label}
      </span>
    </span>
  )
}
