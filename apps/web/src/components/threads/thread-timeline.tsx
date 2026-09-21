import {
  Children,
  cloneElement,
  isValidElement,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import Markdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
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

import { useScrollFadeX } from "@/hooks/use-scroll-fade-x"
import { externalLinkProps, worktableLinkOrigins } from "@/lib/external-links"
import { BASE_URL } from "@/lib/http"
import { renderThreadLinkHref } from "@/lib/thread-links"
import { threadMentionSegments } from "@/lib/thread-mentions"
import {
  beginsLocalCalendarDate,
  conversationIdentityDescription,
  deliveryPresentation,
  isCurrentAssignmentActivity,
  resolveMessageAuthor,
  resolveReplyTarget,
  threadExcerpt,
  visibleNonterminalActivityKeys,
  type ConversationIdentityOption,
} from "@/lib/thread-presentation"
import { ThreadParticipantAvatar } from "./thread-participant-avatar"

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

export function ThreadTimeline({
  location,
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

  return (
    <TooltipProvider delay={600}>
      <MessageScrollerProvider
        autoScroll
        defaultScrollPosition="last-anchor"
        scrollPreviousItemPeek={0}
      >
        <MessageScroller>
          <MessageScrollerViewport
            aria-label="Thread conversation"
            fade="bottom"
            className="focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-inset"
          >
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-0 px-4 py-5 sm:px-6 sm:py-7">
              {hasOlder && onLoadOlder ? (
                <MessageScrollerItem className="pb-5 text-center">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={loadingOlder}
                    onClick={onLoadOlder}
                  >
                    {loadingOlder ? <Spinner decorative /> : null}
                    Load earlier messages
                  </Button>
                </MessageScrollerItem>
              ) : null}
              {messages.flatMap((message, index) => {
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
                const messageActivities =
                  activityByMessage.get(message.id) ?? []
                const visibleActivities = messageActivities.filter(
                  (activity) => {
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
                  }
                )
                const rows: ReactNode[] = []
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
                      location={location}
                      message={message}
                      messages={messages}
                      members={members}
                      identities={identities}
                      targetMembers={targetMembers}
                      targetIdentities={targetIdentities}
                      viewerMemberId={viewerMemberId}
                      viewerIdentityId={viewerIdentityId}
                      implicitResponseIdentityId={implicitResponseIdentityId}
                      activities={visibleActivities}
                      groupedWithPrevious={groupedWithPrevious}
                      onReply={onReply}
                      onRespond={onRespond}
                      onAssign={onAssign}
                      onLoadReplyTarget={onLoadReplyTarget}
                    />
                  </MessageScrollerItem>
                )
                return rows
              })}
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
      </MessageScrollerProvider>
    </TooltipProvider>
  )
}

function ThreadMessageRow({
  location,
  message,
  messages,
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
  location: ThreadLocation
  message: ThreadMessage
  messages: ThreadMessage[]
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
  const replyTarget = resolveReplyTarget(messages, message.inReplyTo)
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
  const mentionNames = [...new Set(identities.map((identity) => identity.name))]
  const hasOpenAssignment = message.responseRequest?.status === "open"

  return (
    <Message align={own ? "end" : "start"}>
      {!own ? (
        <MessageAvatar
          aria-hidden={groupedWithPrevious || undefined}
          className={cn(
            "w-7 min-w-7 self-start overflow-visible bg-transparent group-has-data-[slot=message-footer]/message:translate-y-0",
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
                <span className="truncate font-medium text-foreground">
                  {authorLabel}
                </span>
              )}
              <MessageTime iso={message.createdAt} />
            </span>
          ) : (
            <>
              <span className="truncate font-medium text-foreground">
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
            <ThreadMarkdown
              location={location}
              body={message.body}
              mentionNames={mentionNames}
            />
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
}

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
  const { scrollToMessage } = useMessageScroller()
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
              scrollToMessage(targetId, {
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
  const { scrollToMessage } = useMessageScroller()
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
              scrollToMessage(targetId, {
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

function ThreadMarkdown({
  location,
  body,
  mentionNames,
}: {
  location: ThreadLocation
  body: string
  mentionNames: string[]
}) {
  const worktableOrigins = useMemo(() => {
    if (typeof window === "undefined") return []
    return worktableLinkOrigins(window.location.origin, BASE_URL)
  }, [])

  return (
    <div className="typeset typeset-thread">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={defaultUrlTransform}
        components={{
          p: ({ children, ...props }) => (
            <p {...props}>
              {highlightThreadMentionChildren(children, mentionNames)}
            </p>
          ),
          li: ({ children, ...props }) => (
            <li {...props}>
              {highlightThreadMentionChildren(children, mentionNames)}
            </li>
          ),
          a: ({ href = "", children, ...props }) => {
            const renderedHref = renderThreadLinkHref(
              location,
              href,
              worktableOrigins
            )
            return renderedHref ? (
              <a
                {...props}
                href={renderedHref}
                {...externalLinkProps(renderedHref, worktableOrigins)}
              >
                {children}
              </a>
            ) : (
              <span title="This Space-relative link has no Worktable location">
                {children}
              </span>
            )
          },
          pre: ({ children }) => <ThreadCodeBlock>{children}</ThreadCodeBlock>,
          table: ({ children }) => <ThreadTable>{children}</ThreadTable>,
        }}
      >
        {body}
      </Markdown>
    </div>
  )
}

function highlightThreadMentionChildren(
  children: ReactNode,
  names: string[]
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return threadMentionSegments(child, names).map((segment, index) => (
        <span
          key={`${index}:${segment.text}`}
          className={
            segment.mention
              ? "rounded-sm bg-primary/10 px-0.5 text-primary-text"
              : undefined
          }
        >
          {segment.text}
        </span>
      ))
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) return child
    if (
      typeof child.type === "string" &&
      (child.type === "a" || child.type === "code" || child.type === "pre")
    ) {
      return child
    }
    if (child.props.children === undefined) return child
    return cloneElement(
      child,
      undefined,
      highlightThreadMentionChildren(child.props.children, names)
    )
  })
}

function ThreadCodeBlock({ children }: { children: ReactNode }) {
  const fadeRef = useScrollFadeX<HTMLPreElement>()
  return (
    <pre ref={fadeRef} className="scroll-fade-x overflow-x-auto">
      {children}
    </pre>
  )
}

function ThreadTable({ children }: { children: ReactNode }) {
  const fadeRef = useScrollFadeX<HTMLDivElement>()
  return (
    <div ref={fadeRef} className="typeset-scroll scroll-fade-x overflow-x-auto">
      <table>{children}</table>
    </div>
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
