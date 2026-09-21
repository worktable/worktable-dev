import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query"
import { queryKeys } from "./queries"
import { docQueryKeys } from "./docs-queries"
import { documentQueryKeys } from "./documents-queries"
import { threadQueryKeys } from "./threads-queries"
import type {
  ThreadActivity,
  ThreadLocation,
  ThreadReadResult,
  ThreadSummary,
} from "@worktable/types"
import { threadLocationKey } from "@worktable/types"

const WS_BASE =
  import.meta.env.VITE_WS_URL ??
  (typeof window === "undefined"
    ? "ws://localhost:7480"
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`)

export interface WsMessage {
  type: string
  spaceId?: string
  location?: ThreadLocation
  widgetId?: string
  previousWidgetId?: string
  collectionId?: string
  recordId?: string
  threadId?: string
  data?: unknown
}

export type WsStatus = "connecting" | "connected" | "disconnected"

type MessageListener = (message: WsMessage) => void
type StatusListener = (status: WsStatus, reconnected: boolean) => void

interface SharedSpaceConnection {
  url: string
  ws: WebSocket | null
  messageListeners: Set<MessageListener>
  statusListeners: Set<StatusListener>
  status: WsStatus
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempts: number
  hasConnected: boolean
}

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
  const visible = queryClient.getQueryData<{ threads: ThreadSummary[] }>(
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
    void queryClient.invalidateQueries({ queryKey: detailKey, exact: true })
    for (const queryKey of listKeys) {
      void queryClient.invalidateQueries({ queryKey, exact: true })
    }
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
    queryClient.setQueryData<{ threads: ThreadSummary[] }>(
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

function publishStatus(
  connection: SharedSpaceConnection,
  status: WsStatus,
  reconnected = false
): void {
  connection.status = status
  for (const listener of connection.statusListeners) {
    listener(status, reconnected)
  }
}

export async function invalidateWorkspaceQueriesAfterReconnect(
  queryClient: QueryClient,
  reconnected: boolean,
  options?: {
    reconcileRoute?: () => void | Promise<void>
  }
): Promise<void> {
  if (!reconnected) return
  await options?.reconcileRoute?.()
  await queryClient.invalidateQueries()
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
  const ws = new WebSocket(connection.url)
  connection.ws = ws
  let opened = false

  ws.onopen = () => {
    if (connection.ws !== ws) return
    opened = true
    connection.reconnectAttempts = 0
    const reconnected = connection.hasConnected
    connection.hasConnected = true
    publishStatus(connection, "connected", reconnected)
  }

  ws.onmessage = (event) => {
    if (connection.ws !== ws) return
    try {
      const message = JSON.parse(event.data as string) as WsMessage
      for (const listener of connection.messageListeners) listener(message)
    } catch {
      // Ignore malformed messages without disrupting the live connection.
    }
  }

  ws.onclose = () => {
    if (connection.ws !== ws) return
    connection.ws = null
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
  publishStatus(connection, "disconnected")
}

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

export function subscribeToSpaceEvents(
  spaceId: string,
  onMessage: MessageListener,
  onStatus: StatusListener = () => undefined
): () => void {
  ensureVisibilityListener()
  const key = `space:${spaceId}`
  let connection = sharedConnections.get(key)
  if (!connection) {
    connection = {
      url: `${WS_BASE}/ws?spaceId=${encodeURIComponent(spaceId)}`,
      ws: null,
      messageListeners: new Set(),
      statusListeners: new Set(),
      status: "connecting",
      reconnectTimer: null,
      reconnectAttempts: 0,
      hasConnected: false,
    }
    sharedConnections.set(key, connection)
  }
  connection.messageListeners.add(onMessage)
  connection.statusListeners.add(onStatus)
  onStatus(connection.status, false)
  connectShared(connection, true)

  return () => {
    connection.messageListeners.delete(onMessage)
    connection.statusListeners.delete(onStatus)
    if (connection.messageListeners.size > 0) return
    closeShared(connection)
    sharedConnections.delete(key)
  }
}

export function subscribeToWorktableThreadEvents(
  onMessage: MessageListener,
  onStatus: StatusListener = () => undefined
): () => void {
  ensureVisibilityListener()
  const key = "__threads__"
  let connection = sharedConnections.get(key)
  if (!connection) {
    connection = {
      url: `${WS_BASE}/ws?scope=threads`,
      ws: null,
      messageListeners: new Set(),
      statusListeners: new Set(),
      status: "connecting",
      reconnectTimer: null,
      reconnectAttempts: 0,
      hasConnected: false,
    }
    sharedConnections.set(key, connection)
  }
  connection.messageListeners.add(onMessage)
  connection.statusListeners.add(onStatus)
  onStatus(connection.status, false)
  connectShared(connection, true)

  return () => {
    connection.messageListeners.delete(onMessage)
    connection.statusListeners.delete(onStatus)
    if (connection.messageListeners.size > 0) return
    closeShared(connection)
    sharedConnections.delete(key)
  }
}

export function useWorktableThreadSubscription() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const reconcile = () =>
      queryClient.invalidateQueries({ queryKey: threadQueryKeys.root })
    return subscribeToWorktableThreadEvents(
      (message) => {
        if (message.type === "thread_activity" && message.threadId) {
          const location =
            message.location ??
            (message.spaceId
              ? { kind: "space", spaceId: message.spaceId }
              : { kind: "worktable" })
          applyThreadActivityToQueries(
            queryClient,
            location,
            message.threadId,
            message.data as ThreadActivity | undefined
          )
          return
        }
        if (
          message.type === "thread_update" ||
          message.type === "thread_deleted"
        ) {
          void reconcile()
        }
        if (message.type === "participants_update") {
          void queryClient.invalidateQueries({
            queryKey: threadQueryKeys.participants,
            exact: true,
          })
        }
      },
      (status, reconnected) => {
        if (status === "connected") {
          void invalidateWorkspaceQueriesAfterReconnect(
            queryClient,
            reconnected
          )
          void reconcile()
        }
      }
    )
  }, [queryClient])
}

/**
 * Subscribe to real-time updates for a space via WebSocket.
 * Automatically invalidates TanStack Query caches on changes.
 * Returns { status, lastActivityAt } for live indicator use.
 */
export function useSpaceSubscription(
  spaceId: string | undefined,
  onRecordChange?: (collectionId: string | undefined) => void,
  onWidgetMove?: (previousWidgetId: string, widgetId: string) => void,
  reconnectOwner?: {
    reconcileRoute?: () => void | Promise<void>
  }
) {
  const queryClient = useQueryClient()
  // Keep the latest callback in a ref so changing it doesn't re-open the socket.
  const onRecordChangeRef = useRef(onRecordChange)
  const onWidgetMoveRef = useRef(onWidgetMove)
  const reconnectOwnerRef = useRef(reconnectOwner)
  useLayoutEffect(() => {
    onRecordChangeRef.current = onRecordChange
    onWidgetMoveRef.current = onWidgetMove
    reconnectOwnerRef.current = reconnectOwner
  }, [onRecordChange, onWidgetMove, reconnectOwner])
  const [status, setStatus] = useState<WsStatus>("connecting")
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null)

  useEffect(() => {
    if (!spaceId) return
    const location = { kind: "space", spaceId } as const

    const onStatus = (next: WsStatus, reconnected: boolean) => {
      setStatus(next)
      if (next === "connected") {
        if (reconnectOwnerRef.current) {
          void invalidateWorkspaceQueriesAfterReconnect(
            queryClient,
            reconnected,
            reconnectOwnerRef.current
          )
        }
        void reconcileSpaceThreadQueries(queryClient, spaceId)
      }
    }

    const onMessage = (msg: WsMessage) => {
      try {
        setLastActivityAt(Date.now())

        if (msg.type === "space_update" && spaceId) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.space(spaceId),
            exact: true,
          })
          void queryClient.invalidateQueries({
            queryKey: queryKeys.spaces,
            exact: true,
          })
        }

        if (msg.type === "widget_update" && msg.widgetId && spaceId) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.widget(spaceId, msg.widgetId),
          })
          void queryClient.invalidateQueries({
            queryKey: queryKeys.space(spaceId),
            exact: true,
          })
          void queryClient.invalidateQueries({
            queryKey: queryKeys.spaces,
            exact: true,
          })
          void queryClient.invalidateQueries({
            queryKey: documentQueryKeys.list(spaceId),
          })
        }

        if (
          msg.type === "widget_moved" &&
          msg.previousWidgetId &&
          msg.widgetId &&
          spaceId
        ) {
          // A move is not a deletion. Refresh the exact list/detail owners
          // without prefix-invalidating the still-mounted old widget query;
          // then let an open old route follow the move.
          void queryClient.invalidateQueries({
            queryKey: queryKeys.widget(spaceId, msg.widgetId),
          })
          void queryClient.invalidateQueries({
            queryKey: queryKeys.space(spaceId),
            exact: true,
          })
          void queryClient.invalidateQueries({
            queryKey: queryKeys.spaces,
            exact: true,
          })
          void queryClient.invalidateQueries({
            queryKey: documentQueryKeys.list(spaceId),
          })
          void queryClient.invalidateQueries({
            queryKey: ["annotations", spaceId],
          })
          onWidgetMoveRef.current?.(msg.previousWidgetId, msg.widgetId)
        }

        if (
          (msg.type === "record_update" ||
            msg.type === "record_deleted" ||
            msg.type === "record_collection_update") &&
          spaceId
        ) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.recordCollections(spaceId),
          })
          if (msg.collectionId) {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.records(spaceId, msg.collectionId),
            })
          }
          // Relay to any subscribed widget (its sandboxed iframe can't hold its
          // own socket when exposed).
          onRecordChangeRef.current?.(msg.collectionId)
        }

        if (msg.type === "widget_deleted" && msg.widgetId && spaceId) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.widget(spaceId, msg.widgetId),
            exact: true,
            refetchType: "none",
          })
          void queryClient.invalidateQueries({
            queryKey: queryKeys.space(spaceId),
            exact: true,
          })
          void queryClient.invalidateQueries({
            queryKey: queryKeys.spaces,
            exact: true,
          })
          void queryClient.invalidateQueries({
            queryKey: documentQueryKeys.list(spaceId),
          })
          // Deleting an HTML doc cascades its annotation file away, so refresh
          // the annotation queries (per-doc panels + Space Home attention).
          void queryClient.invalidateQueries({
            queryKey: ["annotations", spaceId],
          })
        }

        if (
          (msg.type === "annotation_update" ||
            msg.type === "annotation_deleted") &&
          spaceId
        ) {
          // Prefix invalidation covers both per-doc annotation queries and
          // the space-wide list behind Space Home's needs-attention strip —
          // lint and agent annotations arrive over WS, not user mutations.
          void queryClient.invalidateQueries({
            queryKey: ["annotations", spaceId],
          })
        }

        if (
          (msg.type === "doc_update" || msg.type === "doc_deleted") &&
          spaceId
        ) {
          // Doc content syncs through Yjs, but the docs LIST (titles,
          // freshness, backlink counts on Space Home and the sidebar) only
          // refreshes by refetch — without this, an open overview shows
          // stale markers until the query's stale window expires.
          void queryClient.invalidateQueries({
            queryKey: docQueryKeys.docs(spaceId),
          })
          void queryClient.invalidateQueries({
            queryKey: documentQueryKeys.list(spaceId),
          })
        }

        if (
          msg.type === "doc_update" ||
          msg.type === "doc_deleted" ||
          msg.type === "widget_update" ||
          msg.type === "widget_moved" ||
          msg.type === "widget_deleted"
        ) {
          void queryClient.invalidateQueries({ queryKey: ["search"] })
        }

        if (
          (msg.type === "thread_update" || msg.type === "thread_deleted") &&
          spaceId
        ) {
          void reconcileSpaceThreadQueries(queryClient, spaceId, msg.threadId)
        }

        if (msg.type === "participants_update" && spaceId) {
          void queryClient.invalidateQueries({
            queryKey: threadQueryKeys.participants,
            exact: true,
          })
        }

        if (msg.type === "thread_activity" && msg.threadId && spaceId) {
          applyThreadActivityToQueries(
            queryClient,
            location,
            msg.threadId,
            msg.data as ThreadActivity | undefined
          )
        }
      } catch {
        // ignore malformed messages
      }
    }
    return subscribeToSpaceEvents(spaceId, onMessage, onStatus)
  }, [spaceId, queryClient])

  return { status, lastActivityAt }
}

/**
 * Returns true if there was WS activity within the last `windowMs` ms.
 */
export function useIsLive(
  lastActivityAt: number | null,
  windowMs = 3000
): boolean {
  const [isLive, setIsLive] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!lastActivityAt) return
    setIsLive(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setIsLive(false), windowMs)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [lastActivityAt, windowMs])

  return isLive
}
