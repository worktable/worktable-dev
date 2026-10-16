import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  ArrowDownIcon,
  CircleAlertIcon,
  CornerUpLeftIcon,
  RotateCwIcon,
  UserRoundIcon,
  UserRoundPlusIcon,
} from "lucide-react"
import type {
  ConversationIdentity,
  ParticipantRef,
  ThreadActivity,
  ThreadLocation,
  ThreadMember,
  ThreadMessage,
} from "@worktable/types"
import { markdownPlainText } from "@worktable/types"
import { Bubble, BubbleContent } from "@worktable/ui/components/bubble"
import { Button } from "@worktable/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from "@worktable/ui/components/marker"
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@worktable/ui/components/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@worktable/ui/components/message-scroller"
import { Spinner } from "@worktable/ui/components/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"
import { cn } from "@worktable/ui/lib/utils"

import { useStableCallback } from "@/hooks/use-stable-callback"
import {
  beginsLocalCalendarDate,
  conversationIdentityDescription,
  deliveryPresentation,
  isCurrentAssignmentActivity,
  resolveMessageAuthor,
  threadExcerpt,
  visibleNonterminalActivityKeys,
  type ConversationIdentityOption,
} from "@/lib/thread-presentation"
import { ThreadMarkdown, ThreadMarkdownProvider } from "./thread-markdown"
import { ThreadParticipantAvatar } from "./thread-participant-avatar"

const NO_ACTIVITIES: ThreadActivity[] = []

type ScrollToMessageOptions = Parameters<
  ReturnType<typeof useMessageScroller>["scrollToMessage"]
>[1]

/** Scrolls to a message, rendering it first when it is not rendered yet. */
const JumpToMessageContext = createContext<
  (messageId: string, options?: ScrollToMessageOptions) => void
>(() => {})

interface ThreadTimelineProps {
  location: ThreadLocation
  messages: ThreadMessage[]
  members: ThreadMember[]
  identities: ConversationIdentity[]
  targetMembers: ParticipantRef[]
  targetIdentities: ConversationIdentityOption[]
  activities: ThreadActivity[]
  viewerMemberId: string
  viewerIdentityId?: string
  implicitResponseIdentityId?: string
  onReply: (messageId: string) => void
  onRespond: (messageId: string) => void
  onAssign: (messageId: string, identityId: string | null) => void
  hasOlder?: boolean
  loadingOlder?: boolean
  onLoadOlder?: () => void
  onLoadReplyTarget?: (messageId: string) => Promise<void>
}

export function ThreadTimeline(props: ThreadTimelineProps) {
  // Links in messages resolve against the thread's location and mentions of
  // these names are highlighted; stable values keep them from re-rendering.
  const spaceId =
    props.location.kind === "space" ? props.location.spaceId : undefined
  const markdownLocation = useMemo<ThreadLocation>(
    () =>
      spaceId === undefined
        ? { kind: "worktable" }
        : { kind: "space", spaceId },
    [spaceId]
  )
  const mentionNames = useMemo(
    () => [...new Set(props.identities.map((identity) => identity.name))],
    [props.identities]
  )

  return (
    <TooltipProvider delay={600}>
      <ThreadMarkdownProvider
        location={markdownLocation}
        mentionNames={mentionNames}
      >
        <MessageScrollerProvider
          autoScroll
          defaultScrollPosition="last-anchor"
          scrollPreviousItemPeek={0}
        >
          <ThreadConversation {...props} />
        </MessageScrollerProvider>
      </ThreadMarkdownProvider>
    </TooltipProvider>
  )
}

/**
 * A thread opens at its newest messages, so it renders only enough of them
 * to fill about two screens. Earlier messages render as the reader scrolls
 * toward them or jumps to one, and then stay rendered.
 */
const OPENING_SCREENS = 2
const OPENING_MESSAGES = 10
const EARLIER_SCREENS = 1.5
const EARLIER_MESSAGES = 5
/**
 * Messages rendered above one the thread opens at or the reader jumps to,
 * so there is always something to scroll up into.
 */
const CONTEXT_MESSAGES = 5

