import { useCallback, useEffect, useRef } from "react"
import { subscribeToSpaceEvents, type WsMessage } from "@/lib/ws"

export interface SpaceWsMessage {
  type:
    | "doc_update"
    | "doc_deleted"
    | "widget_update"
    | "widget_moved"
    | "widget_deleted"
    | "space_update"
    | "view_update"
    | "annotation_update"
    | "annotation_deleted"
    | "record_update"
    | "record_deleted"
    | "record_collection_update"
    | "thread_update"
    | "thread_deleted"
    | "thread_activity"
    | "spaces_changed"
    | "subscribed"
    | "error"
  spaceId?: string
  docPath?: string
  widgetId?: string
  previousWidgetId?: string
  viewId?: string
  collectionId?: string
  recordId?: string
  threadId?: string
  data?: unknown
}

type SpaceEventHandler = (msg: SpaceWsMessage) => void

/**
 * Subscribe to space-level WebSocket events (doc list changes, view updates, etc.).
 * Shares the existing /ws?spaceId=xxx connection with query invalidation.
 */
export function useSpaceEvents(spaceId: string | undefined) {
  const handlersRef = useRef<Set<SpaceEventHandler>>(new Set())

  useEffect(() => {
    if (!spaceId) return
    return subscribeToSpaceEvents(spaceId, (message: WsMessage) => {
      handlersRef.current.forEach((handler) =>
        handler(message as SpaceWsMessage)
      )
    })
  }, [spaceId])

  const subscribe = useCallback((handler: SpaceEventHandler) => {
    handlersRef.current.add(handler)
    return () => {
      handlersRef.current.delete(handler)
    }
  }, [])

  return { subscribe }
}
