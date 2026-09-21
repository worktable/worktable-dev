import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type { ThreadLocation, ThreadReadResult } from "@worktable/types"
import { threadLocationKey } from "@worktable/types"
import {
  assignThreadMessage,
  createThread,
  listThreadParticipants,
  listThreads,
  postThreadReply,
  readThread,
  readThreadMessage,
  type ThreadListScope,
} from "./threads-api"

function scopeKey(scope: ThreadListScope): string {
  return scope.kind === "all" ? "all" : threadLocationKey(scope)
}

export const threadQueryKeys = {
  root: ["threads"] as const,
  list: (scope: ThreadListScope) =>
    ["threads", "list", scopeKey(scope)] as const,
  detail: (location: ThreadLocation, threadId: string) =>
    ["threads", "detail", threadLocationKey(location), threadId] as const,
  participants: ["threads", "participants"] as const,
}

export const threadsQueryOptions = (scope: ThreadListScope) =>
  queryOptions({
    queryKey: threadQueryKeys.list(scope),
    queryFn: () => listThreads(scope),
    staleTime: 15_000,
  })

export const threadQueryOptions = (
  location: ThreadLocation,
  threadId: string
) =>
  queryOptions({
    queryKey: threadQueryKeys.detail(location, threadId),
    queryFn: () => readThread(location, threadId),
    enabled: Boolean(threadId),
  })

export function useThreads(scope: ThreadListScope) {
  return useQuery(threadsQueryOptions(scope))
}

export function useThread(location: ThreadLocation, threadId: string) {
  const queryClient = useQueryClient()
  const options = threadQueryOptions(location, threadId)
  return useQuery({
    ...options,
    queryFn: () =>
      refreshThreadWindow(
        queryClient.getQueryData(options.queryKey),
        (before) =>
          readThread(
            location,
            threadId,
            before === undefined ? undefined : { before }
          )
      ),
  })
}

export function useThreadParticipants() {
  return useQuery({
    queryKey: threadQueryKeys.participants,
    queryFn: () => listThreadParticipants(),
    staleTime: 30_000,
  })
}

export function useThreadMutations(location: ThreadLocation) {
  const queryClient = useQueryClient()
  const invalidate = (threadId?: string) =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: threadQueryKeys.root,
      }),
      ...(threadId
        ? [
            queryClient.invalidateQueries({
              queryKey: threadQueryKeys.detail(location, threadId),
              exact: true,
            }),
          ]
        : []),
    ])

  return {
    assignMessage: useMutation({
      mutationFn: (input: {
        threadId: string
        messageId: string
        identityId: string | null
      }) =>
        assignThreadMessage(
          location,
          input.threadId,
          input.messageId,
          input.identityId
        ),
      onMutate: async (input) => {
        const queryKey = threadQueryKeys.detail(location, input.threadId)
        await queryClient.cancelQueries({ queryKey, exact: true })
        queryClient.setQueryData<ThreadReadResult>(queryKey, (current) =>
          applyThreadAssignment(current, input.messageId, input.identityId)
        )
      },
      onError: (_error, input) => invalidate(input.threadId),
      onSuccess: (_result, input) => invalidate(input.threadId),
    }),
    loadOlder: useMutation({
      mutationFn: (input: { threadId: string; before: number }) =>
        readThread(location, input.threadId, { before: input.before }),
      onSuccess: (older, input) => {
        queryClient.setQueryData<ThreadReadResult>(
          threadQueryKeys.detail(location, input.threadId),
          (current) => mergeThreadPage(current, older)
        )
      },
    }),
    loadReplyTarget: useMutation({
      mutationFn: async (input: { threadId: string; messageId: string }) => {
        const { message } = await readThreadMessage(
          location,
          input.threadId,
          input.messageId
        )
        const queryKey = threadQueryKeys.detail(location, input.threadId)
        let current = queryClient.getQueryData<ThreadReadResult>(queryKey)
        if (!current) {
          return readThread(location, input.threadId, {
            before: message.sequence + 1,
          })
        }
        while (message.sequence < current.oldestCursor && current.hasOlder) {
          const previousOldest = current.oldestCursor
          const page = await readThread(location, input.threadId, {
            before: previousOldest,
          })
          current = mergeThreadPage(current, page)
          if (current.oldestCursor >= previousOldest) break
        }
        if (
          !current.messages.some((candidate) => candidate.id === message.id)
        ) {
          throw new Error("Could not load this reply. Try again.")
        }
        return current
      },
      onSuccess: (page, input) => {
        queryClient.setQueryData<ThreadReadResult>(
          threadQueryKeys.detail(location, input.threadId),
          page
        )
      },
    }),
    create: useMutation({
      mutationFn: (input: {
        to: string
        body: string
        idempotencyKey: string
      }) => createThread(location, input),
      onSuccess: (result) => invalidate(result.threadId),
    }),
    reply: useMutation({
      mutationFn: (input: {
        threadId: string
        body: string
        idempotencyKey: string
        notifyIdentityIds?: string[]
        responseIdentityId?: string | null
        inReplyTo?: string
        responseTo?: string | null
      }) =>
        postThreadReply(location, input.threadId, {
          body: input.body,
          idempotencyKey: input.idempotencyKey,
          notifyIdentityIds: input.notifyIdentityIds,
          responseIdentityId: input.responseIdentityId,
          inReplyTo: input.inReplyTo,
          responseTo: input.responseTo,
        }),
      onSuccess: (result) => invalidate(result.threadId),
    }),
  }
}

