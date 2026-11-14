import { Link } from "@tanstack/react-router"
import { ChevronDown } from "lucide-react"
import { useRef, useState, type ReactNode } from "react"
import type { ActivityActor, HomeRun } from "@worktable/types"
import { cn } from "@worktable/ui/lib/utils"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import { ThreadParticipantAvatar } from "@/components/identity-icons"
import { shortWhen } from "@/lib/activity-format"
import { useActorName } from "@/lib/use-actor-name"

/** A person's or agent's picture, at the size its place needs. */
export function ActorAvatar({
  actor,
  className,
}: {
  actor: ActivityActor
  className?: string
}) {
  return (
    <ThreadParticipantAvatar
      participant={{
        kind: actor.kind === "person" ? "human" : "agent",
        id: actor.id,
        name: actor.name ?? (actor.kind === "person" ? "User" : "Agent"),
      }}
      className={className}
    />
  )
}

/** A short time that says the full one when pointed at. */
export function When({
  at,
  className,
  onClick,
}: {
  at: string
  className?: string
  onClick?: () => void
}) {
  return (
    <time
      dateTime={at}
      onClick={onClick}
      title={new Date(at).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })}
      className={cn(
        "shrink-0 text-xs text-muted-foreground tabular-nums",
        className
      )}
    >
      {shortWhen(at)}
    </time>
  )
}

function RunRow({
  run,
  place,
  className,
}: {
  run: HomeRun
  /** Where the run happened: its Space on Home, its folder in a Space. */
  place: ReactNode
  className?: string
}) {
  const nameOf = useActorName()
  const [open, setOpen] = useState(false)
  const link = useRef<HTMLAnchorElement>(null)
  const [lead, ...rest] = run.docs
  if (!lead) return null
  const others = rest.length + run.more
  const more = others > 0 && (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      className="relative inline-flex h-5 shrink-0 cursor-pointer items-center gap-0.5 rounded-md text-[0.8125rem] text-muted-foreground tabular-nums outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:text-foreground"
    >
      {others} More
      <ChevronDown
        className={cn("size-3 transition-transform", open && "rotate-180")}
      />
    </button>
  )
  return (
    <li className={className}>
      {/* The title leads and the line under it stays quiet, with more room
          between rows than inside one, so each row reads as one thing. */}
      <div className="group relative grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-px rounded-xl px-2.5 py-3 transition-colors has-[a:focus-visible]:bg-surface-hover has-[a:hover]:bg-surface-hover">
        <Link
          ref={link}
          to="/spaces/$spaceId/documents/$"
          params={{ spaceId: run.spaceId, _splat: lead.path }}
          className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          aria-label={lead.title}
        />
        <ActorAvatar
          actor={run.actor}
          className="row-span-2 size-8 self-start text-xs @lg/page:self-center"
        />
        <span className="line-clamp-2 min-w-0 text-[0.9375rem] leading-6 font-medium text-foreground @lg/page:line-clamp-none @lg/page:truncate">
          {lead.title}
        </span>
        {/* Over the link so it can say its full date; a click still opens. */}
        <When
          at={run.at}
          onClick={() => link.current?.click()}
          className="relative cursor-pointer self-start pt-1 @lg/page:row-span-2"
        />
        {/* On a phone the line runs under the time, so the place fits. */}
        <div className="col-span-2 col-start-2 flex min-w-0 items-center gap-1.5 text-[0.8125rem] leading-5 text-muted-foreground @lg/page:col-span-1">
          <span className="shrink-0">
            {nameOf(run.actor)} {lead.created ? "created" : "edited"}
          </span>
          <span aria-hidden className="shrink-0 opacity-50">
            ·
          </span>
          {place}
          {more && (
            <>
              <span aria-hidden className="shrink-0 opacity-50">
                ·
              </span>
              {more}
            </>
          )}
        </div>
      </div>
      {open && others > 0 && (
        <ul className="pb-2 pl-[3.25rem]">
          {rest.map((doc) => (
            <li key={doc.path}>
              <Link
                to="/spaces/$spaceId/documents/$"
                params={{ spaceId: run.spaceId, _splat: doc.path }}
                className="group flex h-8 min-w-0 items-center gap-2.5 rounded-lg px-2 text-[0.8125rem] text-reading-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <DocumentFormatIcon
                  formatId={doc.formatId}
                  name={doc.path}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{doc.title}</span>
                <When at={doc.at} />
              </Link>
            </li>
          ))}
          {run.more > 0 && (
            <li className="flex h-8 items-center px-2 text-[0.8125rem] text-muted-foreground">
              And {run.more} more
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

/**
 * The newest work, one row per sitting: who created or edited what, where,
 * and when. A phone shows the first four; Activity has the rest.
 */
export function LatestRuns({
  runs,
  place,
}: {
  runs: HomeRun[]
  place: (run: HomeRun) => ReactNode
}) {
  return (
    <ul className="-mx-2.5">
      {runs.map((run, index) => (
        <RunRow
          key={run.id}
          run={run}
          place={place(run)}
          className={index >= 4 ? "hidden @lg/page:block" : undefined}
        />
      ))}
    </ul>
  )
}

export function LatestSkeleton() {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="h-[3.875rem] animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  )
}
