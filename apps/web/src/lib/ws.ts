import {
  acceptTeamContext,
  browserTeamMemberId,
  reconcileTeamAccess,
} from "./team-context"
import { RUNTIME_BASE_PATH } from "./runtime-path"
import { activityQueryKeys } from "./activity.ts"
import { useEffect, useLayoutEffect, useRef } from "react"
import {
  useQueryClient,
  type InvalidateQueryFilters,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query"
import { queryKeys } from "./queries"
import { docQueryKeys } from "./docs-queries"
import {
  documentQueryKeys,
  isDocumentContentQuery,
  rememberDocumentContent,
} from "./documents-queries"
import { patchDocumentRevision } from "./document-rows"
import { recentQueryKeys } from "./lifetime"
import { threadQueryKeys } from "./threads-queries"
import { refreshLive } from "./live-refresh"
import { noteNavigationChanged } from "./personal-navigation"
import { applyRecordChange } from "./record-cache"
import { noteSocketStatus, type SocketStatus } from "./connection-status"
import { traceTrigger } from "./trace"
import {
  isOwnCollaborativeSave,
  takeLiveDocumentLabelChange,
} from "./live-documents"
import {
  isSpaceLive,
  noteDocumentChange,
  noteSpaceChange,
  noteSpaceLive,
  THREAD_STREAM,
} from "./space-observation"
import type {
  DocListEntry,
  DocumentContent,
  DocumentListItem,
  RecordFile,
  Thread,
  ThreadActivity,
  ThreadLocation,
  ThreadReadResult,
  ThreadListItem,
} from "@worktable/types"
import { threadLocationKey } from "@worktable/types"

const WS_BASE =
  import.meta.env.VITE_WS_URL ??
  (typeof window === "undefined"
    ? "ws://localhost:7480"
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${RUNTIME_BASE_PATH}`)

export interface WsMessage {
  type: string
  spaceId?: string
  docPath?: string
  /** What produced a change, such as "yjs" for a collaborative save. */
  origin?: string
  location?: ThreadLocation
  widgetId?: string
  previousWidgetId?: string
  collectionId?: string
  recordId?: string
  threadId?: string
  data?: unknown
  /** An `error` message's reason. */
  error?: string
}

export type WsStatus = SocketStatus

type MessageListener = (message: WsMessage) => void
type StatusListener = (status: WsStatus, reconnected: boolean) => void

interface SharedSpaceConnection {
  url: string
  /** The Space this socket follows, or the workspace thread stream. */
  stream: string
  ws: WebSocket | null
  messageListeners: Set<MessageListener>
  statusListeners: Set<StatusListener>
  status: WsStatus
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempts: number
  hasConnected: boolean
  /** Cache updates run once per message here, not once per listener. */
  queryClient: QueryClient | null
  /** Pending close after the last listener left. */
  closeTimer: ReturnType<typeof setTimeout> | null
}

// Views unmount and mount again during route changes and Suspense. Keep a
// socket briefly after its last listener leaves, so that churn neither
// reconnects it nor forgets that the cache was being kept current.
const CLOSE_GRACE_MS = 1_000

interface WorktableBrowserGlobal {
  __worktableSpaceConnections?: Map<string, SharedSpaceConnection>
  __worktableSpaceVisibilityListenerInstalled?: boolean
}

// TanStack's route splitting can include this module in more than one browser
// chunk. Keep the registry on the browser global so those module instances,
// and hot-reloaded replacements, still enforce one socket per Space.
const browserGlobal = globalThis as typeof globalThis & WorktableBrowserGlobal
const sharedConnections =
  browserGlobal.__worktableSpaceConnections ??
  (browserGlobal.__worktableSpaceConnections = new Map())

export function spaceReconnectDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), 10_000)
}

export function spaceReconnectAttemptsForTrigger(
  currentAttempts: number,
  explicit: boolean
): number {
  return explicit ? 0 : currentAttempts
}

export function isSpaceThreadReconnectQuery(
  queryKey: readonly unknown[],
  spaceId: string
): boolean {
  const locationKey = `space:${spaceId}`
  return (
    (queryKey[0] === "threads" && queryKey[1] === "participants") ||
    (queryKey[0] === "threads" &&
      (queryKey[2] === locationKey || queryKey[3] === locationKey))
  )
}

export function pruneInvisibleThreadDetails(
  queryClient: QueryClient,
  spaceId: string
): string[] {
  const location = { kind: "space", spaceId } as const
  const visible = queryClient.getQueryData<{ threads: ThreadListItem[] }>(
    threadQueryKeys.list(location)
  )
  if (!visible) return []

  const visibleIds = new Set(visible.threads.map((thread) => thread.id))
  const removed: string[] = []
  for (const [queryKey] of queryClient.getQueriesData({
    queryKey: threadQueryKeys.root,
  })) {
    const threadId = threadDetailId(queryKey, spaceId)
    if (!threadId || visibleIds.has(threadId)) continue
    void queryClient.resetQueries({
      queryKey: threadQueryKeys.detail(location, threadId),
      exact: true,
    })
    removed.push(threadId)
  }
  return removed
}

export async function reconcileSpaceThreadQueries(
  queryClient: QueryClient,
  spaceId: string,
  threadId?: string
): Promise<void> {
  const location = { kind: "space", spaceId } as const
  await (threadId
    ? Promise.all([
        queryClient.invalidateQueries({
          queryKey: threadQueryKeys.list(location),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: threadQueryKeys.detail(location, threadId),
          exact: true,
        }),
      ])
    : queryClient.invalidateQueries({
        predicate: (query) =>
          isSpaceThreadReconnectQuery(query.queryKey, spaceId),
      }))
  pruneInvisibleThreadDetails(queryClient, spaceId)
}

function threadDetailId(queryKey: QueryKey, spaceId: string): string | null {
  return queryKey[0] === "threads" &&
    queryKey[1] === "detail" &&
    queryKey[2] === `space:${spaceId}` &&
    typeof queryKey[3] === "string"
    ? queryKey[3]
    : null
}

export function shouldReplaceThreadSummaryActivity(
  current: ThreadActivity | undefined,
  incoming: ThreadActivity,
  messages: ThreadReadResult["thread"]["messages"],
  latestMessageId?: string
): boolean {
  if (!current) return true
  if (current.messageId === incoming.messageId) {
    return incoming.revision >= current.revision
  }
  if (current.messageId === latestMessageId) return false
  if (incoming.messageId === latestMessageId) return true
  const sequence = (messageId: string) =>
    messages.find((message) => message.id === messageId)?.sequence
  const currentSequence = sequence(current.messageId)
  const incomingSequence = sequence(incoming.messageId)
  return (
    currentSequence !== undefined &&
    incomingSequence !== undefined &&
    incomingSequence >= currentSequence
  )
}

export function applyThreadActivityToQueries(
  queryClient: QueryClient,
  location: ThreadLocation,
  threadId: string,
  activity: ThreadActivity | undefined
): void {
  const detailKey = threadQueryKeys.detail(location, threadId)
  const listKeys = [
    threadQueryKeys.list({ kind: "all" }),
    threadQueryKeys.list(location),
  ]
  if (!activity?.messageId) {
    refreshLive(queryClient, [
      { queryKey: detailKey, exact: true },
      ...listKeys.map((queryKey) => ({ queryKey, exact: true })),
    ])
    return
  }

  queryClient.setQueryData<ThreadReadResult>(detailKey, (current) => {
    if (!current) return current
    const previous = current.activities.find(
      (item) =>
        item.messageId === activity.messageId &&
        item.identityId === activity.identityId
    )
    const nextActivity =
      previous && previous.revision > activity.revision ? previous : activity
    const activities = current.activities
      .filter(
        (item) =>
          item.messageId !== activity.messageId ||
          item.identityId !== activity.identityId
      )
      .concat(nextActivity)
      .sort((a, b) => {
        const sequence = (messageId: string) =>
          current.thread.messages.find((message) => message.id === messageId)
            ?.sequence ?? Number.MAX_SAFE_INTEGER
        return sequence(a.messageId) - sequence(b.messageId)
      })
    return {
      ...current,
      activities,
      activity: activities.at(-1),
    }
  })
  const detail = queryClient.getQueryData<ThreadReadResult>(detailKey)
  for (const queryKey of listKeys) {
    queryClient.setQueryData<{ threads: ThreadListItem[] }>(
      queryKey,
      (current) =>
        current
          ? {
              threads: current.threads.map((thread) =>
                thread.id === threadId &&
                threadLocationKey(thread.location) ===
                  threadLocationKey(location)
                  ? {
                      ...thread,
                      activity: shouldReplaceThreadSummaryActivity(
                        thread.activity,
                        activity,
                        detail?.thread.messages ?? [],
                        thread.lastMessage.id
                      )
                        ? activity
                        : thread.activity,
                    }
                  : thread
              ),
            }
          : current
    )
  }
}

/**
 * Apply a thread the server sent with a change. The open window keeps its
 * oldest message and gains everything newer, so no read is needed.
 */
export function applyThreadPayload(
  queryClient: QueryClient,
  location: ThreadLocation,
  thread: Thread
): void {
  queryClient.setQueryData<ThreadReadResult>(
    threadQueryKeys.detail(location, thread.id),
    (current) => {
      if (!current || thread.revision < current.thread.revision) return current
      const messages = thread.messages.filter(
        (message) => message.sequence >= current.oldestCursor
      )
      const firstSequence = thread.messages[0]?.sequence
      return {
        ...current,
        thread: { ...thread, messages },
        messages,
        cursor: messages.at(-1)?.sequence ?? current.cursor,
        hasOlder:
          firstSequence !== undefined &&
          firstSequence < (messages[0]?.sequence ?? Number.POSITIVE_INFINITY),
        hasNewer: false,
      }
    }
  )
}

function messageLocation(
  message: WsMessage,
  fallback: ThreadLocation
): ThreadLocation {
  return (
    message.location ??
    (message.spaceId ? { kind: "space", spaceId: message.spaceId } : fallback)
  )
}

const THREAD_EVENTS = new Set([
  "thread_update",
  "thread_deleted",
  "thread_activity",
])

/**
 * Apply one thread event to cached threads. A named thread change patches the
 * open thread from its payload and refreshes only the lists that show it; a
 * change the server could not name reconciles the scope.
 */
export function applyThreadEvent(
  queryClient: QueryClient,
  message: WsMessage,
  scope: ThreadLocation | null
): void {
  const location = messageLocation(message, scope ?? { kind: "worktable" })
  const lists = [
    { queryKey: threadQueryKeys.list({ kind: "all" }), exact: true },
    { queryKey: threadQueryKeys.list(location), exact: true },
  ]
  const pending = { queryKey: activityQueryKeys.pending }
  const activity = { queryKey: activityQueryKeys.all }
  if (message.type === "thread_activity") {
    const update = message.data as ThreadActivity | undefined
    if (message.threadId) {
      applyThreadActivityToQueries(
        queryClient,
        location,
        message.threadId,
        update
      )
    }
    // Progress while an agent works leaves Pending as it was; a delivery
    // that ends, fails or starts over can change it.
    if (update?.state !== "working" && update?.state !== "receiving") {
      refreshLive(queryClient, [pending])
    }
    return
  }
  if (message.type === "thread_update" && message.threadId && message.data) {
    applyThreadPayload(queryClient, location, message.data as Thread)
    return
  }
  if (message.type === "thread_update" && message.threadId) {
    refreshLive(queryClient, [...lists, activity, pending])
    return
  }
  if (message.type === "thread_deleted" && message.threadId) {
    refreshLive(queryClient, [
      ...lists,
      {
        queryKey: threadQueryKeys.detail(location, message.threadId),
        exact: true,
      },
      activity,
      pending,
    ])
    return
  }
  if (message.type === "thread_update") {
    if (scope?.kind === "space") {
      void reconcileSpaceThreadQueries(queryClient, scope.spaceId)
    } else {
      void queryClient.invalidateQueries({ queryKey: threadQueryKeys.root })
    }
    refreshLive(queryClient, [activity, pending])
  }
}

/**
 * Keep the open document's lists in step with its own save without reading
 * them again: the save moves its date, and its label changes only when its
 * first heading did.
 */
function applyOwnCollaborativeSave(
  queryClient: QueryClient,
  spaceId: string,
  message: WsMessage
): void {
  const path = message.docPath!
  const data = (message.data ?? {}) as {
    updatedAt?: number
    provenance?: DocListEntry["provenance"]
  }
  queryClient.setQueryData<DocListEntry[]>(docQueryKeys.docs(spaceId), (rows) =>
    rows?.map((row) =>
      row.path === path
        ? {
            ...row,
            ...(data.updatedAt ? { updatedAt: data.updatedAt } : {}),
            ...(data.provenance ? { provenance: data.provenance } : {}),
          }
        : row
    )
  )
  const updatedAt =
    data.provenance?.updatedAt ??
    (data.updatedAt ? new Date(data.updatedAt).toISOString() : undefined)
  if (updatedAt) {
    queryClient.setQueryData<DocumentListItem[]>(
      documentQueryKeys.list(spaceId),
      (rows) =>
        rows?.map((row) =>
          row.kind === "document" && row.path === path
            ? { ...row, updatedAt }
            : row
        )
    )
  }
  // Lists on other pages read again when they next open.
  for (const queryKey of [["search"], recentQueryKeys.all, activityQueryKeys.all]) {
    void queryClient.invalidateQueries({ queryKey, refetchType: "none" })
  }
  const listed = queryClient
    .getQueryData<DocListEntry[]>(docQueryKeys.docs(spaceId))
    ?.find((row) => row.path === path)
  if (takeLiveDocumentLabelChange(spaceId, path, listed?.headings?.[0])) {
    refreshLive(queryClient, [
      { queryKey: docQueryKeys.docs(spaceId), exact: true },
    ])
  }
}

/**
 * Retire what this message can make stale. A change named by path (a save,
 * an outside edit, an archive, a deletion, an HTML Doc's update or move)
 * concerns only that document. One without a path (alias and catalog
 * changes, which is how renames and folder moves also arrive) and Space
 * changes concern every document in the Space.
 */
export function observeSpaceMessage(stream: string, message: WsMessage): void {
  const type = message.type
  if (type === "space_update" || type === "spaces_changed") {
    noteSpaceChange(stream)
    return
  }
  const paths = type.startsWith("doc_")
    ? [message.docPath]
    : type.startsWith("widget_")
      ? [message.widgetId, message.previousWidgetId]
      : null
  if (!paths) return
  const named = paths.filter((path): path is string => Boolean(path))
  if (named.length === 0) {
    noteSpaceChange(stream)
    return
  }
  for (const path of named) noteDocumentChange(stream, path)
}

/** What a doc_update says about the content it describes. */
function updatedContent(message: WsMessage): {
  revision?: string
  content?: DocumentContent
} {
  const data = (message.data ?? {}) as {
    revision?: unknown
    format?: unknown
    content?: unknown
  }
  if (typeof data.revision !== "string") return {}
  const revision = data.revision
  const format =
    data.format === "markdown" || data.format === "blocknote"
      ? data.format
      : null
  const content =
    format === "markdown" && typeof data.content === "string"
      ? data.content
      : format === "blocknote" && Array.isArray(data.content)
        ? data.content
        : null
  return {
    revision,
    ...(format && content !== null
      ? { content: { revision, format, content } }
      : {}),
  }
}

/**
 * A change event names the document's new revision: move its rows there in
 * place, and keep the content it carried for a document this tab reads.
 */
function applyDocumentRevision(
  queryClient: QueryClient,
  spaceId: string,
  message: WsMessage
): void {
  const path = message.docPath
  const { revision, content } = updatedContent(message)
  if (!path || !revision) return
  patchDocumentRevision(queryClient, spaceId, path, revision)
  if (content) rememberDocumentContent(queryClient, spaceId, path, content)
}

/**
 * Apply one Space event to the query cache: patch what the payload carries
 * and refresh exactly the queries it can change.
 */
export function applySpaceEvent(
  queryClient: QueryClient,
  spaceId: string,
  message: WsMessage
): void {
  const type = message.type
  const space = { queryKey: queryKeys.space(spaceId), exact: true }
  const spaces = { queryKey: queryKeys.spaces, exact: true }
  const docs = { queryKey: docQueryKeys.docs(spaceId), exact: true }
  const documents = { queryKey: documentQueryKeys.list(spaceId), exact: true }
  const references = { queryKey: docQueryKeys.referencesIn(spaceId) }
  const annotations = { queryKey: ["annotations", spaceId] }
  const search = { queryKey: ["search"] }
  const recent = { queryKey: recentQueryKeys.all }
  const activity = { queryKey: activityQueryKeys.all }
  const pending = { queryKey: activityQueryKeys.pending }
  const refresh: InvalidateQueryFilters[] = []

  if (type === "spaces_changed") refresh.push(spaces)
  if (type === "space_update") refresh.push(space, spaces, activity)

  if (type === "widget_update" && message.widgetId) {
    refresh.push(
      { queryKey: queryKeys.widget(spaceId, message.widgetId) },
      // An open HTML doc reloads its frame when the check's revision moves.
      {
        queryKey: documentQueryKeys.page(spaceId, message.widgetId),
        exact: true,
      },
      space,
      documents,
      search,
      recent,
      activity
    )
  }
  if (type === "widget_moved" && message.widgetId) {
    // A move is not a deletion: refresh the new owner and the lists, and let
    // an open old route follow the move.
    refresh.push(
      { queryKey: queryKeys.widget(spaceId, message.widgetId) },
      space,
      documents,
      annotations,
      search,
      recent,
      activity
    )
  }
  if (type === "widget_deleted" && message.widgetId) {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.widget(spaceId, message.widgetId),
      exact: true,
      refetchType: "none",
    })
    // Deleting an HTML doc removes its annotations too.
    refresh.push(space, documents, annotations, search, recent, activity)
  }

  if (
    (type === "record_update" || type === "record_deleted") &&
    message.collectionId &&
    message.recordId
  ) {
    refresh.push(
      ...applyRecordChange(
        queryClient,
        spaceId,
        message.collectionId,
        message.recordId,
        type === "record_update" && message.data
          ? (message.data as RecordFile)
          : null
      ),
      activity
    )
  }
  if (type === "record_collection_update") {
    refresh.push(
      { queryKey: queryKeys.recordCollections(spaceId), exact: true },
      message.collectionId
        ? { queryKey: queryKeys.records(spaceId, message.collectionId) }
        : { queryKey: queryKeys.recordCollections(spaceId) },
      activity
    )
  }

  if (type === "annotation_update" || type === "annotation_deleted") {
    refresh.push(annotations, activity, pending)
  }

  // What points at these docs changed: their open pages read it again.
  if (type === "doc_links_update") {
    const docPaths = (message.data as { docPaths?: unknown } | undefined)
      ?.docPaths
    for (const path of Array.isArray(docPaths) ? docPaths : []) {
      if (typeof path !== "string") continue
      refresh.push({
        queryKey: documentQueryKeys.page(spaceId, path),
        exact: true,
      })
    }
  }

  if (type === "doc_update" || type === "doc_deleted") {
    // Rows open the new revision at once; the lists still read again for
    // what else the change moved (a conversion's format, dates, titles).
    if (type === "doc_update") {
      applyDocumentRevision(queryClient, spaceId, message)
    }
    if (isOwnCollaborativeSave({ ...message, spaceId })) {
      applyOwnCollaborativeSave(queryClient, spaceId, message)
    } else {
      refresh.push(docs, documents, references, search, recent, activity)
      if (message.docPath) {
        refresh.push({
          queryKey: documentQueryKeys.page(spaceId, message.docPath),
          exact: true,
        })
      }
    }
  }

  // The workspace thread stream carries every thread event when it is open.
  if (THREAD_EVENTS.has(type) && !isSpaceLive(THREAD_STREAM)) {
    applyThreadEvent(queryClient, message, { kind: "space", spaceId })
  }
  if (type === "participants_update") {
    refresh.push({ queryKey: threadQueryKeys.participants, exact: true })
  }

  refreshLive(queryClient, refresh)
}

/**
 * After a reconnect the tab may have missed any change in the Space. Mark
 * everything it holds for the Space stale and read again only the lists on
 * screen; open documents check themselves.
 */
export function revalidateSpaceAfterReconnect(
  queryClient: QueryClient,
  spaceId: string
): void {
  void queryClient.invalidateQueries({
    queryKey: ["spaces", spaceId],
    // Content at a revision never changes.
    predicate: (query) => !isDocumentContentQuery(query.queryKey),
    refetchType: "none",
  })
  // Every live socket hears spaces_changed, so a Spaces list read another
  // reconnect already started needs no read after it.
  void queryClient.invalidateQueries(
    { queryKey: queryKeys.spaces, exact: true },
    { cancelRefetch: false }
  )
  refreshLive(queryClient, [
    { queryKey: queryKeys.space(spaceId), exact: true },
    { queryKey: docQueryKeys.docs(spaceId), exact: true },
    { queryKey: documentQueryKeys.list(spaceId), exact: true },
    { queryKey: docQueryKeys.referencesIn(spaceId) },
    // Collection list, open grids and their totals.
    { queryKey: queryKeys.recordCollections(spaceId) },
    // An open document's page check: an HTML doc reloads its frame only when
    // the revision there moved. The route's own re-check joins this read.
    { queryKey: ["spaces", spaceId, "document-page"] },
    { queryKey: ["annotations", spaceId] },
    { queryKey: recentQueryKeys.all },
    { queryKey: activityQueryKeys.all },
    { queryKey: activityQueryKeys.pending },
  ])
  if (!isSpaceLive(THREAD_STREAM)) {
    // Activity's live replies read the workspace thread list.
    refreshLive(queryClient, [
      { queryKey: threadQueryKeys.list({ kind: "all" }), exact: true },
    ])
    void reconcileSpaceThreadQueries(queryClient, spaceId)
  }
}

function publishStatus(
  connection: SharedSpaceConnection,
  status: WsStatus,
  reconnected = false
): void {
  connection.status = status
  noteSocketStatus(connection.url, status)
  for (const listener of connection.statusListeners) {
    listener(status, reconnected)
  }
}

function applyMessage(
  connection: SharedSpaceConnection,
  message: WsMessage
): void {
  const queryClient = connection.queryClient
  if (!queryClient) return
  // Only the person's own sockets hear this, on whichever stream they follow.
  if (message.type === "navigation_changed") {
    noteNavigationChanged(
      queryClient,
      (message.data as { revision?: unknown } | undefined)?.revision
    )
    return
  }
  if (connection.stream === THREAD_STREAM) {
    if (THREAD_EVENTS.has(message.type)) {
      applyThreadEvent(queryClient, message, null)
    } else if (message.type === "participants_update") {
      refreshLive(queryClient, [
        { queryKey: threadQueryKeys.participants, exact: true },
      ])
    } else if (message.type === "spaces_changed") {
      refreshLive(queryClient, [{ queryKey: queryKeys.spaces, exact: true }])
    }
    return
  }
  applySpaceEvent(queryClient, connection.stream, message)
}

function revalidateAfterReconnect(connection: SharedSpaceConnection): void {
  const queryClient = connection.queryClient
  if (!queryClient) return
  traceTrigger("reconnect")
  // A reconnect can follow a workspace replaced from another tab, or a
  // network change that moved linked sharing: check both, unless returning
  // to the tab just did.
  for (const queryKey of [queryKeys.workspace, ["system", "deployment"]]) {
    const state = queryClient.getQueryState(queryKey)
    if (
      state?.fetchStatus === "fetching" ||
      (state?.dataUpdatedAt ?? 0) > Date.now() - 10_000
    ) {
      continue
    }
    void queryClient.invalidateQueries({ queryKey, exact: true })
  }
  if (connection.stream === THREAD_STREAM) {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.root })
    return
  }
  revalidateSpaceAfterReconnect(queryClient, connection.stream)
}

function connectShared(
  connection: SharedSpaceConnection,
  explicit = false
): void {
  connection.reconnectAttempts = spaceReconnectAttemptsForTrigger(
    connection.reconnectAttempts,
    explicit
  )
  if (
    document.hidden ||
    connection.messageListeners.size === 0 ||
    (connection.ws && connection.ws.readyState <= WebSocket.OPEN)
  ) {
    return
  }

  if (connection.reconnectTimer) {
    clearTimeout(connection.reconnectTimer)
    connection.reconnectTimer = null
  }
  publishStatus(connection, "connecting")
  const url = new URL(connection.url)
  const memberId = browserTeamMemberId()
  if (memberId) url.searchParams.set("memberId", memberId)
  const ws = new WebSocket(url)
  connection.ws = ws
  let opened = false

  ws.onopen = () => {
    if (connection.ws !== ws) return
    opened = true
    connection.reconnectAttempts = 0
  }

  ws.onmessage = (event) => {
    if (connection.ws !== ws) return
    let message: WsMessage
    try {
      message = JSON.parse(event.data as string) as WsMessage
    } catch {
      // Ignore malformed messages without disrupting the live connection.
      return
    }
    if (message.type === "team_access") {
      // This member's access changed: apply it in place, without a request.
      acceptTeamContext(message)
      return
    }
    if (message.type === "error" && message.error === "Credential revoked") {
      // The server detaches a socket whose Space this member lost.
      reconcileTeamAccess()
    }
    if (message.type === "subscribed") {
      // The server now delivers every change: the stream is caught up.
      const reconnected = connection.hasConnected
      connection.hasConnected = true
      noteSpaceLive(connection.stream, true)
      if (reconnected) revalidateAfterReconnect(connection)
      publishStatus(connection, "connected", reconnected)
    } else {
      observeSpaceMessage(connection.stream, message)
      try {
        applyMessage(connection, message)
      } catch {
        // A malformed payload must not stop the listeners below.
      }
    }
    for (const listener of connection.messageListeners) listener(message)
  }

  ws.onclose = () => {
    if (connection.ws !== ws) return
    connection.ws = null
    noteSpaceLive(connection.stream, false)
    publishStatus(connection, "disconnected")
    if (connection.messageListeners.size === 0 || document.hidden) return
    if (!opened) {
      connection.reconnectAttempts += 1
    }
    connection.reconnectTimer = setTimeout(
      () => connectShared(connection),
      spaceReconnectDelayMs(connection.reconnectAttempts)
    )
  }

  ws.onerror = () => ws.close()
}

function closeShared(connection: SharedSpaceConnection): void {
  if (connection.reconnectTimer) {
    clearTimeout(connection.reconnectTimer)
    connection.reconnectTimer = null
  }
  const ws = connection.ws
  connection.ws = null
  ws?.close()
  noteSpaceLive(connection.stream, false)
  publishStatus(connection, "disconnected")
}

// Hidden tabs close their sockets. Returning reconnects each one, and each
// revalidates only its own scope once the server confirms the subscription.
function ensureVisibilityListener(): void {
  if (browserGlobal.__worktableSpaceVisibilityListenerInstalled) return
  browserGlobal.__worktableSpaceVisibilityListenerInstalled = true
  document.addEventListener("visibilitychange", () => {
    for (const connection of sharedConnections.values()) {
      if (document.hidden) closeShared(connection)
      else connectShared(connection, true)
    }
  })
}

function subscribeShared(
  key: string,
  url: string,
  stream: string,
  onMessage: MessageListener,
  onStatus: StatusListener,
  queryClient: QueryClient | undefined
): () => void {
  ensureVisibilityListener()
  let connection = sharedConnections.get(key)
  if (!connection) {
    connection = {
      url,
      stream,
      ws: null,
      messageListeners: new Set(),
      statusListeners: new Set(),
      status: "connecting",
      reconnectTimer: null,
      reconnectAttempts: 0,
      hasConnected: false,
      queryClient: null,
      closeTimer: null,
    }
    sharedConnections.set(key, connection)
  }
  if (connection.closeTimer) {
    clearTimeout(connection.closeTimer)
    connection.closeTimer = null
  }
  if (queryClient) connection.queryClient = queryClient
  connection.messageListeners.add(onMessage)
  connection.statusListeners.add(onStatus)
  onStatus(connection.status, false)
  connectShared(connection, true)

  return () => {
    connection.messageListeners.delete(onMessage)
    connection.statusListeners.delete(onStatus)
    if (connection.messageListeners.size > 0 || connection.closeTimer) return
    connection.closeTimer = setTimeout(() => {
      connection.closeTimer = null
      if (connection.messageListeners.size > 0) return
      closeShared(connection)
      sharedConnections.delete(key)
      noteSocketStatus(connection.url, null)
      // Nothing keeps this Space's cache current any more: whatever is
      // cached reads again when it is next shown.
      if (connection.queryClient && stream !== THREAD_STREAM) {
        for (const queryKey of [["spaces", stream], ["annotations", stream]]) {
          void connection.queryClient.invalidateQueries({
            queryKey,
            // Content at a revision never changes.
            predicate: (query: { queryKey: QueryKey }) =>
              !isDocumentContentQuery(query.queryKey),
            refetchType: "none",
          })
        }
      }
    }, CLOSE_GRACE_MS)
  }
}

/**
 * Follow a Space's change stream. Every subscriber shares one socket; with a
 * query client, the socket keeps the cache current once per message.
 */
export function subscribeToSpaceEvents(
  spaceId: string,
  onMessage: MessageListener,
  onStatus: StatusListener = () => undefined,
  queryClient?: QueryClient
): () => void {
  return subscribeShared(
    `space:${spaceId}`,
    `${WS_BASE}/ws?spaceId=${encodeURIComponent(spaceId)}`,
    spaceId,
    onMessage,
    onStatus,
    queryClient
  )
}

export function subscribeToWorktableThreadEvents(
  onMessage: MessageListener,
  onStatus: StatusListener = () => undefined,
  queryClient?: QueryClient
): () => void {
  return subscribeShared(
    "__threads__",
    `${WS_BASE}/ws?scope=threads`,
    THREAD_STREAM,
    onMessage,
    onStatus,
    queryClient
  )
}

/** Keep thread queries current from the workspace thread stream. */
export function useWorktableThreadSubscription() {
  const queryClient = useQueryClient()

  useEffect(
    () =>
      subscribeToWorktableThreadEvents(
        () => undefined,
        () => undefined,
        queryClient
      ),
    [queryClient]
  )
}

/**
 * Subscribe to real-time updates for a space via WebSocket. The shared socket
 * keeps the query cache current; `reconcileRoute` runs after a reconnect so
 * the route can check its own path again.
 */
export function useSpaceSubscription(
  spaceId: string | undefined,
  reconnectOwner?: {
    reconcileRoute?: () => void | Promise<void>
  }
): void {
  const queryClient = useQueryClient()
  // Keep the latest callback in a ref so changing it doesn't re-open the socket.
  const reconnectOwnerRef = useRef(reconnectOwner)
  useLayoutEffect(() => {
    reconnectOwnerRef.current = reconnectOwner
  }, [reconnectOwner])

  useEffect(() => {
    if (!spaceId) return
    return subscribeToSpaceEvents(
      spaceId,
      () => undefined,
      (next, reconnected) => {
        if (next === "connected" && reconnected) {
          void reconnectOwnerRef.current?.reconcileRoute?.()
        }
      },
      queryClient
    )
  }, [spaceId, queryClient])
}
