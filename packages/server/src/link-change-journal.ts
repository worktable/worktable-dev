import { randomBytes } from "node:crypto"
import type {
  LinkGrant,
  RecordCollectionSchema,
  RecordFile,
  RecordQueryResult,
} from "@worktable/types"
import type { LinkKey } from "./link-grant-view.ts"
import { filterRows } from "./record-query.ts"
import {
  onWorkspaceChange,
  type ChangeEvent,
  type RecordChangeEvent,
} from "./workspace-events.ts"
import { readChangedRecord } from "./workspace-record-change.ts"
import { runAsLinkVisitor, withLinkGrantRead } from "./team-policy.ts"
import { workspaceCacheKey } from "./workspace.ts"

interface Target {
  id: string
  spaceId: string
  authorization: string
  grant: LinkGrant
  schemas: ReadonlyMap<string, RecordCollectionSchema>
  key: LinkKey
}
interface Journal {
  target: Target
  nonce: string
  sequence: number
  touched: number
  events: Array<{ sequence: number; collection: string }>
  served: Set<string>
  overflow: boolean
}

/** Active links retain only opaque ids and a bounded ring of collection hints. */
export class LinkChangeJournal {
  private readonly links = new Map<string, Journal>()

  touch(target: Target): void {
    const now = Date.now()
    this.prune(now)
    let entry = this.links.get(target.id)
    if (!entry || entry.target.authorization !== target.authorization) {
      entry = {
        target,
        nonce: randomBytes(12).toString("base64url"),
        sequence: 0,
        touched: now,
        events: [],
        served: new Set(),
        overflow: false,
      }
    }
    entry.target = target
    entry.touched = now
    this.links.delete(target.id)
    this.links.set(target.id, entry)
    while (this.links.size > 256)
      this.links.delete(this.links.keys().next().value!)
  }

  hasReaders(spaceId: string, collection: string): boolean {
    this.prune(Date.now())
    for (const { target } of this.links.values())
      if (
        target.spaceId === spaceId &&
        Object.hasOwn(target.grant.collections, collection)
      )
        return true
    return false
  }

  served(linkId: string, collection: string, result: RecordQueryResult): void {
    const entry = this.links.get(linkId)
    if (!entry || entry.overflow) return
    const remember = (collectionId: string, id: string) => {
      if (entry.overflow) return
      if (entry.served.size >= 5000) {
        entry.overflow = true
        entry.served.clear()
      } else entry.served.add(`${collectionId}\0${id}`)
    }
    for (const row of result.records) remember(collection, row.id)
    for (const [related, rows] of Object.entries(result.expanded ?? {}))
      for (const id of Object.keys(rows)) remember(related, id)
    for (const [related, ids] of Object.entries(result.backlinks ?? {}))
      for (const id of ids) remember(related, id)
  }

  record(event: RecordChangeEvent, record: RecordFile | null): void {
    this.prune(Date.now())
    for (const entry of this.links.values()) {
      const { target } = entry
      if (target.spaceId !== event.spaceId) continue
      if (!Object.hasOwn(target.grant.collections, event.collectionId)) continue
      const grant = target.grant.collections[event.collectionId]!
      let visible =
        !record ||
        !grant.rows ||
        entry.overflow ||
        entry.served.has(
          `${event.collectionId}\0${target.key.recordId(event.collectionId, event.recordId)}`
        )
      if (!visible && record && grant.rows) {
        try {
          const shell = Object.assign(Object.create(null), {
            id: record.id,
            data: record.data,
          }) as RecordFile
          visible =
            filterRows(
              [shell],
              grant.rows,
              target.schemas.get(event.collectionId)?.fields
            ).length > 0
        } catch {
          visible = true
        }
      }
      if (visible) this.append(entry, event.collectionId)
    }
  }

  collection(spaceId: string, collection: string): void {
    this.prune(Date.now())
    for (const entry of this.links.values())
      if (
        entry.target.spaceId === spaceId &&
        Object.hasOwn(entry.target.grant.collections, collection)
      )
        this.append(entry, collection)
  }

