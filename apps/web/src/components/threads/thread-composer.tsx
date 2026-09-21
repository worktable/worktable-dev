import {
  useCallback,
  useId,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react"
import {
  ArrowUpIcon,
  CornerUpLeftIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@worktable/ui/components/input-group"
import { Popover, PopoverContent } from "@worktable/ui/components/popover"
import { Separator } from "@worktable/ui/components/separator"
import { Spinner } from "@worktable/ui/components/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"
import { cn } from "@worktable/ui/lib/utils"

import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useScrollFadeX } from "@/hooks/use-scroll-fade-x"
import {
  insertThreadMention,
  retainedThreadMentionIds,
  threadMentionSegments,
  threadMentionQuery,
  type ThreadMentionQuery,
  type ThreadMentionTarget,
} from "@/lib/thread-mentions"

interface ThreadComposerProps {
  ref: Ref<HTMLTextAreaElement>
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  pending: boolean
  error?: string
  disabled?: boolean
  placeholder: string
  replyContext?: {
    authorName: string
    excerpt: string
  }
  onClearReply?: () => void
  toolbarActions?: ReactNode
  mentionTargets?: ThreadMentionTarget[]
  mentionIdentityIds?: string[]
  onMentionIdentityIdsChange?: (identityIds: string[]) => void
  onMentionSelect?: (identityId: string) => void
  placement?: "docked" | "inline"
}

const composerTextClassName =
  "min-h-14 px-4 pt-3.5 pb-2 text-[0.9375rem] leading-6 md:text-[0.9375rem]"

export function ThreadComposer({
  ref,
  value,
  onChange,
  onSubmit,
  pending,
  error,
  disabled = false,
  placeholder,
  replyContext,
  onClearReply,
  toolbarActions,
  mentionTargets = [],
  mentionIdentityIds = [],
  onMentionIdentityIdsChange,
  onMentionSelect,
  placement = "docked",
}: ThreadComposerProps) {
  const errorId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionAnchorRef = useRef<HTMLSpanElement>(null)
  const mentionMirrorRef = useRef<HTMLDivElement>(null)
  const [mention, setMention] = useState<ThreadMentionQuery>()
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const textareaFadeRef = useScrollFade<HTMLTextAreaElement>()
  const toolbarRef = useScrollFadeX<HTMLDivElement>()
  const composerTextareaRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node
      textareaFadeRef(node)
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref, textareaFadeRef]
  )
  const label = pending
    ? "Sending message"
    : error
      ? "Try sending again"
      : "Send message"
  const mentionOptions = mention
    ? mentionTargets
        .filter((target) =>
          target.name
            .toLocaleLowerCase()
            .includes(mention.query.toLocaleLowerCase())
        )
        .slice(0, 6)
    : []
  const activeMentionOption =
    mentionOptions[
      Math.min(activeMentionIndex, Math.max(mentionOptions.length - 1, 0))
    ]
  const mentionListId = useId()
  const mentionedNames = mentionTargets
    .filter((target) => mentionIdentityIds.includes(target.id))
    .map((target) => target.name)

  const updateMentionQuery = (nextValue: string, cursor: number) => {
    const nextMention = threadMentionQuery(nextValue, cursor)
    setMention(nextMention)
    setActiveMentionIndex(0)
  }

  const selectMention = (target: ThreadMentionTarget) => {
    if (!mention) return
    const inserted = insertThreadMention(value, mention, target)
    onChange(inserted.value)
    onMentionIdentityIdsChange?.([
      ...new Set([...mentionIdentityIds, target.id]),
    ])
    onMentionSelect?.(target.id)
    setMention(undefined)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(inserted.cursor, inserted.cursor)
    })
  }

  return (
    <div
      className={cn(
        placement === "docked" ? "shrink-0 px-4 pb-4 sm:px-6 sm:pb-6" : "w-full"
      )}
    >
      <div className={cn(placement === "docked" && "mx-auto max-w-3xl")}>
        <InputGroup
          aria-label="Write a message"
          className="well well-interactive min-h-28 overflow-hidden rounded-[1.5rem]"
          data-disabled={disabled || undefined}
        >
          {replyContext ? (
            <InputGroupAddon
              align="block-start"
              className="items-start gap-2.5 px-4 pt-3.5 pb-0 text-xs font-normal"
            >
              <CornerUpLeftIcon
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 leading-5">
                <span className="block truncate font-medium text-foreground/80">
                  Replying to {replyContext.authorName}
                </span>
                <span className="block truncate text-muted-foreground">
                  {replyContext.excerpt}
                </span>
              </span>
              {onClearReply ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="-my-1 shrink-0 rounded-full"
                  aria-label="Remove reply"
                  onClick={onClearReply}
                >
                  <XIcon />
                </Button>
              ) : null}
            </InputGroupAddon>
          ) : null}
          <div className="relative w-full min-w-0 flex-1">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden"
            >
              <div
                ref={mentionMirrorRef}
                className={cn(
                  composerTextClassName,
                  "break-words whitespace-pre-wrap text-foreground"
                )}
              >
                <MentionOverlayText
                  value={value.slice(0, mention?.end ?? value.length)}
                  names={mentionedNames}
                />
                {mention ? (
                  <span
                    ref={mentionAnchorRef}
                    className="inline-block h-5 w-0 align-text-bottom"
                  />
                ) : null}
                {mention ? (
                  <MentionOverlayText
                    value={value.slice(mention.end)}
                    names={mentionedNames}
                  />
                ) : null}
                {"\u200b"}
              </div>
            </div>
            <InputGroupTextarea
              ref={composerTextareaRef}
              value={value}
              onChange={(event) => {
                const nextValue = event.target.value
                onChange(nextValue)
                onMentionIdentityIdsChange?.(
                  retainedThreadMentionIds(
                    nextValue,
                    mentionIdentityIds,
                    mentionTargets
                  )
                )
                updateMentionQuery(
                  nextValue,
                  event.target.selectionStart ?? nextValue.length
                )
              }}
              onClick={(event) =>
                updateMentionQuery(
                  event.currentTarget.value,
                  event.currentTarget.selectionStart ?? value.length
                )
              }
              onScroll={(event) => {
                if (!mentionMirrorRef.current) return
                mentionMirrorRef.current.style.transform = `translate(${-event.currentTarget.scrollLeft}px, ${-event.currentTarget.scrollTop}px)`
              }}
              onKeyDown={(event) => {
                if (mention && mentionOptions.length > 0) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault()
                    setActiveMentionIndex((current) =>
                      event.key === "ArrowDown"
                        ? (current + 1) % mentionOptions.length
                        : (current - 1 + mentionOptions.length) %
                          mentionOptions.length
                    )
                    return
                  }
                  if (event.key === "Enter" && activeMentionOption) {
                    event.preventDefault()
                    selectMention(activeMentionOption)
                    return
                  }
                }
                if (event.key === "Escape" && mention) {
                  event.preventDefault()
                  setMention(undefined)
                  return
                }
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault()
                  if (!pending && !disabled && value.trim()) onSubmit()
                }
              }}
              rows={1}
              maxLength={100_000}
              disabled={disabled}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={mentionOptions.length > 0}
              aria-controls={
                mentionOptions.length > 0 ? mentionListId : undefined
              }
              aria-activedescendant={
                activeMentionOption
                  ? `${mentionListId}-${activeMentionOption.id}`
                  : undefined
              }
              placeholder={placeholder}
              className={cn(
                composerTextClassName,
                "scroll-fade relative z-1 max-h-40 w-full overflow-y-auto text-transparent caret-foreground selection:bg-primary/20 selection:text-foreground placeholder:text-muted-foreground"
              )}
            />
            <Popover
              open={mentionOptions.length > 0}
              onOpenChange={(open) => {
                if (!open) setMention(undefined)
              }}
            >
              {mentionOptions.length > 0 ? (
                <PopoverContent
                  anchor={mentionAnchorRef}
                  align="start"
                  side="bottom"
                  sideOffset={4}
                  initialFocus={false}
                  finalFocus={false}
                  className="max-h-48 w-64 max-w-[calc(100vw-2rem)] gap-0 overflow-y-auto p-1"
                >
                  <div
                    id={mentionListId}
                    role="listbox"
                    aria-label="Mention someone"
                  >
                    {mentionOptions.map((target) => (
                      <button
                        key={target.id}
                        id={`${mentionListId}-${target.id}`}
                        type="button"
                        role="option"
                        aria-selected={target.id === activeMentionOption?.id}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none hover:bg-accent aria-selected:bg-accent"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => selectMention(target)}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{target.name}</span>
                          {target.description ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {target.description}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              ) : null}
            </Popover>
          </div>
          <InputGroupAddon
            align="block-end"
            className="min-h-12 justify-between gap-2 ps-1.5 pe-4 pt-0 pb-3"
          >
            <div
              ref={toolbarRef}
              className="scroll-fade-x no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            >
              {toolbarActions}
            </div>
            <TooltipProvider delay={500}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      className="shrink-0 rounded-full max-sm:size-11"
                      aria-label={label}
                      disabled={pending || disabled || !value.trim()}
                      onClick={onSubmit}
                    />
                  }
                >
                  {pending ? (
                    <Spinner decorative />
                  ) : error ? (
                    <RotateCwIcon aria-hidden="true" />
                  ) : (
                    <ArrowUpIcon aria-hidden="true" />
                  )}
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </InputGroupAddon>
        </InputGroup>
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="mt-2 px-1 text-xs leading-5 text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function MentionOverlayText({
  value,
  names,
}: {
  value: string
  names: string[]
}) {
  return threadMentionSegments(value, names).map((segment, index) => (
    <span
      key={`${index}:${segment.text}`}
      className={
        segment.mention
          ? "rounded-sm bg-primary/10 text-primary-text"
          : undefined
      }
    >
      {segment.text}
    </span>
  ))
}

export function ThreadComposerSeparator() {
  return (
    <span className="mx-1 flex h-4 shrink-0 items-stretch" aria-hidden="true">
      <Separator orientation="vertical" />
    </span>
  )
}
