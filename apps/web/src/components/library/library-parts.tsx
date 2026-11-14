import { Link } from "@tanstack/react-router"
import { Hourglass, Trash2, type LucideIcon } from "lucide-react"
import { memo, type ReactNode } from "react"
import { cn } from "@worktable/ui/lib/utils"
import {
  DocPicker,
  type DocChoice,
} from "@/components/library/add-skill-dialog"
import { LibraryMark } from "@/components/library/library-mark"
import { libraryKey, skillTitle, type LibraryEntry } from "@/lib/library"
import { useLibraryName, when } from "@/lib/library-actions"
import {
  waitingOn,
  type Place,
  type View,
  type Waiting,
} from "@/lib/library-view"

/** A filled dot where an agent's proposal waits; a ring where a draft does. */
export function WaitingDot({
  waiting,
  className,
}: {
  waiting: Waiting
  className?: string
}) {
  if (!waiting) return null
  return (
    <span
      role="img"
      aria-label={waiting === "proposal" ? "Proposal" : "Draft"}
      className={cn(
        "size-2 shrink-0 rounded-full",
        waiting === "proposal"
          ? "bg-primary"
          : "border-[1.5px] border-muted-foreground",
        className
      )}
    />
  )
}

const MARK = "size-4 text-[9px] [&_svg]:size-3"

// ---- The panel: the libraries there are ----

const PANEL_ROW =
  "flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground max-md:h-11"

function PanelLink({
  where,
  current,
  icon,
  label,
  count,
}: {
  where: string
  current: boolean
  icon: ReactNode
  label: string
  count?: number
}) {
  return (
    <Link
      to="/library/$"
      params={{ _splat: where }}
      aria-current={current ? "page" : undefined}
      className={PANEL_ROW}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
    </Link>
  )
}

const ViewIcon = ({ icon: Icon }: { icon: LucideIcon }) => (
  <Icon className="size-4 shrink-0" />
)

const PANEL_LABEL =
  "px-2.5 pt-4 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground/60 uppercase"

/**
 * The libraries that hold skills, the Worktable's, then Spaces', then
 * agents', with what waits on top. Not the Spaces themselves: the sidebar
 * has those.
 */
export function LibraryPanel({
  places,
  pending,
  removed,
  current,
  nameOf,
  className,
}: {
  places: Place[]
  pending: number
  removed: number
  /** The library or view shown, by key. */
  current?: string
  nameOf: (place: Pick<Place, "library" | "name">) => string
  className?: string
}) {
  const group = (kind: Place["library"]["kind"]) =>
    places.filter((place) => place.library.kind === kind)
  const section = (label: string, shown: Place[]) =>
    shown.length > 0 && (
      <>
        <p className={PANEL_LABEL}>{label}</p>
        {shown.map((place) => (
          <PanelLink
            key={place.key}
            where={place.key}
            current={current === place.key}
            icon={
              <LibraryMark
                library={place.library}
                name={nameOf(place)}
                className={MARK}
              />
            }
            label={nameOf(place)}
            count={place.count}
          />
        ))}
      </>
    )
  return (
    <nav
      aria-label="Libraries"
      className={cn("flex flex-col gap-0.5", className)}
    >
      {pending > 0 && (
        <PanelLink
          where="pending"
          current={current === "pending"}
          icon={<ViewIcon icon={Hourglass} />}
          label="Pending"
          count={pending}
        />
      )}
      {section("Worktable", group("worktable"))}
      {section("Spaces", group("space"))}
      {section("Agents", group("agent"))}
      {removed > 0 && (
        <div className="mt-3 border-t border-border/60 pt-2">
          <PanelLink
            where="removed"
            current={current === "removed"}
            icon={<ViewIcon icon={Trash2} />}
            label="Removed"
          />
        </div>
      )}
    </nav>
  )
}

// ---- Rows ----

/** What an agent proposed, as Home's Pending says it. */
const PROPOSED: Record<NonNullable<LibraryEntry["proposal"]>["kind"], string> =
  {
    add: "proposed adding",
    update: "proposed updating",
    remove: "proposed removing",
  }

/**
 * One skill, in the rhythm of Home's rows: its title, then when agents use
 * it or what waits on it, and when it last changed. Rows that mix libraries
 * lead with the library's mark.
 */
