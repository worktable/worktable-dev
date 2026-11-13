import { Link } from "@tanstack/react-router"
import { Clock3, PinOff } from "lucide-react"
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
import { ActorAvatar, When } from "@/components/home/home-latest"
import { useTheme } from "@/components/theme-provider"
import { useLifetimeActions } from "@/hooks/use-document-organize"
import { useActorName } from "@/lib/use-actor-name"
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

/** A small label over the thing the pointer is on. */
const tipClass =
  "pointer-events-none absolute z-20 flex flex-col gap-0.5 rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-4 whitespace-nowrap text-background"

/** Shows `label` over its child while the pointer is on it. */
function Tip({
  label,
  align = "center",
  children,
}: {
  label: string
  /** `start` keeps the label inside a card's left edge. */
  align?: "center" | "start"
  children: ReactNode
}) {
  return (
    <span className="group/tip relative flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          tipClass,
          "bottom-full mb-2 hidden group-hover/tip:flex",
          align === "start" ? "-left-1" : "left-1/2 -translate-x-1/2"
        )}
      >
        {label}
      </span>
    </span>
  )
}

/**
 * Docs touched on each of the last days, oldest first; the last is today.
 * Pointing at a day says which day, how much, and who.
 */
function Tracker({
  days,
  who,
  onOpen,
}: {
  days: number[]
  who?: ActivityActor[][]
  onOpen?: () => void
}) {
  const nameOf = useActorName()
  const [hovered, setHovered] = useState<number | null>(null)
  const count = hovered === null ? 0 : (days[hovered] ?? 0)
  const names =
    hovered === null ? [] : (who?.[hovered] ?? []).map((actor) => nameOf(actor))
  return (
    <span
      className={cn("relative grid gap-[3px]", onOpen && "cursor-pointer")}
      style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
      onClick={onOpen}
      onPointerLeave={() => setHovered(null)}
    >
      {days.map((dayCount, index) => (
        <span
          key={index}
          onPointerEnter={() => setHovered(index)}
          className={cn("aspect-square rounded-[3px]", LEVELS[level(dayCount)])}
        />
      ))}
      {hovered !== null && (
        <span
          role="tooltip"
          className={cn(
            tipClass,
            // Under the row, so the place's name stays readable; and inside
            // the card at either end of the row.
            "top-full mt-2",
            hovered < 3
              ? "left-0"
              : hovered > days.length - 4
                ? "right-0"
                : "-translate-x-1/2"
          )}
          style={
            hovered >= 3 && hovered <= days.length - 4
              ? { left: `${((hovered + 0.5) / days.length) * 100}%` }
              : undefined
          }
        >
          <span className="opacity-70">
            {dayName(
              dayFromToday(hovered - (days.length - 1)),
              hovered === days.length - 1
            )}
          </span>
          {count > 0 && (
            <span>
              <span className="font-medium">
                {count} {count === 1 ? "doc" : "docs"}
              </span>
              {names.length > 0 && ` · ${names.join(", ")}`}
            </span>
          )}
        </span>
      )}
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
  who,
  actors,
  lastAt,
  onOpen,
  children,
}: {
  icon: ReactNode
  name: string
  count?: number
  days: number[]
  who?: ActivityActor[][]
  actors: ActivityActor[]
  lastAt?: string
  /** What the card's link or button does, for the parts that sit over it. */
  onOpen?: () => void
  /** The link or button that covers the card. */
  children: ReactNode
}) {
  const nameOf = useActorName()
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
      <Tracker days={days} who={who} onOpen={onOpen} />
      <span className="flex h-6 items-center justify-between gap-2">
        <span
          className={cn(
            "relative -ml-0.5 flex items-center",
            onOpen && "cursor-pointer"
          )}
          onClick={onOpen}
        >
          {actors.map((actor, index) => (
            <span
              key={actor.id}
              className={cn(
                "relative flex rounded-full bg-card p-0.5 hover:z-10",
                index > 0 && "-ml-1.5"
              )}
            >
              <Tip label={nameOf(actor)} align="start">
                <ActorAvatar actor={actor} className="size-5 text-[0.625rem]" />
              </Tip>
            </span>
          ))}
        </span>
        {lastAt && <When at={lastAt} />}
      </span>
    </div>
  )
}

