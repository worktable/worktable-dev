import type { ThreadLocation } from "@worktable/types"
import { threadEventLocation, type ChangeEvent } from "./workspace-events.ts"
import { readSpace, readDoc, docStat, getDocProvenance } from "./store.ts"
import { readWidget } from "./widget-store.ts"
import { readRecord } from "./record-store.ts"
import { readThread } from "./thread-store.ts"
import { getThreadActivity } from "./thread-delivery-store.ts"

// ============================================================
// Types
// ============================================================

// We use a structural type matching Bun's ServerWebSocket without importing it directly
interface WsClient {
  send(message: string): void
  close(): void
  data: {
    spaceId: string
    credentialRevoked?: boolean
    canReadDocs?: boolean
    canReadWidgets?: boolean
    canReadRecords?: boolean
    canReadAnnotations?: boolean
    canReadThreads?: boolean
    threadScope?: boolean
  }
}

interface OutgoingMessage {
  type:
    | "space_update"
    | "doc_update"
    | "doc_deleted"
    | "widget_update"
    | "widget_moved"
    | "widget_deleted"
    | "record_update"
    | "record_deleted"
    | "record_collection_update"
    | "annotation_update"
    | "annotation_deleted"
    | "thread_update"
    | "thread_deleted"
    | "thread_activity"
    | "participants_update"
    | "spaces_changed"
    | "error"
    | "subscribed"
  spaceId?: string
  location?: ThreadLocation
  docPath?: string
  widgetId?: string
  previousWidgetId?: string
  collectionId?: string
  recordId?: string
  threadId?: string
  data?: unknown
  error?: string
}

// ============================================================
// WsManager — tracks live subscriptions
// ============================================================

export class WsManager {
  // Map from spaceId -> set of ws clients
  private subscriptions: Map<string, Set<WsClient>> = new Map()

  subscribe(ws: WsClient, spaceId: string): void {
    if (!this.subscriptions.has(spaceId)) {
      this.subscriptions.set(spaceId, new Set())
    }
    this.subscriptions.get(spaceId)!.add(ws)
  }

  unsubscribe(ws: WsClient): void {
    for (const [spaceId, clients] of this.subscriptions) {
      clients.delete(ws)
      if (clients.size === 0) {
        this.subscriptions.delete(spaceId)
      }
    }
  }

  async handleChange(event: ChangeEvent): Promise<void> {
    // Space metadata (name, icon, doc order/sort) renders in every client's
    // sidebar, but clients only subscribe to a few spaces — notify everyone
    // BEFORE the subscriber guard, or a change to an unwatched space would
    // never invalidate anyone's spaces list.
    if (event.type === "space") {
      this.broadcastAll({ type: "spaces_changed" })
    }

    if (
      event.type === "thread" ||
      event.type === "threadCollectionReconcile" ||
      event.type === "threadActivity"
    ) {
      await this.handleThreadChange(event)
      return
    }
    if (event.type === "participants") {
      if (event.spaceId) {
        this.broadcast(event.spaceId, {
          type: "participants_update",
          spaceId: event.spaceId,
        })
      } else {
        this.broadcast(THREADS_SCOPE, { type: "participants_update" })
      }
      return
    }
    if (event.type === "workspaceReset") {
      this.broadcastAll({ type: "spaces_changed" })
      return
    }

    const clients = this.subscriptions.get(event.spaceId)
    if (!clients || clients.size === 0) return

    try {
      if (event.type === "space") {
        const { data, error } = await readSpace(event.spaceId)
        if (error || !data) return

        const msg: OutgoingMessage = {
          type: "space_update",
          spaceId: event.spaceId,
          data,
        }
        this.broadcast(event.spaceId, msg)
      } else if (event.type === "widget") {
        const { data, error } = await readWidget(event.spaceId, event.widgetId)
        if (error || !data) return

        const msg: OutgoingMessage = {
          type: "widget_update",
          spaceId: event.spaceId,
          widgetId: event.widgetId,
          data,
        }
        this.broadcast(event.spaceId, msg)
      } else if (event.type === "record") {
        const { data, error } = await readRecord(
          event.spaceId,
          event.collectionId,
          event.recordId
        )
        const msg: OutgoingMessage =
          error || !data
            ? {
                type: "record_deleted",
                spaceId: event.spaceId,
                collectionId: event.collectionId,
                recordId: event.recordId,
              }
            : {
                type: "record_update",
                spaceId: event.spaceId,
                collectionId: event.collectionId,
                recordId: event.recordId,
                data,
              }
        this.broadcast(event.spaceId, msg)
      } else if (
        event.type === "recordCollection" ||
        event.type === "recordCollectionReconcile"
      ) {
        this.broadcast(event.spaceId, {
          type: "record_collection_update",
          spaceId: event.spaceId,
          collectionId: event.collectionId,
        })
      } else if (event.type === "docAliases") {
        // Alias changes affect doc enumeration, backlinks, and old-path
        // navigation without changing a document file. Reuse the list-level
        // doc invalidation signal (no docPath) so existing clients refetch.
        this.broadcast(event.spaceId, {
          type: "doc_update",
          spaceId: event.spaceId,
        })
      } else if (event.type === "documentCorpus") {
        this.broadcast(event.spaceId, {
          type: "doc_update",
          spaceId: event.spaceId,
        })
      } else if (event.type === "doc") {
        const docResult = await readDoc(event.spaceId, event.docPath)
        const content = docResult.data
        if (!content) {
          // File was deleted
          const msg: OutgoingMessage = {
            type: "doc_deleted",
            spaceId: event.spaceId,
            docPath: event.docPath,
          }
          this.broadcast(event.spaceId, msg)
          return
        }

        const statResult = await docStat(event.spaceId, event.docPath)
        const provenance = await getDocProvenance(event.spaceId, event.docPath)
        const msg: OutgoingMessage = {
          type: "doc_update",
          spaceId: event.spaceId,
          docPath: event.docPath,
          data: {
            path: event.docPath,
            content,
            updatedAt: statResult?.updatedAt ?? Date.now(),
            provenance,
          },
        }
        this.broadcast(event.spaceId, msg)
      }
    } catch (err) {
      console.error("[WsManager] handleChange error:", err)
    }
  }

