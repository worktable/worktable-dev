import {
  CircleAlertIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  PlusIcon,
  RotateCwIcon,
  UserRoundIcon,
  UsersRoundIcon,
} from "lucide-react"
import type { ThreadLocation, ThreadSummary } from "@worktable/types"
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
import { deliveryPresentation, threadExcerpt } from "@/lib/thread-presentation"
import { ThreadParticipantAvatar } from "./thread-participant-avatar"

interface ThreadListProps {
  threads: ThreadSummary[]
  activeThreadId: string
  activeLocation: ThreadLocation
  loading: boolean
  error: boolean
  showLocations: boolean
  locationLabel: (location: ThreadLocation) => string
  onNavigate: (location: ThreadLocation, threadId: string) => void
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
  onNavigate,
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
                    showLocation={showLocations}
                    locationLabel={locationLabel}
                    onNavigate={onNavigate}
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

function ThreadListRow({
  thread,
  active,
  showLocation,
  locationLabel,
  onNavigate,
}: {
  thread: ThreadSummary
  active: boolean
  showLocation: boolean
  locationLabel: (location: ThreadLocation) => string
  onNavigate: (location: ThreadLocation, threadId: string) => void
}) {
  const location = locationLabel(thread.location)

  return (
    <Item
      variant={active ? "muted" : "default"}
      className="flex-nowrap gap-3 rounded-xl px-3 py-3 hover:bg-muted/60"
      render={
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          onClick={() => onNavigate(thread.location, thread.id)}
        />
      }
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
            {threadExcerpt(thread.lastMessage.body, 140) || "No readable text"}
          </span>
          <ThreadListActivity thread={thread} />
        </div>
      </ItemContent>
    </Item>
  )
}

function ThreadAvatar({ thread }: { thread: ThreadSummary }) {
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

function ThreadListActivity({ thread }: { thread: ThreadSummary }) {
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