/**
 * A low estimate of a message's rendered height, so a range of messages
 * fills at least the screens it is meant to.
 */
function estimatedMessageHeight(message: ThreadMessage): number {
  let lines = 0
  for (const line of message.body.split("\n")) {
    lines += Math.max(1, Math.ceil(line.length / 100))
  }
  return 56 + 22 * lines
}

/** The first of the messages before `end` that fill `screens`. */
function startFilling(
  messages: ThreadMessage[],
  end: number,
  screens: number,
  minimum: number
): number {
  const height =
    (typeof window === "undefined" ? 900 : window.innerHeight) * screens
  let start = end
  let total = 0
  while (start > 0 && (total < height || end - start < minimum)) {
    start -= 1
    total += estimatedMessageHeight(messages[start]!)
  }
  return start
}

function openingStart(messages: ThreadMessage[]): number {
  let start = startFilling(
    messages,
    messages.length,
    OPENING_SCREENS,
    OPENING_MESSAGES
  )
  // The thread opens at its last message that asks for a reply when the
  // messages after it fill more than the screen, so render it and some
  // context above it.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.responseRequest !== undefined) {
      start = Math.min(start, Math.max(0, index - CONTEXT_MESSAGES))
      break
    }
  }
  return start
}

function ThreadConversation({
  messages,
  members,
  identities,
  targetMembers,
  targetIdentities,
  activities,
  viewerMemberId,
  viewerIdentityId,
  implicitResponseIdentityId,
  onReply,
  onRespond,
  onAssign,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onLoadReplyTarget,
}: ThreadTimelineProps) {
  const { scrollToMessage } = useMessageScroller()
  // The first rendered message, by id so loading earlier pages or receiving
  // new messages keeps it; null renders every message.
  const [renderFrom, setRenderFrom] = useState<string | null>(() => {
    const start = openingStart(messages)
    return start > 0 ? messages[start]!.id : null
  })
  const firstRendered =
    renderFrom === null
      ? 0
      : Math.max(
          0,
          messages.findIndex((message) => message.id === renderFrom)
        )
  const renderFromIndex = (index: number) =>
    setRenderFrom(index > 0 ? messages[index]!.id : null)

  const viewportRef = useRef<HTMLDivElement>(null)
  const showingEarlier = useRef(false)
  const pendingJump = useRef<{
    messageId: string
    options?: ScrollToMessageOptions
  } | null>(null)

  const showEarlierNearTop = useStableCallback(() => {
    const viewport = viewportRef.current
    if (!viewport || firstRendered === 0 || showingEarlier.current) return
    if (viewport.scrollTop > viewport.clientHeight) return
    showingEarlier.current = true
    renderFromIndex(
      startFilling(messages, firstRendered, EARLIER_SCREENS, EARLIER_MESSAGES)
    )
  })

  const jumpToMessage = useStableCallback(
    (messageId: string, options?: ScrollToMessageOptions) => {
      if (scrollToMessage(messageId, options)) return
      const index = messages.findIndex((message) => message.id === messageId)
      if (index < 0 || index >= firstRendered) return
      pendingJump.current = { messageId, options }
      renderFromIndex(Math.max(0, index - CONTEXT_MESSAGES))
    }
  )

  useLayoutEffect(() => {
    showingEarlier.current = false
    const viewport = viewportRef.current
    // Messages that do not fill the screen cannot be scrolled toward the
    // earlier ones, so render those too, before this paints. The estimates
    // make this rare.
    if (
      viewport &&
      firstRendered > 0 &&
      viewport.clientHeight > 0 &&
      viewport.scrollHeight <= viewport.clientHeight
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- measured layout
      setRenderFrom(null)
      return
    }
    const jump = pendingJump.current
    if (!jump) return
    pendingJump.current = null
    // After the scroller keeps the reading position for the added messages.
    requestAnimationFrame(() => scrollToMessage(jump.messageId, jump.options))
  }, [firstRendered, scrollToMessage])

  const activityByMessage = useMemo(() => {
    const grouped = new Map<string, ThreadActivity[]>()
    for (const activity of activities) {
      grouped.set(activity.messageId, [
        ...(grouped.get(activity.messageId) ?? []),
        activity,
      ])
    }
    return grouped
  }, [activities])
  const visibleNonterminalKeys = useMemo(
    () => visibleNonterminalActivityKeys(activities),
    [activities]
  )
  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages]
  )
  // Rows are memoized and the rendered list is too: the view re-renders on
  // every keystroke in the composer. Give them stable props.
  const reply = useStableCallback(onReply)
  const respond = useStableCallback(onRespond)
  const assign = useStableCallback(onAssign)
  const loadOlder = useStableCallback(() => onLoadOlder?.())
  const canLoadOlder = Boolean(onLoadOlder)
  const canLoadReplyTarget = Boolean(onLoadReplyTarget)
  const loadReplyTarget = useStableCallback((messageId: string) =>
    onLoadReplyTarget ? onLoadReplyTarget(messageId) : Promise.resolve()
  )

  const items = useMemo(() => {
    const rows: ReactNode[] = []
    if (firstRendered === 0 && hasOlder && canLoadOlder) {
      rows.push(
        <MessageScrollerItem key="load-older" className="pb-5 text-center">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loadingOlder}
            onClick={loadOlder}
          >
            {loadingOlder ? <Spinner decorative /> : null}
            Load earlier messages
          </Button>
        </MessageScrollerItem>
      )
    }
    for (let index = firstRendered; index < messages.length; index += 1) {
      const message = messages[index]!
      const previous = messages[index - 1]
      const startsDate = beginsLocalCalendarDate(
        message.createdAt,
        previous?.createdAt
      )
      const groupedWithPrevious = canGroupMessages(
        previous,
        message,
        startsDate
      )
      const continuesPreviousTurn = Boolean(
        previous?.responseRequest && message.inReplyTo === previous.id
      )
      const messageActivities = activityByMessage.get(message.id) ?? []
      const visibleActivities = messageActivities.filter((activity) => {
        if (!isCurrentAssignmentActivity(message, activity)) {
          return false
        }
        const recipient = members.find(
          (member) => member.id === activity.participantId
        )
        return (
          recipient?.kind === "agent" &&
          (activity.state === "failed" ||
            visibleNonterminalKeys.has(
              `${activity.messageId}:${activity.identityId ?? activity.participantId}`
            ))
        )
      })
      if (startsDate) {
        rows.push(
          <MessageScrollerItem
            key={`date:${message.id}`}
            className={index === 0 ? "pb-5" : "mt-8 pb-5"}
          >
            <Marker variant="separator" className="text-xs">
              <MarkerContent>
                {formatThreadDate(message.createdAt)}
              </MarkerContent>
            </Marker>
          </MessageScrollerItem>
        )
      }
      rows.push(
        <MessageScrollerItem
          key={message.id}
          id={`thread-message-${message.id}`}
          messageId={message.id}
          scrollAnchor={message.responseRequest !== undefined}
          className={
            index === 0 || startsDate
              ? undefined
              : groupedWithPrevious
                ? "mt-1.5"
                : continuesPreviousTurn
                  ? "mt-4"
                  : "mt-8"
          }
        >
          <ThreadMessageRow
            message={message}
            replyTarget={
              message.inReplyTo
                ? messagesById.get(message.inReplyTo)
                : undefined
            }
            members={members}
            identities={identities}
            targetMembers={targetMembers}
            targetIdentities={targetIdentities}
            viewerMemberId={viewerMemberId}
            viewerIdentityId={viewerIdentityId}
            implicitResponseIdentityId={implicitResponseIdentityId}
            activities={
              visibleActivities.length > 0 ? visibleActivities : NO_ACTIVITIES
            }
            groupedWithPrevious={groupedWithPrevious}
            onReply={reply}
            onRespond={respond}
            onAssign={assign}
            onLoadReplyTarget={canLoadReplyTarget ? loadReplyTarget : undefined}
          />
        </MessageScrollerItem>
      )
    }
    return rows
  }, [
    activityByMessage,
    assign,
    canLoadOlder,
    canLoadReplyTarget,
    firstRendered,
    hasOlder,
    identities,
    implicitResponseIdentityId,
    loadOlder,
    loadReplyTarget,
    loadingOlder,
    members,
    messages,
    messagesById,
    reply,
    respond,
    targetIdentities,
    targetMembers,
    viewerIdentityId,
    viewerMemberId,
    visibleNonterminalKeys,
  ])

  return (
    <JumpToMessageContext.Provider value={jumpToMessage}>
      <MessageScroller>
        <MessageScrollerViewport
          ref={viewportRef}
          aria-label="Thread conversation"
          fade="bottom"
          className="focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-inset"
          onScroll={showEarlierNearTop}
        >
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-0 px-4 py-5 sm:px-6 sm:py-7">
            {items}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <Tooltip>
          <TooltipTrigger
            render={
              <MessageScrollerButton
                direction="end"
                size="icon-lg"
                variant="ghost"
                className="size-11 rounded-full bg-popover p-0 shadow-[var(--overlay-floating-shadow)]"
                aria-label="Jump to latest"
              />
            }
          >
            <ArrowDownIcon />
          </TooltipTrigger>
          <TooltipContent>Jump to latest</TooltipContent>
        </Tooltip>
      </MessageScroller>
    </JumpToMessageContext.Provider>
  )
}