/** Cards' shape while the page loads, so nothing below them moves. */
export function PlaceCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 @3xl/page:grid-cols-4">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="h-[7.375rem] animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  )
}

export function PinTilesSkeleton({ count }: { count: number }) {
  return (
    <div className={pinGrid}>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="aspect-[5/4] animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  )
}

/** Pin tiles: four across a wide single column, two across beside the page. */
export const pinGrid =
  "grid grid-cols-2 gap-3 @2xl/page:grid-cols-4 @3xl/page:grid-cols-2"

/** The page beside its side column, once it has the room. */
export const pageColumns =
  "@3xl/page:grid @3xl/page:grid-cols-[minmax(0,1fr)_19rem] @3xl/page:items-start @3xl/page:gap-x-10 @3xl/page:gap-y-11 @4xl/page:grid-cols-[minmax(0,1fr)_23rem] @4xl/page:gap-x-12"

/** The side column: in the page's flow until there is room beside it. */
export const sideColumn = "@3xl/page:flex @3xl/page:flex-col @3xl/page:gap-9"

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
    <div className="group card-surface card-surface-interactive relative flex min-w-0 flex-col rounded-xl p-2 pb-3">
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
      <span className="mt-3 line-clamp-2 px-1 text-[0.8125rem] leading-[1.125rem] font-medium text-foreground">
        {title}
      </span>
      <span className="mt-auto flex h-5 min-w-0 items-center gap-1.5 px-1 pt-1.5 text-xs text-muted-foreground">
        {disabled ?? place}
      </span>
      {onUnpin && (
        <span className="absolute top-3.5 right-3.5 hidden opacity-0 transition-opacity group-hover:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:hover)]:flex">
          <Tip label="Unpin">
            <button
              type="button"
              aria-label="Unpin"
              onClick={onUnpin}
              className="flex size-7 cursor-pointer items-center justify-center rounded-md border border-card-border bg-card text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PinOff className="size-3.5" />
            </button>
          </Tip>
        </span>
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
export function ArchivingWeek({
  items,
  side = false,
}: {
  items: ArchivingItem[]
  /** Beside the page on a wide screen, where it reads as a section. */
  side?: boolean
}) {
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
      className={cn(
        "flex items-center justify-between gap-4 border-t border-border pt-5",
        side && "@3xl/page:border-t-0 @3xl/page:pt-0"
      )}
    >
      <h2
        id="archiving-heading"
        className={cn(
          "flex items-center gap-2 self-start pt-1 text-[0.8125rem] text-muted-foreground",
          side &&
            "@3xl/page:text-sm @3xl/page:font-semibold @3xl/page:text-foreground"
        )}
      >
        <Clock3 className={cn("size-4", side && "@3xl/page:hidden")} />
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
            "flex size-7 items-center justify-center rounded-md text-[0.72rem] font-medium tabular-nums",
            count === 0
              ? LEVELS[0]
              : count > 4
                ? cn(LEVELS[2], "text-foreground")
                : cn(LEVELS[1], "text-foreground")
          )
          return (
            <div
              key={day.date.getTime()}
              className="flex flex-col items-center gap-1.5"
            >
              {count === 0 ? (
                <Tip label={label}>
                  <span className={cell} />
                </Tip>
              ) : (
                <Popover>
                  <Tip label={`${label} · ${count} ${count === 1 ? "doc" : "docs"}`}>
                    <PopoverTrigger
                      aria-label={`${label}: ${count} archiving`}
                      className={cn(
                        cell,
                        "cursor-pointer outline-none hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring"
                      )}
                    >
                      {count}
                    </PopoverTrigger>
                  </Tip>
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
