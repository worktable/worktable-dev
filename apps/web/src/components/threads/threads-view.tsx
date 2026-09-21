import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  MessageCircleIcon,
  PlusIcon,
  XIcon,
} from "lucide-react"
import {
  threadBodyMentionsIdentity,
  threadLocationKey,
  type ParticipantRef,
  type ThreadLocation,
} from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@worktable/ui/components/empty"
import { Spinner } from "@worktable/ui/components/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"
import { ResizeHandle } from "@worktable/ui/components/resize-handle"
import { useResizable } from "@worktable/ui/hooks/use-resizable"
import { toast } from "@worktable/ui/components/sonner"

import { usePageMeta } from "@/hooks/use-page-meta"
import type { ThreadListScope } from "@/lib/threads-api"
import {
  useThread,
  useThreadMutations,
  useThreadParticipants,
  useThreads,
} from "@/lib/threads-queries"
import { useWorkspace } from "@/lib/queries"
import { createClientId } from "@/lib/client-id"
import {
  loadThreadDrafts,
  normalizeThreadDraftIdentities,
  onThreadDraftsCleared,
  persistThreadDrafts,
  removeThreadDraft,
  setThreadDraft,
  type ThreadDraftCollection,
} from "@/lib/thread-drafts"
import { availableParticipantSelection } from "@/lib/thread-replies"
import {
  availableConversationIdentities,
  conversationIdentityDescription,
  directAlwaysOnAgentIdentity,
  resolveReplyTarget,
  threadExcerpt,
  threadMentionRequestsResponse,
  type ConversationIdentityOption,
} from "@/lib/thread-presentation"
import {
  clearCompletedThreadDraft,
  retainThreadSubmission,
  threadDraftKey,
  type ThreadDraftState,
} from "@/lib/thread-submission"
import { NewThreadPanel } from "./new-thread-panel"
import { ThreadComposer } from "./thread-composer"
import { ThreadList } from "./thread-list"
import { ThreadParticipantAvatar } from "./thread-participant-avatar"
import { ThreadTimeline } from "./thread-timeline"

export interface ThreadsViewProps {
  listScope: ThreadListScope
  threadId: string
  selectedLocation: ThreadLocation
  createLocation: ThreadLocation
  showLocations?: boolean
  headerControl?: ReactNode
  locationControl?: ReactNode
  locationLabel: (location: ThreadLocation) => string
  onNavigateThread: (location: ThreadLocation, threadId: string) => void
  onNavigateNew: () => void
}

interface SendFailure {
  draftKey: string
  fingerprint: string
  message: string
}

type ThreadDraftIntent = Pick<
  ThreadDraftState,
  "notifyIdentityIds" | "responseIdentityId" | "replyTo" | "responseTo"
>

export function ThreadsView({ ...props }: ThreadsViewProps) {
  const workspaceQuery = useWorkspace()
  const [mobileNewOpen, setMobileNewOpen] = useState(false)

  if (!workspaceQuery.data) {
    return (
      <main className="flex h-full min-h-0 items-center justify-center bg-background">
        <Spinner />
      </main>
    )
  }

  return (
    <WorkspaceThreadsView
      key={`${workspaceQuery.data.id}:${threadLocationKey(props.selectedLocation)}:${props.threadId}`}
      {...props}
      workspaceId={workspaceQuery.data.id}
      mobileNewOpen={mobileNewOpen}
      setMobileNewOpen={setMobileNewOpen}
    />
  )
}

