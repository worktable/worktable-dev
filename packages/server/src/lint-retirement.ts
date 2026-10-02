// ============================================================
// Retirement of automatic wiki-lint annotations
// ============================================================
//
// Worktable used to generate broken-link, orphan, and length findings as
// annotations authored by the system "worktable-lint" identity. That producer
// is gone. This pass resolves the findings it left open so they stop
// appearing as feedback. A finding someone replied to stays open: the reply
// is human or agent feedback and is not ours to close.
//
// Resolving is idempotent, so running at every boot is safe; once the
// leftovers are resolved, later runs find nothing to do.

import type { Annotation } from "@worktable/types"
import { listAnnotations, resolveAnnotation } from "./annotation-store.ts"
import { listSpaces } from "./store.ts"
import { wsManager } from "./ws.ts"

const RETIRED_LINT_AUTHOR_ID = "worktable-lint"
const RETIREMENT_REASON = "Automatic lint was retired"

export interface LintRetirementReceipt {
  spaceId: string
  resolved: string[]
  keptWithReplies: string[]
}

function isRetirable(annotation: Annotation): boolean {
  return (
    annotation.status === "open" &&
    annotation.author.type === "system" &&
    annotation.author.id === RETIRED_LINT_AUTHOR_ID
  )
}

function hasFeedbackReply(annotation: Annotation): boolean {
  return annotation.thread.some((message) => message.author.type !== "system")
}

export async function retireLintAnnotations(): Promise<LintRetirementReceipt[]> {
  const receipts: LintRetirementReceipt[] = []
  for (const space of await listSpaces()) {
    const { annotations } = await listAnnotations(space.id, {
      labels: ["lint"],
      limit: 10_000,
    })
    const receipt: LintRetirementReceipt = {
      spaceId: space.id,
      resolved: [],
      keptWithReplies: [],
    }
    for (const annotation of annotations) {
      if (!isRetirable(annotation)) continue
      if (hasFeedbackReply(annotation)) {
        receipt.keptWithReplies.push(annotation.id)
        continue
      }
      const resolved = await resolveAnnotation(
        space.id,
        annotation.id,
        RETIREMENT_REASON,
        RETIRED_LINT_AUTHOR_ID
      )
      receipt.resolved.push(annotation.id)
      wsManager.broadcast(space.id, {
        type: "annotation_update",
        spaceId: space.id,
        data: { annotationId: resolved.id, annotation: resolved, event: "resolved" },
      })
    }
    if (receipt.resolved.length > 0 || receipt.keptWithReplies.length > 0) {
      receipts.push(receipt)
    }
  }
  return receipts
}
