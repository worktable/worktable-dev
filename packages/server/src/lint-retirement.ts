// ============================================================
// Retirement of automatic wiki-lint annotations
// ============================================================
//
// Worktable used to generate broken-link, orphan, and length findings as
// annotations authored by the system "worktable-lint" identity. That producer
// is gone. This pass resolves the findings it left open so they stop
// appearing as feedback. A finding someone replied to, reopened, or edited
// stays open: that engagement is human or agent feedback and is not ours to
// close.
//
// Resolving is idempotent, so running at every boot is safe; once the
// leftovers are resolved, later runs find nothing to do.

import type { Annotation } from "@worktable/types"
import { listAnnotations, resolveAnnotation } from "./annotation-store.ts"
import { listSpaces } from "./store.ts"
import { wsManager } from "./ws.ts"

const RETIRED_LINT_AUTHOR_ID = "worktable-lint"
const RETIREMENT_REASON = "Automatic lint was retired"
const PAGE_SIZE = 500

export interface LintRetirementReceipt {
  spaceId: string
  resolved: string[]
  keptWithFeedback: string[]
  failed: string[]
}

function isRetirable(annotation: Annotation): boolean {
  return (
    annotation.status === "open" &&
    annotation.author.type === "system" &&
    annotation.author.id === RETIRED_LINT_AUTHOR_ID
  )
}

function hasFeedback(annotation: Annotation): boolean {
  if (annotation.thread.some((message) => message.author.type !== "system")) {
    return true
  }
  // Reopening or editing a finding stamps the actor; the lint itself only
  // ever stamped its own identity.
  return (
    annotation.updatedBy !== undefined &&
    annotation.updatedBy !== RETIRED_LINT_AUTHOR_ID
  )
}

export async function retireLintAnnotations(
  options: { shouldStop?: () => boolean; pageSize?: number } = {}
): Promise<LintRetirementReceipt[]> {
  const shouldStop = options.shouldStop ?? (() => false)
  const pageSize = options.pageSize ?? PAGE_SIZE
  const receipts: LintRetirementReceipt[] = []
  for (const space of await listSpaces()) {
    if (shouldStop()) break
    const receipt: LintRetirementReceipt = {
      spaceId: space.id,
      resolved: [],
      keptWithFeedback: [],
      failed: [],
    }
    receipts.push(receipt)
    // Resolved findings leave the open listing, so each page starts after
    // the ones this pass deliberately left open.
    for (let skip = 0; !shouldStop(); ) {
      let annotations: Annotation[]
      let more: boolean
      try {
        const page = await listAnnotations(space.id, {
          labels: ["lint"],
          offset: skip,
          limit: pageSize,
        })
        annotations = page.annotations
        more = page.nextOffset !== undefined
      } catch (err) {
        console.error(`[lint-retirement] could not list annotations in ${space.id}:`, err)
        break
      }
      for (const annotation of annotations) {
        if (shouldStop()) break
        if (!isRetirable(annotation)) {
          skip += 1
          continue
        }
        if (hasFeedback(annotation)) {
          receipt.keptWithFeedback.push(annotation.id)
          skip += 1
          continue
        }
        try {
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
        } catch (err) {
          receipt.failed.push(annotation.id)
          skip += 1
          console.error(
            `[lint-retirement] could not resolve ${annotation.id} in ${space.id}:`,
            err
          )
        }
      }
      if (!more || annotations.length === 0) break
    }
  }
  return receipts.filter(
    (receipt) =>
      receipt.resolved.length > 0 ||
      receipt.keptWithFeedback.length > 0 ||
      receipt.failed.length > 0
  )
}