function WorkspaceThreadsView({
  listScope,
  threadId,
  selectedLocation,
  createLocation,
  showLocations = false,
  headerControl,
  locationControl,
  locationLabel,
  onNavigateThread,
  onNavigateNew,
  workspaceId,
  mobileNewOpen,
  setMobileNewOpen,
}: ThreadsViewProps & {
  workspaceId: string
  mobileNewOpen: boolean
  setMobileNewOpen: (open: boolean) => void
}) {
  const threadsQuery = useThreads(listScope)
  const threadQuery = useThread(selectedLocation, threadId)
  const participantsQuery = useThreadParticipants()
  const createMutations = useThreadMutations(createLocation)
  const replyMutations = useThreadMutations(selectedLocation)
  const draftLocation = threadId ? selectedLocation : createLocation
  const activeDraftKey = threadDraftKey(draftLocation, threadId)
  const [drafts, setDrafts] = useState<ThreadDraftCollection>(() =>
    loadThreadDrafts(workspaceId)
  )
  const draftsRef = useRef(drafts)
  const [sendFailure, setSendFailure] = useState<SendFailure>()
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const onNavigateNewRef = useRef(onNavigateNew)
  const { setPageMeta } = usePageMeta()
  const threadListResize = useResizable({
    edge: "right",
    defaultSize: 360,
    minSize: 280,
    maxSize: 480,
    storageKey: "worktable-thread-list-width",
  })

  useEffect(() => {
    onNavigateNewRef.current = onNavigateNew
  }, [onNavigateNew])

  useEffect(
    () =>
      onThreadDraftsCleared(workspaceId, () => {
        draftsRef.current = {}
        setDrafts({})
        setSendFailure(undefined)
      }),
    [workspaceId]
  )

  const commitDrafts = useCallback(
    (
      update: (current: ThreadDraftCollection) => ThreadDraftCollection
    ): void => {
      const next = update(draftsRef.current)
      if (next === draftsRef.current) return
      draftsRef.current = next
      setDrafts(next)
      persistThreadDrafts(workspaceId, next)
    },
    [workspaceId]
  )

  const emptyActiveDraft = useMemo<ThreadDraftState>(
    () => ({ key: activeDraftKey, value: "", updatedAt: 0 }),
    [activeDraftKey]
  )
  const activeDraft = drafts[activeDraftKey] ?? emptyActiveDraft
  const draft = activeDraft.value
  const replyTo = activeDraft.replyTo
  const responseTo = activeDraft.responseTo
  const threads = threadsQuery.data?.threads ?? []
  const participants = participantsQuery.data?.participants ?? []
  const selectedRecipient = availableParticipantSelection(
    participants,
    activeDraft.recipientId ?? ""
  )
  const thread = threadQuery.data?.thread
  const viewerMemberId = threadQuery.data?.viewerMemberId
  const threadMembers = thread?.members ?? []
  const targetMembers = useMemo<ParticipantRef[]>(
    () => [
      ...new Map(
        [...threadMembers, ...participants].map((member) => [member.id, member])
      ).values(),
    ],
    [participants, threadMembers]
  )
  const targetIdentities = useMemo<ConversationIdentityOption[]>(
    () =>
      availableConversationIdentities(thread?.identities ?? [], participants),
    [participants, thread?.identities]
  )
  const targetIdentityIds = new Set(
    targetIdentities.map((identity) => identity.id)
  )
  const normalizedActiveDraft = threadQuery.data
    ? normalizeThreadDraftIdentities(activeDraft, targetIdentityIds)
    : activeDraft
  const notifyIdentityIds = normalizedActiveDraft.notifyIdentityIds ?? []
  const responseIdentityId = normalizedActiveDraft.responseIdentityId
  const activeIdentityKey = [...targetIdentityIds].sort().join("\0")
  const otherIdentities = targetIdentities.filter(
    (identity) => identity.memberId !== viewerMemberId
  )
  const selectedResponseMention =
    typeof responseIdentityId === "string"
      ? targetIdentities.find(
          (identity) =>
            identity.id === responseIdentityId &&
            threadBodyMentionsIdentity(draft, identity.name)
        )
      : undefined
  const draftMentionIdentityIds = [
    ...new Set([
      ...notifyIdentityIds,
      ...(selectedResponseMention ? [selectedResponseMention.id] : []),
    ]),
  ]
  const directAgentResponseFor = (
    availableParticipants: typeof participants
  ) => {
    const identity = directAlwaysOnAgentIdentity(
      threadMembers,
      targetIdentities,
      availableParticipants,
      viewerMemberId
    )
    const implicit = Boolean(
      identity &&
      !draftMentionIdentityIds.some(
        (identityId) => identityId !== identity.id
      ) &&
      (responseIdentityId === undefined ||
        responseIdentityId === null ||
        responseIdentityId === identity.id)
    )
    return {
      identity,
      implicit,
      responseIdentityId:
        implicit && identity
          ? identity.id
          : responseIdentityId === null
            ? undefined
            : responseIdentityId,
    }
  }
  const directAgentResponse = directAgentResponseFor(participants)
  const directAgentIdentity = directAgentResponse.identity
  const directAgentResponseIsImplicit = directAgentResponse.implicit
  const effectiveResponseIdentityId = directAgentResponse.responseIdentityId
  const fingerprint = buildSubmissionFingerprint({
    location: draftLocation,
    threadId,
    body: draft.trim(),
    recipientId: threadId ? undefined : selectedRecipient,
    notifyIdentityIds,
    responseIdentityId: effectiveResponseIdentityId,
    inReplyTo: replyTo,
    responseTo,
  })
  const activeSendError =
    sendFailure?.draftKey === activeDraftKey &&
    sendFailure.fingerprint === fingerprint
      ? sendFailure.message
      : undefined

  useEffect(() => {
    if (!threadId || !threadQuery.data) return
    commitDrafts((current) => {
      const latest = current[activeDraftKey]
      if (!latest) return current
      const normalized = normalizeThreadDraftIdentities(
        latest,
        new Set(activeIdentityKey ? activeIdentityKey.split("\0") : [])
      )
      if (normalized === latest) return current
      return setThreadDraft(current, {
        ...normalized,
        updatedAt: Date.now(),
      })
    })
  }, [
    activeDraftKey,
    activeIdentityKey,
    commitDrafts,
    threadId,
    threadQuery.data,
  ])

  const setDraft = (value: string) => {
    setSendFailure(undefined)
    commitDrafts((current) => {
      const currentDraft = current[activeDraftKey] ?? {
        key: activeDraftKey,
        value: "",
        updatedAt: 0,
      }
      return setThreadDraft(current, {
        ...currentDraft,
        value,
        recipientId:
          currentDraft.recipientId ??
          (!threadId && value.trim() ? selectedRecipient : undefined),
        submission: undefined,
        updatedAt: Date.now(),
      })
    })
  }

  const setRecipient = (recipientId: string) => {
    setSendFailure(undefined)
    commitDrafts((current) =>
      setThreadDraft(current, {
        ...(current[activeDraftKey] ?? {
          key: activeDraftKey,
          value: "",
          updatedAt: 0,
        }),
        recipientId,
        submission: undefined,
        updatedAt: Date.now(),
      })
    )
  }

  const updateDraftIntent = useCallback(
    (patch: Partial<ThreadDraftIntent>) => {
      setSendFailure(undefined)
      commitDrafts((current) =>
        setThreadDraft(current, {
          ...(current[activeDraftKey] ?? {
            key: activeDraftKey,
            value: "",
            updatedAt: 0,
          }),
          ...patch,
          submission: undefined,
          updatedAt: Date.now(),
        })
      )
    },
    [activeDraftKey, commitDrafts]
  )

  const submit = async () => {
    const body = draft.trim()
    if (!body) return
    if (!threadId && !selectedRecipient) return

    setSendFailure(undefined)
    let submissionResponseIdentityId = effectiveResponseIdentityId
    let submissionFingerprint = fingerprint

    try {
      if (
        threadId &&
        (!participantsQuery.data ||
          participantsQuery.isError ||
          participantsQuery.isFetching)
      ) {
        const refreshed = await participantsQuery.refetch({
          cancelRefetch: false,
        })
        const refreshedParticipants = refreshed.isError
          ? undefined
          : refreshed.data?.participants
        if (!refreshedParticipants) {
          throw new Error("Could not load participants")
        }
        submissionResponseIdentityId = directAgentResponseFor(
          refreshedParticipants
        ).responseIdentityId
        submissionFingerprint = buildSubmissionFingerprint({
          location: draftLocation,
          threadId,
          body,
          notifyIdentityIds,
          responseIdentityId: submissionResponseIdentityId,
          inReplyTo: replyTo,
          responseTo,
        })
      }
      const submission = retainThreadSubmission(
        activeDraft.submission,
        submissionFingerprint,
        () => createClientId(threadId ? "thread-reply" : "thread-post")
      )
      const requestDraft: ThreadDraftState = {
        ...activeDraft,
        key: activeDraftKey,
        value: draft,
        recipientId: threadId ? activeDraft.recipientId : selectedRecipient,
        submission,
      }

      commitDrafts((current) => setThreadDraft(current, requestDraft))

      if (threadId) {
        await replyMutations.reply.mutateAsync({
          threadId,
          body,
          idempotencyKey: submission.idempotencyKey,
          notifyIdentityIds,
          responseIdentityId: submissionResponseIdentityId ?? null,
          inReplyTo: replyTo,
          responseTo,
        })
      } else {
        const result = await createMutations.create.mutateAsync({
          to: selectedRecipient,
          body,
          idempotencyKey: submission.idempotencyKey,
        })
        onNavigateThread(result.location, result.threadId)
      }

      commitDrafts((current) => {
        const latest = current[activeDraftKey]
        if (!latest) return current
        const cleared = clearCompletedThreadDraft(latest, {
          key: activeDraftKey,
          body,
          submission,
        })
        if (cleared === latest) return current
        return removeThreadDraft(current, activeDraftKey)
      })
      requestAnimationFrame(() => composerRef.current?.focus())
    } catch (error) {
      setSendFailure({
        draftKey: activeDraftKey,
        fingerprint: submissionFingerprint,
        message:
          error instanceof Error ? error.message : "Could not send message",
      })
    }
  }

  const pending =
    createMutations.create.isPending || replyMutations.reply.isPending
  const showMobileDetail = Boolean(threadId) || mobileNewOpen
  const navigateNew = useCallback(
    (showComposer: boolean) => {
      setMobileNewOpen(showComposer)
      onNavigateNewRef.current()
    },
    [setMobileNewOpen]
  )
  const selectedLocationLabel = locationLabel(selectedLocation)
  const pageTitle = threadId ? thread?.title : "New thread"

  useEffect(() => {
    setPageMeta({
      titleOverride: pageTitle,
      parentTitleOverride: selectedLocationLabel,
      secondaryAction: {
        label: "New thread",
        displayLabel: "Thread",
        icon: PlusIcon,
        onClick: () => navigateNew(true),
      },
    })
    return () => setPageMeta(null)
  }, [navigateNew, pageTitle, selectedLocationLabel, setPageMeta])

  const replyTarget = threadQuery.data
    ? resolveReplyTarget(threadQuery.data.thread.messages, replyTo)
    : undefined
  const replyAuthor =
    replyTarget && threadQuery.data
      ? threadQuery.data.thread.identities.find(
          (identity) => identity.id === replyTarget.authorIdentityId
        )
      : undefined
  const composerReplyContext = replyTarget
    ? {
        authorName:
          replyTarget.authorMemberId === threadQuery.data?.viewerMemberId
            ? replyAuthor?.default
              ? "You"
              : (replyAuthor?.name ?? "an earlier identity")
            : (replyAuthor?.name ?? "an earlier participant"),
        excerpt: threadExcerpt(replyTarget.body, 120),
      }
    : undefined
  const clearReplyTarget = () => {
    updateDraftIntent({ replyTo: undefined, responseTo: undefined })
  }
  const changeMentionIdentityIds = (identityIds: string[]) => {
    const nextNotifyIdentityIds = identityIds.filter(
      (identityId) => identityId !== responseIdentityId
    )
    updateDraftIntent({
      notifyIdentityIds: nextNotifyIdentityIds.length
        ? nextNotifyIdentityIds
        : undefined,
    })
  }
  const changeResponseIdentityId = (identityId: string | null) => {
    const nextNotifyIdentityIds = draftMentionIdentityIds.filter(
      (mentionedIdentityId) => mentionedIdentityId !== identityId
    )
    updateDraftIntent({
      notifyIdentityIds: nextNotifyIdentityIds.length
        ? nextNotifyIdentityIds
        : undefined,
      responseIdentityId: identityId,
    })
  }
  const selectReplyTarget = async (messageId: string, responds: boolean) => {
    updateDraftIntent({
      replyTo: messageId,
      responseTo: responds ? messageId : null,
      ...(responds
        ? {
            notifyIdentityIds: draftMentionIdentityIds.length
              ? draftMentionIdentityIds
              : undefined,
            responseIdentityId: null,
          }
        : {}),
    })
    requestAnimationFrame(() => composerRef.current?.focus())
  }
  const threadAction = async (
    operation: () => Promise<unknown>,
    fallback: string
  ): Promise<void> => {
    try {
      await operation()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : fallback)
    }
  }

  return (
    <main className="flex h-full min-h-0 bg-background">
      <aside
        className={`relative min-h-0 w-full shrink-0 bg-background md:w-[var(--thread-list-width)] md:border-r md:border-border/60 ${
          showMobileDetail ? "hidden md:flex" : "flex"
        } flex-col`}
        style={
          {
            "--thread-list-width": `${threadListResize.size}px`,
          } as CSSProperties
        }
      >
        {headerControl ? (
          <div className="shrink-0 px-3 pt-3 pb-2">{headerControl}</div>
        ) : (
          <div className="h-3 shrink-0" />
        )}

        <ThreadList
          threads={threads}
          activeThreadId={threadId}
          activeLocation={selectedLocation}
          loading={threadsQuery.isLoading}
          error={threadsQuery.isError}
          showLocations={showLocations}
          locationLabel={locationLabel}
          onNavigate={onNavigateThread}
          onNew={() => navigateNew(true)}
          onRetry={() => void threadsQuery.refetch()}
        />

        <ResizeHandle
          {...threadListResize.handleProps}
          aria-label="Resize thread list"
          className="-right-1 hidden md:block"
        />
      </aside>

      <section
        className={`min-h-0 min-w-0 flex-1 ${
          showMobileDetail ? "flex" : "hidden md:flex"
        } flex-col`}
      >
        {threadId ? (
          threadQuery.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : threadQuery.isError ? (
            <ThreadDetailError
              onRetry={() => void threadQuery.refetch()}
              onBack={() => navigateNew(false)}
            />
          ) : threadQuery.data ? (
            <>
              <header className="shrink-0 px-4 pt-5 pb-4 sm:px-6 md:hidden">
                <div className="flex items-start gap-3">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Back to threads"
                    onClick={() => navigateNew(false)}
                  >
                    <ArrowLeftIcon />
                  </Button>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-display text-lg font-semibold">
                      {threadQuery.data.thread.title}
                    </h2>
                  </div>
                </div>
              </header>

              <div className="min-h-0 flex-1">
                <ThreadTimeline
                  key={`${threadLocationKey(selectedLocation)}:${threadId}`}
                  location={selectedLocation}
                  messages={threadQuery.data.thread.messages}
                  members={threadQuery.data.thread.members}
                  identities={threadQuery.data.thread.identities}
                  targetIdentities={targetIdentities}
                  targetMembers={targetMembers}
                  activities={threadQuery.data.activities}
                  viewerMemberId={threadQuery.data.viewerMemberId}
                  viewerIdentityId={threadQuery.data.viewerIdentityId}
                  implicitResponseIdentityId={directAgentIdentity?.id}
                  onReply={(messageId) =>
                    void selectReplyTarget(messageId, false)
                  }
                  onRespond={(messageId) =>
                    void selectReplyTarget(messageId, true)
                  }
                  onAssign={(messageId, identityId) =>
                    void threadAction(
                      () =>
                        replyMutations.assignMessage.mutateAsync({
                          threadId,
                          messageId,
                          identityId,
                        }),
                      "Could not update assignment"
                    )
                  }
                  hasOlder={threadQuery.data.hasOlder}
                  loadingOlder={replyMutations.loadOlder.isPending}
                  onLoadOlder={() =>
                    void threadAction(
                      () =>
                        replyMutations.loadOlder.mutateAsync({
                          threadId,
                          before: threadQuery.data.oldestCursor,
                        }),
                      "Could not load earlier messages"
                    )
                  }
                  onLoadReplyTarget={async (messageId) => {
                    await threadAction(
                      () =>
                        replyMutations.loadReplyTarget.mutateAsync({
                          threadId,
                          messageId,
                        }),
                      "Could not load the replied-to message"
                    )
                  }}
                />
              </div>

              <ThreadComposer
                ref={composerRef}
                value={draft}
                onChange={setDraft}
                onSubmit={() => void submit()}
                pending={pending}
                disabled={Boolean(threadId && participantsQuery.isFetching)}
                error={activeSendError}
                placeholder="Reply in this thread…"
                replyContext={composerReplyContext}
                onClearReply={clearReplyTarget}
                mentionTargets={otherIdentities.map((identity) => ({
                  id: identity.id,
                  name: identity.name,
                  description: conversationIdentityDescription(
                    identity,
                    targetMembers,
                    targetIdentities
                  ),
                }))}
                mentionIdentityIds={draftMentionIdentityIds}
                onMentionIdentityIdsChange={changeMentionIdentityIds}
                onMentionSelect={(identityId) => {
                  const identity = targetIdentities.find(
                    (candidate) => candidate.id === identityId
                  )
                  if (
                    identity &&
                    threadMentionRequestsResponse(threadMembers, identity) &&
                    (responseIdentityId === undefined ||
                      responseIdentityId === null)
                  ) {
                    changeResponseIdentityId(identityId)
                  }
                }}
                toolbarActions={
                  <ThreadIntentToolbar
                    identities={targetIdentities.filter(
                      (identity) =>
                        identity.id !== threadQuery.data.viewerIdentityId
                    )}
                    members={targetMembers}
                    responseIdentityId={
                      directAgentResponseIsImplicit
                        ? undefined
                        : effectiveResponseIdentityId
                    }
                    onResponseIdentityIdChange={changeResponseIdentityId}
                  />
                }
              />
            </>
          ) : (
            <Empty className="min-h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageCircleIcon />
                </EmptyMedia>
                <EmptyTitle>Thread not found</EmptyTitle>
                <EmptyDescription>
                  It may have moved or no longer be available.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigateNew(false)}
                >
                  Back to threads
                </Button>
              </EmptyContent>
            </Empty>
          )
        ) : (
          <NewThreadPanel
            participants={participants}
            participantsLoading={participantsQuery.isLoading}
            participantsError={participantsQuery.isError}
            recipient={selectedRecipient}
            onRecipientChange={setRecipient}
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={() => void submit()}
            pending={pending}
            error={activeSendError}
            composerRef={composerRef}
            locationControl={locationControl}
            locationLabel={locationLabel(createLocation)}
            onRetryParticipants={() => void participantsQuery.refetch()}
            onBack={() => navigateNew(false)}
          />
        )}
      </section>
    </main>
  )
}

