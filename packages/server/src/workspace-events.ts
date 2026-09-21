export interface SpaceChangeEvent {
  type: "space"
  spaceId: string
}

export interface DocAliasesChangeEvent {
  type: "docAliases"
  spaceId: string
}

export interface DocChangeEvent {
  type: "doc"
  spaceId: string
  docPath: string
}

/**
 * A format-neutral document claim or source changed without a more specific
 * legacy Doc or HTML Doc identity. Consumers should refresh corpus-level
 * derived state rather than guessing which future format owns the path.
 */
export interface DocumentCorpusChangeEvent {
  type: "documentCorpus"
  spaceId: string
}

export interface WidgetChangeEvent {
  type: "widget"
  spaceId: string
  widgetId: string
}

export interface RecordChangeEvent {
  type: "record"
  spaceId: string
  collectionId: string
  recordId: string
}

export interface RecordCollectionChangeEvent {
  type: "recordCollection"
  spaceId: string
  collectionId: string
}

/**
 * Filesystem activity occurred inside a record collection, but the watcher
 * could not identify one canonical record path. Atomic writers commonly emit
 * only the temporary-path side of a rename on Linux. Consumers must reconcile
 * the bounded collection from canonical files instead of guessing a target.
 */
export interface RecordCollectionReconcileEvent {
  type: "recordCollectionReconcile"
  spaceId: string
  collectionId: string
}

export interface ThreadChangeEvent {
  type: "thread"
  location?: ThreadLocation
  /** @deprecated Use location instead. */
  spaceId?: string
  threadId: string
}

/**
 * Filesystem activity occurred inside a Space's threads directory without
 * naming one canonical thread file. Consumers should invalidate collection
 * views while the watcher enumerates current canonical files into precise
 * thread events.
 */
export interface ThreadCollectionReconcileEvent {
  type: "threadCollectionReconcile"
  location?: ThreadLocation
  /** @deprecated Use location instead. */
  spaceId?: string
}

export interface ThreadActivityChangeEvent {
  type: "threadActivity"
  location?: ThreadLocation
  /** @deprecated Use location instead. */
  spaceId?: string
  threadId: string
  messageId: string
  participantId: string
  identityId?: string
}

export interface ParticipantsChangeEvent {
  type: "participants"
  /** Present when notifying one existing per-Space subscription. */
  spaceId?: string
}

export interface WorkspaceResetChangeEvent {
  type: "workspaceReset"
}

export type ChangeEvent =
  | SpaceChangeEvent
  | DocAliasesChangeEvent
  | DocChangeEvent
  | DocumentCorpusChangeEvent
  | WidgetChangeEvent
  | RecordChangeEvent
  | RecordCollectionChangeEvent
  | RecordCollectionReconcileEvent
  | ThreadChangeEvent
  | ThreadCollectionReconcileEvent
  | ThreadActivityChangeEvent
  | ParticipantsChangeEvent
  | WorkspaceResetChangeEvent

export type ChangeHandler = (event: ChangeEvent) => unknown

export function threadEventLocation(
  event:
    | ThreadChangeEvent
    | ThreadCollectionReconcileEvent
    | ThreadActivityChangeEvent
): ThreadLocation {
  if (event.location) return event.location
  if (event.spaceId) return { kind: "space", spaceId: event.spaceId }
  return { kind: "worktable" }
}

/** Machine-local collaboration activity does not change searchable content. */
export function changeEventAffectsContentDerivedState(
  event: ChangeEvent
): boolean {
  return event.type !== "threadActivity" && event.type !== "participants"
}

const handlers = new Set<ChangeHandler>()
const pendingHandlers = new Set<Promise<unknown>>()

/** One provider-neutral event seam for internal and external workspace changes. */
export function onWorkspaceChange(handler: ChangeHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

function dispatchWorkspaceChange(event: ChangeEvent): Promise<unknown>[] {
  const dispatched: Promise<unknown>[] = []
  for (const handler of handlers) {
    try {
      const result = handler(event)
      if (
        result &&
        typeof (result as PromiseLike<unknown>).then === "function"
      ) {
        const pending = Promise.resolve(result)
        dispatched.push(pending)
        pendingHandlers.add(pending)
        void pending
          .catch((err) => {
            console.error("[workspace-events] async handler error:", err)
          })
          .finally(() => {
            pendingHandlers.delete(pending)
          })
      }
    } catch (err) {
      console.error("[workspace-events] handler error:", err)
      const rejected = Promise.reject(err)
      // Fire-and-forget callers retain the historical log-and-continue
      // behavior; lifecycle callers can still observe this rejection through
      // the returned dispatch list.
      void rejected.catch(() => undefined)
      dispatched.push(rejected)
    }
  }
  return dispatched
}

export function notifyWorkspaceChange(event: ChangeEvent): void {
  dispatchWorkspaceChange(event)
}

/** Dispatch one event and wait for every handler started by that event. */
export async function notifyWorkspaceChangeAndWait(
  event: ChangeEvent
): Promise<void> {
  await Promise.allSettled(dispatchWorkspaceChange(event))
}

/**
 * Critical lifecycle variant: wait for every consumer and surface any failure
 * after all of them settle. Workspace replacement uses this so it cannot reopen
 * writes with only some reset-derived state advanced.
 */
export async function notifyWorkspaceChangeAndWaitOrThrow(
  event: ChangeEvent
): Promise<void> {
  const results = await Promise.allSettled(dispatchWorkspaceChange(event))
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  )
  if (errors.length > 0) {
    throw new AggregateError(errors, "workspace change handler failed")
  }
}

/** Wait until every async handler triggered so far has settled. */
export async function drainWorkspaceChanges(): Promise<void> {
  // A handler can synchronously emit another event before it settles. Loop
  // until no newly registered work remains rather than taking one snapshot.
  while (pendingHandlers.size > 0) {
    await Promise.allSettled([...pendingHandlers])
  }
}
import type { ThreadLocation } from "@worktable/types"
