// ============================================================
// Internal record change notification
// ============================================================
//
// Counterpart of content-events.ts for records. Record writes do
// not suppress their watcher events, so external consumers still
// hear them via the watcher — but the watcher is debounced and
// re-reads files. Derived state that wants the mutation
// synchronously, with the parsed record in hand (the record
// index), subscribes here; the store notifies on every internal
// record mutation. This module is a leaf so the store never has
// to import its own consumers (no import cycles).
//
// Listeners must be synchronous and cheap. Watcher echoes of the
// same mutation are expected — consumers must apply idempotently.

import type { RecordFile } from "@worktable/types";

export type RecordChangeEvent =
  | { kind: "write"; spaceId: string; record: RecordFile }
  | { kind: "delete"; spaceId: string; collectionId: string; recordId: string }
  | { kind: "collection"; spaceId: string; collectionId: string };

export type RecordChangeListener = (event: RecordChangeEvent) => void;

const listeners = new Set<RecordChangeListener>();

export function onRecordChanged(listener: RecordChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyRecordChanged(event: RecordChangeEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[record-events] listener error:", err);
    }
  }
}