const ThreadMessageRow = memo(function ThreadMessageRow({
  message,
  replyTarget,
  members,
  identities,
  targetMembers,
  targetIdentities,
  viewerMemberId,
  viewerIdentityId,
  implicitResponseIdentityId,
  activities,
  groupedWithPrevious,
  onReply,
  onRespond,
  onAssign,
  onLoadReplyTarget,
}: {
  message: ThreadMessage
  replyTarget: ThreadMessage | undefined
  members: ThreadMember[]
  identities: ConversationIdentity[]
  targetMembers: ParticipantRef[]
  targetIdentities: ConversationIdentityOption[]
  viewerMemberId: string
  viewerIdentityId?: string
  implicitResponseIdentityId?: string
  activities: ThreadActivity[]
  groupedWithPrevious: boolean
  onReply: (messageId: string) => void
  onRespond: (messageId: string) => void
  onAssign: (messageId: string, identityId: string | null) => void
  onLoadReplyTarget?: (messageId: string) => Promise<void>
}) {
  const own = message.authorMemberId === viewerMemberId
  const author = resolveMessageAuthor(members, identities, message)
  const authorIdentity = identities.find(
    (identity) => identity.id === message.authorIdentityId
  )
  const authorLabel =
    own && authorIdentity?.default
      ? "You"
      : (author?.name ?? "Unknown participant")
  const hideOwnDefaultAuthorLabel = own && authorIdentity?.default === true
  const replyAuthor = replyTarget
    ? identities.find(
        (identity) => identity.id === replyTarget.authorIdentityId
      )
    : undefined
  const replyAuthorName =
    replyTarget?.authorMemberId === viewerMemberId
      ? replyAuthor?.default
        ? "You"
        : replyAuthor?.name
      : replyAuthor?.name
  const responseIdentityId =
    message.responseRequest?.status === "open" &&
    message.responseRequest.identityId === viewerIdentityId
      ? message.responseRequest.identityId
      : undefined
  const canRespond = responseIdentityId !== undefined
  const requestedNames = (() => {
    const request = message.responseRequest
    if (request?.status !== "open") return []
    const identity = identities.find(
      (candidate) => candidate.id === request.identityId
    )
    return identity ? [identity.name] : []
  })()
  const directAgentAssignmentIsImplicit =
    implicitResponseIdentityId !== undefined &&
    message.responseRequest?.status === "open" &&
    message.responseRequest.identityId === implicitResponseIdentityId
  const visibleActivities = activities.filter(
    (activity) =>
      !(
        directAgentAssignmentIsImplicit &&
        activity.state === "queued" &&
        activity.attempts === 0
      )
  )
  const showNamedAssignment =
    !directAgentAssignmentIsImplicit &&
    requestedNames.length > 0 &&
    visibleActivities.length === 0
  const hasStatus =
    canRespond || showNamedAssignment || visibleActivities.length > 0
  const assignableIdentities = targetIdentities.filter(
    (identity) => identity.id !== message.authorIdentityId
  )
  const hasOpenAssignment = message.responseRequest?.status === "open"

  return (
    <Message align={own ? "end" : "start"}>
      {!own ? (
        <MessageAvatar
          aria-hidden={groupedWithPrevious || undefined}
          className={cn(
            "h-8 w-7 min-w-7 self-start overflow-visible bg-transparent group-has-data-[slot=message-footer]/message:translate-y-0",
            groupedWithPrevious && "invisible"
          )}
        >
          <ThreadParticipantAvatar participant={author} className="size-7" />
        </MessageAvatar>
      ) : null}
      <MessageContent
        className={cn("gap-0", own ? "max-w-[88%] sm:max-w-[80%]" : "w-full")}
      >
        <MessageHeader
          className={
            own
              ? "min-h-8 justify-end gap-2 overflow-visible"
              : "min-h-8 justify-start gap-2 overflow-visible px-0"
          }
        >
          {own ? (
            <span className="relative flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "absolute end-full top-1/2 flex -translate-y-1/2 items-center"
                )}
              >
                <ThreadMessageAction
                  canRespond={canRespond}
                  responseIdentityId={responseIdentityId}
                  messageId={message.id}
                  revealOnMessageHover
                  onReply={onReply}
                  onRespond={onRespond}
                />
                <ThreadMessageAssignment
                  messageId={message.id}
                  identities={assignableIdentities}
                  members={targetMembers}
                  value={message.responseRequest?.identityId}
                  disabled={message.responseRequest?.status === "responded"}
                  revealOnMessageHover={!hasOpenAssignment}
                  onAssign={onAssign}
                />
              </span>
              {hideOwnDefaultAuthorLabel ? (
                <span className="sr-only">You</span>
              ) : (
                <span className="truncate font-semibold text-foreground">
                  {authorLabel}
                </span>
              )}
              <MessageTime iso={message.createdAt} />
            </span>
          ) : (
            <>
              <span className="truncate font-semibold text-foreground">
                {authorLabel}
              </span>
              <MessageTime iso={message.createdAt} />
              <ThreadMessageAction
                canRespond={canRespond}
                responseIdentityId={responseIdentityId}
                messageId={message.id}
                onReply={onReply}
                onRespond={onRespond}
              />
            </>
          )}
        </MessageHeader>
        <Bubble
          align={own ? "end" : "start"}
          variant={own ? "secondary" : "ghost"}
          className={own ? "max-w-full" : "w-full max-w-full"}
        >
          <BubbleContent className={own ? "px-3.5 py-2.5" : "w-full"}>
            {message.inReplyTo ? (
              <ReplyContext
                targetId={message.inReplyTo}
                target={replyTarget}
                authorName={replyAuthorName}
                own={own}
                onLoadTarget={onLoadReplyTarget}
              />
            ) : null}
            <ThreadMarkdown messageId={message.id} body={message.body} />
          </BubbleContent>
        </Bubble>
        {hasStatus ? (
          <MessageFooter
            className={cn(
              "mt-2.5 w-fit flex-col items-start gap-1 px-0",
              own && "items-end text-end"
            )}
          >
            <div
              className={cn(
                "flex min-w-0 flex-col gap-1 text-xs text-muted-foreground",
                own && "items-end"
              )}
            >
              {canRespond ? (
                <ThreadMessageStatus
                  kind="assigned"
                  label="Assigned to you"
                  emphasized
                />
              ) : showNamedAssignment ? (
                <ThreadMessageStatus
                  kind="assigned"
                  label={`Assigned to ${formatNames(requestedNames)}`}
                />
              ) : null}
              {visibleActivities.map((activity) => (
                <ThreadActivityMarker
                  key={`${activity.messageId}:${activity.identityId ?? activity.participantId}`}
                  activity={activity}
                  participantName={
                    identities.find(
                      (identity) => identity.id === activity.identityId
                    )?.name ??
                    members.find(
                      (member) => member.id === activity.participantId
                    )?.name ??
                    "The recipient"
                  }
                />
              ))}
            </div>
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  )
})

