import { readRecord } from "./record-store.ts"
import { assertSpaceAccess } from "./team-policy.ts"
import type { RecordChangeEvent } from "./workspace-events.ts"

// A watcher event may feed several authorized consumers. Share its one read,
// retaining the result only while a consumer still holds that event object.
const reads = new WeakMap<RecordChangeEvent, ReturnType<typeof readRecord>>()
export function readChangedRecord(
  event: RecordChangeEvent
): ReturnType<typeof readRecord> {
  assertSpaceAccess(event.spaceId, "read")
  let read = reads.get(event)
  if (!read) {
    read = readRecord(event.spaceId, event.collectionId, event.recordId)
    reads.set(event, read)
  }
  return read
}