  private async handleThreadChange(
    event: Extract<
      ChangeEvent,
      {
        type: "thread" | "threadCollectionReconcile" | "threadActivity"
      }
    >
  ): Promise<void> {
    const location = threadEventLocation(event)
    const spaceId = location.kind === "space" ? location.spaceId : undefined
    const keys = [THREADS_SCOPE, ...(spaceId ? [spaceId] : [])]
    if (event.type === "threadCollectionReconcile") {
      for (const key of keys) {
        this.broadcast(key, {
          type: "thread_update",
        })
      }
      return
    }

    let thread: Awaited<ReturnType<typeof readThread>> | undefined
    try {
      thread = await readThread(location, event.threadId)
    } catch {
      // A missing file is represented as a deletion for every workspace
      // client with thread read access.
    }
    const message: OutgoingMessage =
      event.type === "threadActivity"
        ? {
            type: "thread_activity",
            location,
            spaceId,
            threadId: event.threadId,
            data: await getThreadActivity(
              location,
              event.threadId,
              event.messageId,
              event.identityId
            ),
          }
        : thread
          ? {
              type: "thread_update",
              location,
              spaceId,
              threadId: event.threadId,
              data: thread,
            }
          : {
              type: "thread_deleted",
              location,
              spaceId,
              threadId: event.threadId,
            }
    for (const key of keys) {
      this.broadcastThread(key, message, thread)
      if (event.type === "thread") {
        // Detail subscribers receive the payload above. The payload-free event
        // also invalidates list queries whose ordering or excerpt may change.
        this.broadcast(key, {
          type: "thread_update",
        })
      }
    }
  }

  broadcast(spaceId: string, msg: OutgoingMessage): void {
    const clients = this.subscriptions.get(spaceId)
    if (!clients) return

    const json = JSON.stringify(msg)
    const dead: WsClient[] = []

    for (const ws of clients) {
      if (!canReceive(ws, msg)) continue
      try {
        ws.send(json)
      } catch {
        dead.push(ws)
      }
    }

    for (const ws of dead) {
      this.unsubscribe(ws)
    }
  }

  private broadcastThread(
    spaceId: string,
    msg: OutgoingMessage,
    _thread?: Awaited<ReturnType<typeof readThread>>
  ): void {
    const clients = this.subscriptions.get(spaceId)
    if (!clients) return

    const json = JSON.stringify(msg)
    const dead: WsClient[] = []
    for (const ws of clients) {
      const authorized = !ws.data.credentialRevoked && ws.data.canReadThreads === true
      if (!authorized) continue
      try {
        ws.send(json)
      } catch {
        dead.push(ws)
      }
    }

    for (const ws of dead) {
      this.unsubscribe(ws)
    }
  }

  broadcastAll(msg: OutgoingMessage): void {
    const json = JSON.stringify(msg)
    const dead: WsClient[] = []

    for (const clients of this.subscriptions.values()) {
      for (const ws of clients) {
        if (!canReceive(ws, msg)) continue
        try {
          ws.send(json)
        } catch {
          dead.push(ws)
        }
      }
    }

    for (const ws of dead) {
      this.unsubscribe(ws)
    }
  }

  closeAll(): void {
    for (const clients of this.subscriptions.values()) {
      for (const ws of clients) {
        try {
          ws.close()
        } catch {
          // The transport may already have completed its close handshake.
        }
      }
    }
    this.subscriptions.clear()
  }

  subscriberCount(spaceId?: string): number {
    if (spaceId) {
      return this.subscriptions.get(spaceId)?.size ?? 0
    }
    let total = 0
    for (const clients of this.subscriptions.values()) {
      total += clients.size
    }
    return total
  }
}

function canReceive(ws: WsClient, msg: OutgoingMessage): boolean {
  if (ws.data.credentialRevoked) return false
  switch (msg.type) {
    case "doc_update":
    case "doc_deleted":
      return ws.data.canReadDocs === true
    case "widget_update":
    case "widget_moved":
    case "widget_deleted":
      return ws.data.canReadWidgets === true
    case "record_update":
    case "record_deleted":
    case "record_collection_update":
      return ws.data.canReadRecords === true
    case "annotation_update":
    case "annotation_deleted":
      return ws.data.canReadAnnotations === true
    case "thread_update":
    case "thread_deleted":
    case "thread_activity":
    case "participants_update":
      return ws.data.canReadThreads === true
    case "space_update":
    case "spaces_changed":
      return (
        ws.data.canReadDocs === true ||
        ws.data.canReadWidgets === true ||
        ws.data.canReadRecords === true ||
        ws.data.canReadAnnotations === true
      )
    case "error":
    case "subscribed":
      return true
  }
}

export const wsManager = new WsManager()
export const THREADS_SCOPE = "__worktable_threads__"