export const SkillRow = memo(function SkillRow({
  entry,
  marked = false,
}: {
  entry: LibraryEntry
  marked?: boolean
}) {
  const libraryName = useLibraryName()
  const waiting = waitingOn(entry)
  const line = entry.removed
    ? `Removed ${when(entry.removed.at)}`
    : entry.proposal
      ? `${entry.proposal.by.displayName} ${PROPOSED[entry.proposal.kind]}`
      : entry.draft
        ? "Draft Changes"
        : entry.description
  const at = entry.removed
    ? undefined
    : (entry.proposal?.at ?? entry.live?.savedAt)
  return (
    <Link
      to="/library/$"
      params={{ _splat: `${libraryKey(entry.library)}/${entry.id}` }}
      className={cn(
        "group grid items-center gap-x-3.5 gap-y-px rounded-xl px-2.5 py-3 transition-colors outline-none hover:bg-surface-hover focus-visible:bg-surface-hover",
        marked
          ? "grid-cols-[2rem_minmax(0,1fr)_auto]"
          : "grid-cols-[minmax(0,1fr)_auto]"
      )}
    >
      {marked && (
        <LibraryMark
          library={entry.library}
          name={libraryName(entry)}
          className="row-span-2 size-8 self-start rounded-lg text-xs @lg/page:self-center [&_svg]:size-4"
        />
      )}
      <span className="min-w-0 truncate text-[0.9375rem] leading-6 font-medium text-foreground">
        {skillTitle(entry)}
      </span>
      <span className="shrink-0 self-start pt-1 text-xs text-muted-foreground tabular-nums @lg/page:row-span-2">
        {at && when(at)}
      </span>
      {/* On a phone the line runs under the time, as Home's rows do. */}
      <span
        className={cn(
          "col-span-2 flex min-w-0 items-center gap-1.5 text-[0.8125rem] leading-5 text-muted-foreground @lg/page:col-span-1",
          marked && "col-start-2"
        )}
      >
        <WaitingDot waiting={waiting} />
        <span className="min-w-0 truncate">{line}</span>
      </span>
    </Link>
  )
})

/** A page of the Library's own column, titled as Home and a Space are. */
export function LibraryColumn({
  title,
  mark,
  children,
}: {
  title: string
  mark?: ReactNode
  children: ReactNode
}) {
  return (
    // The same column as a Doc opened beside the panel, so nothing shifts.
    <div className="@container/page mx-auto max-w-3xl space-y-9 px-6 py-8 sm:px-8 md:px-12 lg:py-10">
      <header className="flex min-w-0 items-center gap-3">
        {mark}
        <h1 className="min-w-0 truncate font-display text-[1.65rem] leading-tight font-semibold tracking-tight text-foreground sm:text-[2rem]">
          {title}
        </h1>
      </header>
      {children}
    </div>
  )
}

const SECTION_TITLE = "mb-2.5 text-sm font-semibold text-foreground"

/** Pending changes the Library's Home shows before the rest. */
const PENDING_ROWS = 3
/** Skills saved lately, on the Library's Home. */
export const RECENT_ROWS = 6

/**
 * Where the Library opens: a way to add a skill, what is pending across
 * every library, and the skills saved lately.
 */
export function LibraryHome({
  pending,
  recent,
  skills,
  onPick,
  children,
}: {
  pending: LibraryEntry[]
  recent: LibraryEntry[]
  skills: LibraryEntry[]
  onPick: (doc: DocChoice) => void
  /** What follows, where the panel isn't beside it. */
  children?: ReactNode
}) {
  const more = pending.length - PENDING_ROWS
  return (
    <LibraryColumn title="Library">
      <section aria-labelledby="library-add">
        <h2 id="library-add" className={SECTION_TITLE}>
          Add
        </h2>
        <DocPicker
          skills={skills}
          shown={3}
          listClassName="-mx-2.5"
          onPick={onPick}
        />
      </section>
      {pending.length > 0 && (
        <section aria-labelledby="library-pending">
          <h2 id="library-pending" className={SECTION_TITLE}>
            Pending
          </h2>
          <div className="-mx-2.5">
            {pending.slice(0, PENDING_ROWS).map((entry) => (
              <SkillRow key={entry.id} entry={entry} marked />
            ))}
            {more > 0 && (
              <Link
                to="/library/$"
                params={{ _splat: "pending" satisfies View }}
                className="ml-[3.5rem] flex h-8 w-fit items-center text-[0.8125rem] text-muted-foreground hover:text-foreground"
              >
                {more} More
              </Link>
            )}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section aria-labelledby="library-recent">
          <h2 id="library-recent" className={SECTION_TITLE}>
            Recent
          </h2>
          <div className="-mx-2.5">
            {recent.map((entry) => (
              <SkillRow key={entry.id} entry={entry} marked />
            ))}
          </div>
        </section>
      )}
      {children}
    </LibraryColumn>
  )
}