function ThreadMessageAssignment({
  messageId,
  identities,
  members,
  value,
  disabled,
  revealOnMessageHover = true,
  onAssign,
}: {
  messageId: string
  identities: ConversationIdentityOption[]
  members: ParticipantRef[]
  value?: string
  disabled: boolean
  revealOnMessageHover?: boolean
  onAssign: (messageId: string, identityId: string | null) => void
}) {
  const selected = identities.find((identity) => identity.id === value)
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className={cn(
              "rounded-full transition-opacity",
              selected
                ? "text-primary-text"
                : revealOnMessageHover
                  ? "opacity-0 group-focus-within/message:opacity-100 group-hover/message:opacity-100"
                  : "opacity-100"
            )}
            aria-label={selected ? `Assigned to ${selected.name}` : "Assign"}
          />
        }
      >
        <UserRoundPlusIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Assign</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value ?? "none"}
            onValueChange={(identityId) => {
              onAssign(messageId, identityId === "none" ? null : identityId)
              setOpen(false)
            }}
          >
            <DropdownMenuRadioItem value="none">No one</DropdownMenuRadioItem>
            {identities.map((identity) => {
              const description = conversationIdentityDescription(
                identity,
                members,
                identities
              )
              return (
                <DropdownMenuRadioItem key={identity.id} value={identity.id}>
                  <span className="min-w-0">
                    <span className="block truncate">{identity.name}</span>
                    {description ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {description}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ThreadMessageAction({
  canRespond,
  responseIdentityId,
  messageId,
  revealOnMessageHover = true,
  onReply,
  onRespond,
}: {
  canRespond: boolean
  responseIdentityId?: string
  messageId: string
  revealOnMessageHover?: boolean
  onReply: (messageId: string) => void
  onRespond: (messageId: string) => void
}) {
  const label = canRespond ? "Respond" : "Reply"
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className={cn(
              "rounded-full opacity-100 transition-opacity",
              canRespond
                ? "text-primary-text hover:text-primary-text"
                : revealOnMessageHover
                  ? "sm:opacity-0 sm:group-focus-within/message:opacity-100 sm:group-hover/message:opacity-100"
                  : "opacity-100"
            )}
            aria-label={label}
            onClick={() => {
              if (canRespond && responseIdentityId) {
                onRespond(messageId)
              } else {
                onReply(messageId)
              }
            }}
          />
        }
      >
        <CornerUpLeftIcon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function canGroupMessages(
  previous: ThreadMessage | undefined,
  current: ThreadMessage,
  startsDate: boolean
): boolean {
  if (!previous || startsDate || current.inReplyTo) return false
  if (previous.authorIdentityId !== current.authorIdentityId) return false
  if (
    new Date(current.createdAt).getTime() -
      new Date(previous.createdAt).getTime() >
    5 * 60_000
  ) {
    return false
  }
  return messageAttentionKey(previous) === messageAttentionKey(current)
}

function messageAttentionKey(message: ThreadMessage): string {
  return [
    ...message.notifyIdentityIds.map((identityId) => `notify:${identityId}`),
    ...(message.responseRequest
      ? [`reply:${message.responseRequest.identityId}`]
      : []),
  ]
    .sort()
    .join("|")
}

function formatNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return new Intl.ListFormat(undefined, {
    style: "short",
    type: "conjunction",
  }).format(names)
}

function MessageTime({ iso }: { iso: string }) {
  const date = new Date(iso)
  const short = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })
  const complete = date.toLocaleString([], {
    dateStyle: "full",
    timeStyle: "long",
  })
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            dateTime={iso}
            className="shrink-0 font-normal text-muted-foreground/75 tabular-nums"
          />
        }
      >
        {short}
      </TooltipTrigger>
      <TooltipContent>{complete}</TooltipContent>
    </Tooltip>
  )
}

