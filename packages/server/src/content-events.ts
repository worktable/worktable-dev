// ============================================================
// Internal doc-content change notification
// ============================================================
//
// The workspace watcher is the change-notification path for
// *external* edits, but internal writes (REST, MCP, Yjs persists)
// suppress their own watcher events to avoid self-echo — which
// left derived state (search index, link graph) blind to them.
// This leaf module closes that gap: the store notifies here on
// every doc content mutation, and derived-state modules subscribe.
//
// Listeners must be synchronous and cheap (typically a dirty-flag
// flip); anything expensive belongs behind lazy rebuilds.

export type DocContentListener = (spaceId: string, docPath: string) => void;

const listeners = new Set<DocContentListener>();

export function onDocContentChanged(listener: DocContentListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyDocContentChanged(spaceId: string, docPath: string): void {
  for (const listener of listeners) {
    try {
      listener(spaceId, docPath);
    } catch (err) {
      console.error("[content-events] listener error:", err);
    }
  }
}
