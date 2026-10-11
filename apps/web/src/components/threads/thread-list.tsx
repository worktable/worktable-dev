import { memo } from "react"
import { Link } from "@tanstack/react-router"
import {
  CircleAlertIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  PlusIcon,
  RotateCwIcon,
  UserRoundIcon,
  UsersRoundIcon,
} from "lucide-react"
import type { ThreadLocation, ThreadListItem } from "@worktable/types"
import { Avatar, AvatarFallback } from "@worktable/ui/components/avatar"
import { Button } from "@worktable/ui/components/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@worktable/ui/components/empty"
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
} from "@worktable/ui/components/item"
import { Skeleton } from "@worktable/ui/components/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"

import { useScrollFade } from "@/hooks/use-scroll-fade"
import { RelativeTime } from "@/lib/time"
import { deliveryPresentation } from "@/lib/thread-presentation"
import { ThreadParticipantAvatar } from "./thread-participant-avatar"

/** Where a thread opens: the workspace list (keeping its filter) or a Space's. */
export type ThreadLinkTarget =
  | {
      to: "/threads/$"
      params: { _splat: string }
      search: { location: "all" | "worktable" | "space"; spaceId?: string }
    }
  | {
      to: "/spaces/$spaceId/threads/$"
      params: { spaceId: string; _splat: string }
    }

export type ThreadLink = (
  location: ThreadLocation,
  threadId: string
) => ThreadLinkTarget

interface ThreadListProps {
  threads: ThreadListItem[]
  activeThreadId: string
  activeLocation: ThreadLocation
  loading: boolean
  error: boolean
  showLocations: boolean
  locationLabel: (location: ThreadLocation) => string
  threadLink: ThreadLink
  onNew: () => void
  onRetry: () => void
}

function sameLocation(left: ThreadLocation, right: ThreadLocation): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "worktable" ||
      (right.kind === "space" && left.spaceId === right.spaceId))
  )
}

export function ThreadList({
  threads,
  activeThreadId,
  activeLocation,
  loading,
  error,
  showLocations,
  locationLabel,
  threadLink,
  onNew,
  onRetry,
}: ThreadListProps) {
  const scrollRef = useScrollFade<HTMLDivElement>()

  return (
    <div
      ref={scrollRef}
      className="scroll-fade min-h-0 flex-1 overflow-y-auto px-3 pb-5"
    >
      {loading ? (
        <ThreadListSkeleton />
      ) : error ? (
        <Empty className="min-h-72">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleAlertIcon />
            </EmptyMedia>
            <EmptyTitle>Could not load threads</EmptyTitle>
            <EmptyDescription>
              Check the connection and try again.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </EmptyContent>
        </Empty>
      ) : threads.length > 0 ? (
        <TooltipProvider delay={350}>
          <nav aria-label="Threads">
            <ItemGroup className="gap-1">
              {threads.map((thread) => (
                <div
                  role="listitem"
                  key={`${thread.location.kind === "space" ? thread.location.spaceId : "worktable"}:${thread.id}`}
                >
                  <ThreadListRow
                    thread={thread}
                    active={
                      thread.id === activeThreadId &&
                      sameLocation(thread.location, activeLocation)
                    }
                    location={
                      showLocations ? locationLabel(thread.location) : null
                    }
                    threadLink={threadLink}
                  />
                </div>
              ))}
            </ItemGroup>
          </nav>
        </TooltipProvider>
      ) : (
        <Empty className="min-h-72">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageCircleIcon />
            </EmptyMedia>
            <EmptyTitle>No threads yet</EmptyTitle>
            <EmptyDescription>
              Start a durable conversation with a connected participant.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              size="sm"
              aria-label="New thread"
              title="New thread"
              onClick={onNew}
            >
              <PlusIcon />
              Thread
            </Button>
          </EmptyContent>
        </Empty>
      )}
    </div>
  )
}

function ThreadListSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-2" aria-label="Loading threads">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 px-2 py-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** A link to the thread, so hovering it preloads the thread. */
function threadLinkElement(target: ThreadLinkTarget, active: boolean) {
  const current = active ? ("page" as const) : undefined
  return target.to === "/threads/$" ? (
    <Link
      to={target.to}
      params={target.params}
      search={target.search}
      aria-current={current}
    />
  ) : (
    <Link to={target.to} params={target.params} aria-current={current} />
  )
}

// Memoized: the view re-renders on every keystroke in the composer.
const ThreadListRow = memo(function ThreadListRow({
  thread,
  active,
  location,
  threadLink,
}: {
  thread: ThreadListItem
  active: boolean
  location: string | null
  threadLink: ThreadLink
}) {
  const showLocation = location !== null

  return (
    <Item
      variant={active ? "muted" : "default"}
      className="flex-nowrap gap-3 rounded-xl px-3 py-3 hover:bg-muted/60 [a]:hover:bg-muted/60"
      render={threadLinkElement(threadLink(thread.location, thread.id), active)}
    >
      <ItemMedia>
        <ThreadAvatar thread={thread} />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {thread.title}
          </span>
          <span className="w-14 shrink-0 text-end text-[11px] text-muted-foreground tabular-nums">
            <RelativeTime iso={thread.updatedAt} />
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {showLocation ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="max-w-24 shrink-0 truncate font-medium" />
                }
              >
                {location}
              </TooltipTrigger>
              <TooltipContent>{location}</TooltipContent>
            </Tooltip>
          ) : null}
          {showLocation ? <span aria-hidden="true">·</span> : null}
          <span className="min-w-0 flex-1 truncate text-muted-foreground/80">
            {thread.lastMessage.excerpt || "No readable text"}
          </span>
          <ThreadListActivity thread={thread} />
        </div>
      </ItemContent>
    </Item>
  )
})

function ThreadAvatar({ thread }: { thread: ThreadListItem }) {
  const agents = thread.members.filter((member) => member.kind === "agent")
  const nonAgents = thread.members.filter((member) => member.kind !== "agent")
  const participant =
    agents.length === 1
      ? agents[0]
      : nonAgents.length === 1
        ? nonAgents[0]
        : undefined
  const label = participant
    ? participant.name
    : thread.members.map((entry) => entry.name).join(", ")

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        {participant ? (
          <ThreadParticipantAvatar
            participant={participant}
            className="size-9"
          />
        ) : (
          <Avatar className="size-9" aria-label={label}>
            <AvatarFallback>
              <UsersRoundIcon className="size-4" />
            </AvatarFallback>
          </Avatar>
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ThreadListActivity({ thread }: { thread: ThreadListItem }) {
  const activity = thread.activity
  if (!activity || activity.state === "replied") {
    return <span className="size-5 shrink-0" aria-hidden="true" />
  }
  const identity = thread.identities.find(
    (candidate) => candidate.id === activity.identityId
  )
  const member = thread.members.find(
    (candidate) => candidate.id === activity.participantId
  )
  if (member?.kind !== "agent") {
    return <span className="size-5 shrink-0" aria-hidden="true" />
  }
  const name = identity?.name ?? member.name
  const presentation = deliveryPresentation(activity, name)
  if (!presentation.visible) {
    return <span className="size-5 shrink-0" aria-hidden="true" />
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={
              presentation.failed
                ? "flex size-5 shrink-0 items-center justify-center text-destructive"
                : "flex size-5 shrink-0 items-center justify-center text-muted-foreground"
            }
            aria-label={presentation.label}
          />
        }
      >
        {presentation.failed ? (
          <CircleAlertIcon className="size-3.5" aria-hidden="true" />
        ) : activity.state === "queued" && activity.attempts > 0 ? (
          <RotateCwIcon className="size-3.5" aria-hidden="true" />
        ) : activity.state === "queued" ? (
          <UserRoundIcon className="size-3.5" aria-hidden="true" />
        ) : (
          <LoaderCircleIcon
            className="size-3.5 motion-safe:animate-spin"
            aria-hidden="true"
          />
        )}
      </TooltipTrigger>
      <TooltipContent>{presentation.label}</TooltipContent>
    </Tooltip>
  )
}