function ReplyContext({
  targetId,
  target,
  authorName,
  own,
  onLoadTarget,
}: {
  targetId: string
  target?: ThreadMessage
  authorName?: string
  own: boolean
  onLoadTarget?: (messageId: string) => Promise<void>
}) {
  const jumpToMessage = useContext(JumpToMessageContext)
  if (!target) {
    return (
      <button
        type="button"
        disabled={!onLoadTarget}
        className={
          own
            ? "mb-2 block w-full border-s-2 border-border ps-2.5 text-left text-xs text-muted-foreground transition-colors enabled:hover:text-foreground"
            : "mb-1.5 flex items-center gap-1.5 text-left text-xs text-muted-foreground/80 transition-colors enabled:hover:text-foreground"
        }
        onClick={() =>
          void onLoadTarget?.(targetId).then(() =>
            requestAnimationFrame(() =>
              jumpToMessage(targetId, {
                align: "center",
                behavior: "smooth",
              })
            )
          )
        }
      >
        {!own ? (
          <CornerUpLeftIcon className="size-3 shrink-0" aria-hidden="true" />
        ) : null}
        <span>Load the earlier message</span>
      </button>
    )
  }
  return (
    <ReplyContextButton
      targetId={target.id}
      fullMessage={markdownPlainText(target.body).trim() || target.body}
      authorName={authorName ?? "Earlier participant"}
      excerpt={threadExcerpt(target.body, 120)}
      own={own}
    />
  )
}