  reset(): void {
    this.links.clear()
  }
  reconcile(): void {
    this.prune(Date.now())
    for (const entry of this.links.values()) {
      entry.nonce = randomBytes(12).toString("base64url")
      entry.sequence = 0
      entry.events = []
    }
  }
  changes(
    linkId: string,
    since?: string
  ): { cursor: string; reset: boolean; collections: string[] } {
    const entry = this.links.get(linkId)
    if (!entry) return { cursor: "", reset: true, collections: [] }
    const cursor = `${entry.nonce}.${entry.sequence}`
    if (since === undefined) return { cursor, reset: false, collections: [] }
    const match = /^([A-Za-z0-9_-]{16})\.(0|[1-9][0-9]{0,15})$/.exec(since)
    const sequence = match ? Number(match[2]) : -1
    if (
      !match ||
      match[1] !== entry.nonce ||
      sequence > entry.sequence ||
      sequence < (entry.events[0]?.sequence ?? entry.sequence) - 1
    ) {
      return {
        cursor,
        reset: true,
        collections: Object.keys(entry.target.grant.collections),
      }
    }
    return {
      cursor,
      reset: false,
      collections: [
        ...new Set(
          entry.events
            .filter((event) => event.sequence > sequence)
            .map((event) => event.collection)
        ),
      ],
    }
  }

  private append(entry: Journal, collection: string): void {
    entry.events.push({ sequence: ++entry.sequence, collection })
    if (entry.events.length > 256) entry.events.shift()
  }
  private prune(now: number): void {
    for (const [id, entry] of this.links)
      if (now - entry.touched > 15 * 60_000) this.links.delete(id)
  }
}

export const linkChangeJournal = new LinkChangeJournal()
const queued = new Map<
  string,
  { event: ChangeEvent; workspace: string; epoch: number }
>()
let epoch = 0
let timer: ReturnType<typeof setTimeout> | undefined
let overflow = false
let flushing = false

// Mutations only enqueue bounded work. No additional record I/O runs while a
// member write is waiting; WebSocket delivery and this journal reuse one read.
onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") {
    epoch++
    queued.clear()
    linkChangeJournal.reset()
    return
  }
  if (
    event.type !== "record" &&
    event.type !== "recordCollection" &&
    event.type !== "recordCollectionReconcile"
  )
    return
  if (!linkChangeJournal.hasReaders(event.spaceId, event.collectionId)) return
  if (queued.size >= 256) {
    queued.clear()
    overflow = true
  }
  queued.set(
    `${event.spaceId}\0${event.collectionId}\0${event.type === "record" ? event.recordId : ""}`,
    { event, workspace: workspaceCacheKey(), epoch }
  )
  scheduleFlush()
})

function scheduleFlush(): void {
  if (!timer && !flushing)
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, 0)
}
async function flush(): Promise<void> {
  flushing = true
  try {
    const batch = [...queued.values()]
    queued.clear()
    if (overflow) {
      overflow = false
      linkChangeJournal.reconcile()
    }
    for (const { event, workspace, epoch: capturedEpoch } of batch) {
      if (workspace !== workspaceCacheKey() || capturedEpoch !== epoch) continue
      if (event.type === "record") {
        let record: RecordFile | null = null
        try {
          record = (
            await runAsLinkVisitor(() =>
              withLinkGrantRead(event.spaceId, () => readChangedRecord(event))
            )
          ).data
        } catch {
          /* unreadable records invalidate conservatively */
        }
        if (workspace === workspaceCacheKey() && capturedEpoch === epoch)
          linkChangeJournal.record(event, record)
      } else if (
        event.type === "recordCollection" ||
        event.type === "recordCollectionReconcile"
      )
        linkChangeJournal.collection(event.spaceId, event.collectionId)
    }
  } finally {
    flushing = false
    if (queued.size) scheduleFlush()
  }
}