export function applyThreadAssignment(
  current: ThreadReadResult | undefined,
  messageId: string,
  identityId: string | null
): ThreadReadResult | undefined {
  if (!current) return current
  const activities = current.activities.filter(
    (activity) => activity.messageId !== messageId
  )
  const update = (message: ThreadReadResult["messages"][number]) =>
    message.id === messageId
      ? {
          ...message,
          notifyIdentityIds: identityId
            ? message.notifyIdentityIds.filter(
                (candidateId) => candidateId !== identityId
              )
            : message.notifyIdentityIds,
          responseRequest: identityId
            ? { identityId, status: "open" as const }
            : undefined,
        }
      : message
  return {
    ...current,
    thread: {
      ...current.thread,
      messages: current.thread.messages.map(update),
    },
    messages: current.messages.map(update),
    activities,
    activity:
      current.activity?.messageId === messageId
        ? activities.at(-1)
        : current.activity,
  }
}

export function mergeThreadPage(
  current: ThreadReadResult | undefined,
  page: ThreadReadResult
): ThreadReadResult {
  if (!current) return page
  const currentFirst = current.messages[0]?.sequence
  const currentLast = current.messages.at(-1)?.sequence
  const pageFirst = page.messages[0]?.sequence
  const pageLast = page.messages.at(-1)?.sequence
  if (
    currentFirst !== undefined &&
    currentLast !== undefined &&
    pageFirst !== undefined &&
    pageLast !== undefined &&
    (pageLast < currentFirst - 1 || pageFirst > currentLast + 1)
  ) {
    return current
  }
  const messages = [...page.messages, ...current.messages]
    .filter(
      (message, index, all) =>
        all.findIndex((candidate) => candidate.id === message.id) === index
    )
    .sort((left, right) => left.sequence - right.sequence)
  const activities = [...page.activities, ...current.activities].filter(
    (activity, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.messageId === activity.messageId &&
          candidate.identityId === activity.identityId
      ) === index
  )
  const oldestCursor = messages[0]?.sequence ?? current.oldestCursor
  return {
    ...current,
    thread: { ...current.thread, messages },
    messages,
    activities,
    oldestCursor,
    hasOlder:
      oldestCursor === page.oldestCursor ? page.hasOlder : current.hasOlder,
  }
}

export async function refreshThreadWindow(
  current: ThreadReadResult | undefined,
  readPage: (before?: number) => Promise<ThreadReadResult>
): Promise<ThreadReadResult> {
  let refreshed = await readPage()
  if (!current) return refreshed
  while (refreshed.oldestCursor > current.oldestCursor && refreshed.hasOlder) {
    const previousOldest = refreshed.oldestCursor
    const page = await readPage(previousOldest)
    refreshed = mergeThreadPage(refreshed, page)
    if (refreshed.oldestCursor >= previousOldest) break
  }
  return refreshed
}