function ThreadIntentToolbar({
  identities,
  members,
  responseIdentityId,
  onResponseIdentityIdChange,
}: {
  identities: ConversationIdentityOption[]
  members: ParticipantRef[]
  responseIdentityId?: string
  onResponseIdentityIdChange: (identityId: string | null) => void
}) {
  return responseIdentityId ? (
    <ThreadResponseIdentityMenu
      identities={identities}
      members={members}
      value={responseIdentityId}
      onChange={(identityId) => onResponseIdentityIdChange(identityId)}
      onClear={() => onResponseIdentityIdChange(null)}
    />
  ) : null
}

function ThreadResponseIdentityMenu({
  identities,
  members,
  value,
  onChange,
  onClear,
}: {
  identities: ConversationIdentityOption[]
  members: ParticipantRef[]
  value: string
  onChange: (identityId: string) => void
  onClear: () => void
}) {
  const selected = identities.find((identity) => identity.id === value)
  const selectedMember = selected
    ? members.find((member) => member.id === selected.memberId)
    : undefined
  const selectedParticipant =
    selected && selectedMember
      ? { ...selectedMember, name: selected.name }
      : undefined
  const [open, setOpen] = useState(false)
  if (!selected) return null

  return (
    <div className="flex h-8 shrink-0 items-center rounded-full bg-surface-selected text-primary-text max-sm:h-11">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <TooltipProvider delay={500}>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="max-w-48 min-w-0 rounded-s-full rounded-e-none px-2 text-primary-text hover:bg-muted hover:text-primary-text max-sm:h-11 dark:hover:bg-muted"
                      aria-label={`Change ${selected.name}`}
                    />
                  }
                />
              }
            >
              <span aria-hidden="true">
                <ThreadParticipantAvatar
                  participant={selectedParticipant}
                  className="size-5"
                />
              </span>
              <span className="truncate">{selected.name}</span>
            </TooltipTrigger>
            <TooltipContent>
              Requests a reply from {selected.name}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <DropdownMenuContent className="min-w-56">
          <DropdownMenuRadioGroup
            aria-label="Reply from"
            value={value}
            onValueChange={(identityId) => {
              onChange(identityId)
              setOpen(false)
            }}
          >
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
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="me-0.5 shrink-0 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground max-sm:size-10 dark:hover:bg-muted"
        aria-label={`Clear ${selected.name}`}
        onClick={onClear}
      >
        <XIcon />
      </Button>
    </div>
  )
}

function ThreadDetailError({
  onRetry,
  onBack,
}: {
  onRetry: () => void
  onBack: () => void
}) {
  return (
    <Empty className="min-h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CircleAlertIcon />
        </EmptyMedia>
        <EmptyTitle>Could not load this thread</EmptyTitle>
        <EmptyDescription>
          Check the connection, retry, or return to the thread list.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
        <Button variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
      </EmptyContent>
    </Empty>
  )
}

function buildSubmissionFingerprint(input: {
  location: ThreadLocation
  threadId: string
  body: string
  recipientId?: string
  notifyIdentityIds?: string[]
  responseIdentityId?: string
  inReplyTo?: string
  responseTo?: string | null
}): string {
  return JSON.stringify({
    kind: input.threadId ? "reply" : "create",
    location: input.location,
    threadId: input.threadId || null,
    body: input.body,
    recipientId: input.recipientId ?? null,
    notifyIdentityIds: [...(input.notifyIdentityIds ?? [])].sort(),
    responseIdentityId: input.responseIdentityId ?? null,
    inReplyTo: input.inReplyTo ?? null,
    responseTo: input.responseTo ?? null,
  })
}