function ReplyContextButton({
  targetId,
  fullMessage,
  authorName,
  excerpt,
  own,
}: {
  targetId: string
  fullMessage: string
  authorName: string
  excerpt: string
  own: boolean
}) {
  const jumpToMessage = useContext(JumpToMessageContext)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Replying to ${authorName}: ${excerpt}`}
            className={
              own
                ? "mb-2 block w-full border-s-2 border-border ps-2.5 text-left text-xs leading-5 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                : "mb-2 block max-w-full border-s-2 border-border ps-2.5 text-left text-xs leading-5 text-muted-foreground/80 transition-colors outline-none hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            }
            onClick={() =>
              jumpToMessage(targetId, {
                align: "center",
                behavior: "smooth",
              })
            }
          />
        }
      >
        <span className="block truncate font-medium text-foreground/75">
          {authorName}
        </span>
        <span className="block truncate">{excerpt}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm text-left leading-5 whitespace-pre-wrap">
        {fullMessage}
      </TooltipContent>
    </Tooltip>
  )
}

type ThreadMessageStatusKind = "assigned" | "active" | "retrying" | "failed"

function ThreadMessageStatus({
  kind,
  label,
  live = false,
  emphasized = false,
  announce = false,
}: {
  kind: ThreadMessageStatusKind
  label: string
  live?: boolean
  emphasized?: boolean
  announce?: boolean
}) {
  return (
    <Marker
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      className={cn(
        "w-fit max-w-full gap-1.5 text-xs",
        emphasized && "text-primary-text",
        kind === "failed" && "text-destructive"
      )}
    >
      <MarkerIcon className="size-3.5">
        {kind === "failed" ? (
          <CircleAlertIcon className="size-3.5" />
        ) : kind === "retrying" ? (
          <RotateCwIcon className="size-3.5" />
        ) : kind === "assigned" ? (
          <UserRoundIcon className="size-3.5" />
        ) : (
          <Spinner decorative className="size-3.5" />
        )}
      </MarkerIcon>
      <MarkerContent className={live ? "shimmer" : undefined}>
        {label}
      </MarkerContent>
    </Marker>
  )
}

function ThreadActivityMarker({
  activity,
  participantName,
}: {
  activity: ThreadActivity
  participantName: string
}) {
  const presentation = deliveryPresentation(activity, participantName)
  if (!presentation.visible) return null

  const kind: ThreadMessageStatusKind = presentation.failed
    ? "failed"
    : activity.state !== "queued"
      ? "active"
      : activity.attempts > 0
        ? "retrying"
        : "assigned"

  return (
    <ThreadMessageStatus
      kind={kind}
      label={presentation.label}
      live={presentation.live}
      announce
    />
  )
}

function formatThreadDate(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  const key = (value: Date) =>
    `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`
  if (key(date) === key(today)) return "Today"
  if (key(date) === key(yesterday)) return "Yesterday"
  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  })
}
