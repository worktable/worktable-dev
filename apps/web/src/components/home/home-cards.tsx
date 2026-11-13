import { Link } from "@tanstack/react-router"
import { Clock3 } from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import type { ActivityActor, DocumentSummary } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@worktable/ui/components/popover"
import { cn } from "@worktable/ui/lib/utils"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import { ActorAvatar } from "@/components/home/home-latest"
import { useTheme } from "@/components/theme-provider"
import { useLifetimeActions } from "@/hooks/use-document-organize"
import { shortWhen } from "@/lib/activity-format"
import { spaceAccessKey } from "@/lib/team-access"
import { widgetContentUrl } from "@/lib/widgets-api"

export const sectionHeading = "text-sm font-semibold text-foreground"

// ── Two weeks at a glance ──────────────────────────────────

const LEVELS = [
  "bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)]",
  "bg-[color-mix(in_oklch,var(--foreground)_15%,transparent)]",
  "bg-[color-mix(in_oklch,var(--foreground)_30%,transparent)]",
  "bg-[color-mix(in_oklch,var(--foreground)_50%,transparent)]",
  "bg-[color-mix(in_oklch,var(--foreground)_76%,transparent)]",
] as const

function level(count: number): number {
  if (count <= 0) return 0
  if (count <= 2) return 1
  if (count <= 5) return 2
  if (count <= 12) return 3
  return 4
}

/** Local midnight `offset` days from today. */
function dayFromToday(offset: number): Date {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + offset)
  return date
}

function dayName(date: Date, today: boolean): string {
  return today
    ? "Today"
    : date.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
}

/** Docs touched on each of the last days, oldest first; the last is today. */
function Tracker({ days }: { days: number[] }) {
  return (
    <span
      className="grid gap-[3px]"
      style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
    >
      {days.map((count, index) => {
        const ago = days.length - 1 - index
        return (
          <span
            key={index}
            title={
              count > 0
                ? `${dayName(dayFromToday(-ago), ago === 0)} · ${count} ${count === 1 ? "doc" : "docs"}`
                : undefined
            }
            className={cn("aspect-square rounded-[3px]", LEVELS[level(count)])}
          />
        )
      })}
    </span>
  )
}

/**
 * A Space on Home, or a folder in a Space: its name, how busy its last two
 * weeks were, who worked there, and when it was last touched.
 */
export function PlaceCard({
  icon,
  name,
  count,
  days,
  actors,
  lastAt,
  children,
}: {
  icon: ReactNode
  name: string
  count?: number
  days: number[]
  actors: ActivityActor[]
  lastAt?: string
  /** The link or button that covers the card. */
  children: ReactNode
}) {
  return (
    <div className="card-surface card-surface-interactive relative flex min-w-0 flex-col gap-3.5 rounded-xl p-3.5">
      {children}
      <span className="flex min-w-0 items-center gap-2.5">
        {icon}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {name}
        </span>
        {count !== undefined && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
      </span>
      <Tracker days={days} />
      <span className="flex h-6 items-center justify-between gap-2">
        <span className="-ml-0.5 flex items-center">
          {actors.map((actor, index) => (
            <span
              key={actor.id}
              className={cn(
                "relative flex rounded-full bg-card p-0.5",
                index > 0 && "-ml-1.5"
              )}
            >
              <ActorAvatar actor={actor} className="size-5 text-[0.625rem]" />
            </span>
          ))}
        </span>
        {lastAt && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {shortWhen(lastAt)}
          </span>
        )}
      </span>
    </div>
  )
}

// ── Pinned ─────────────────────────────────────────────────

const PREVIEW_WIDTH = 1100
const PREVIEW_HEIGHT = 688

/** The page itself, drawn small. It cannot be clicked or focused. */
function PagePreview({
  spaceId,
  path,
  revision,
}: {
  spaceId: string
  path: string
  revision: string
}) {
  const { resolvedTheme } = useTheme()
  const frame = useRef<HTMLSpanElement>(null)
  const [scale, setScale] = useState<number | null>(null)
  useEffect(() => {
    const element = frame.current
    if (!element) return
    const fit = () => setScale(element.clientWidth / PREVIEW_WIDTH)
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const accessKey = spaceAccessKey(spaceId)
  const src = `${widgetContentUrl(spaceId, path)}?theme=${resolvedTheme}&rev=${encodeURIComponent(revision)}${
    accessKey ? `&a=${encodeURIComponent(accessKey)}` : ""
  }`
  return (
    <span
      ref={frame}
      aria-hidden
      className="relative block aspect-[16/10] overflow-hidden rounded-lg border border-card-border bg-background"
    >
      {scale !== null && (
        <iframe
          src={src}
          title=""
          tabIndex={-1}
          loading="lazy"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
          style={{
            width: PREVIEW_WIDTH,
            height: PREVIEW_HEIGHT,
            transform: `scale(${scale})`,
          }}
        />
      )}
    </span>
  )
}

/**
 * A pinned doc: a page shows itself, anything else its icon on its Space's
 * color.
 */
export function PinTile({
  spaceId,
  path,
  title,
  formatId,
  revision,
  tint,
  place,
  onUnpin,
  disabled,
}: {
  spaceId: string
  path: string
  title: string
  formatId?: string
  /** The content revision; a page without one shows its icon. */
  revision?: string
  /** The Space's soft color and ink, for a doc that has no preview. */
  tint: CSSProperties
  /** Where it lives: its Space on Home, its folder in a Space. */
  place?: ReactNode
  onUnpin?: () => void
  /** An archived or missing doc: shown, not opened. */
  disabled?: string
}) {
  return (
    <div className="group card-surface card-surface-interactive relative flex min-w-0 flex-col rounded-xl p-2 pb-2.5">
      {!disabled && (
        <Link
          to="/spaces/$spaceId/documents/$"
          params={{ spaceId, _splat: path }}
          className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={title}
        />
      )}
      {formatId === "worktable.html" && revision && !disabled ? (
        <PagePreview spaceId={spaceId} path={path} revision={revision} />
      ) : (
        <span
          aria-hidden
          className="flex aspect-[16/10] items-center justify-center rounded-lg"
          style={tint}
        >
          <DocumentFormatIcon
            formatId={formatId}
            name={path}
            className="size-6 stroke-[1.6]"
          />
        </span>
      )}
      <span className="mt-2.5 truncate px-1 text-[0.8125rem] font-medium text-foreground">
        {title}
      </span>
      <span className="mt-0.5 flex h-5 min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground">
        {disabled ?? place}
      </span>
      {onUnpin && (
        <Button
          size="xs"
          variant="outline"
          className="absolute top-3 right-3 opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          onClick={onUnpin}
        >
          Unpin
        </Button>
      )}
    </div>
  )
}

// ── Archiving ──────────────────────────────────────────────

export interface ArchivingItem {
  spaceId: string
  spaceName?: string
  document: Pick<DocumentSummary, "path" | "title" | "format" | "archiveOn">
}

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

/** Calendar days from today to a date, in the reader's time zone. */
function daysUntil(iso: string): number {
  const date = new Date(iso)
  date.setHours(0, 0, 0, 0)
  return Math.round((date.getTime() - dayFromToday(0).getTime()) / 86_400_000)
}

/**
 * How many temporary docs archive on each of the next seven days. A day with
 * docs opens them, with Keep.
 */
export function ArchivingWeek({ items }: { items: ArchivingItem[] }) {
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: dayFromToday(index + 1),
    items: [] as ArchivingItem[],
  }))
  for (const item of items) {
    if (!item.document.archiveOn) continue
    // A doc already due archives at the next sweep, so it counts tomorrow.
    const index = Math.max(1, daysUntil(item.document.archiveOn)) - 1
    days[index]?.items.push(item)
  }
  if (days.every((day) => day.items.length === 0)) return null
  return (
    <section
      aria-labelledby="archiving-heading"
      className="flex items-center justify-between gap-4 border-t border-border pt-5 @4xl/page:flex-col @4xl/page:items-stretch @4xl/page:gap-3 @4xl/page:border-t-0 @4xl/page:pt-0"
    >
      <h2
        id="archiving-heading"
        className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground @4xl/page:text-sm @4xl/page:font-semibold @4xl/page:text-foreground"
      >
        <Clock3 className="size-4 @4xl/page:hidden" />
        Archiving
      </h2>
      <div className="flex gap-1.5">
        {days.map((day) => {
          const count = day.items.length
          const label = day.date.toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          })
          const cell = cn(
            "flex h-6 w-6 items-center justify-center rounded-md text-[0.72rem] font-semibold tabular-nums @4xl/page:h-8 @4xl/page:w-full @4xl/page:rounded-lg",
            count === 0
              ? LEVELS[0]
              : count > 4
                ? cn(LEVELS[3], "text-background")
                : cn(LEVELS[2], "text-foreground")
          )
          return (
            <div
              key={day.date.getTime()}
              className="flex flex-col items-center gap-1 @4xl/page:flex-1"
            >
              {count === 0 ? (
                <span className={cell} />
              ) : (
                <Popover>
                  <PopoverTrigger
                    aria-label={`${label}: ${count} archiving`}
                    className={cn(
                      cell,
                      "cursor-pointer outline-none hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring"
                    )}
                  >
                    {count}
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-80 gap-1">
                    <p className="px-0.5 text-xs font-medium text-muted-foreground">
                      {label}
                    </p>
                    <ul className="max-h-72 overflow-y-auto">
                      {day.items.map((item) => (
                        <ArchivingRow
                          key={`${item.spaceId}/${item.document.path}`}
                          item={item}
                        />
                      ))}
                    </ul>
                  </PopoverContent>
                </Popover>
              )}
              <span className="text-[0.66rem] leading-none text-muted-foreground">
                {day.date.toLocaleDateString(undefined, { weekday: "narrow" })}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
