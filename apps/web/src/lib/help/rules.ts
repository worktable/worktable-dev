/**
 * When a tip shows on its own. Plain functions over the person's stored help
 * state, so the rules are tested without a browser.
 */
import type {
  HelpEvidenceId,
  HelpState,
  PersonalSetup,
} from "@worktable/types/setup"
import type { HelpCondition, Tip } from "./registry"

export interface HelpContext {
  /** Help is on for this Worktable (Preview for now). */
  enabled: boolean
  /** When this browser session started; closed tips wait for a later one. */
  sessionStartedAt: string
  conditions: Partial<Record<HelpCondition, boolean>>
  evidence: PersonalSetup["helpEvidence"]
}

function isDone(tip: Tip, state: HelpState | undefined, evidence: HelpContext["evidence"]) {
  if (state?.doneAt) return true
  return Boolean(tip.doneWhen && evidence?.[tip.doneWhen as HelpEvidenceId])
}

/** Whether a tip may show now. */
export function tipMayShow(
  tip: Tip,
  state: HelpState | undefined,
  context: HelpContext
): boolean {
  if (!context.enabled) return false
  if (tip.onlyIf && !context.conditions[tip.onlyIf]) return false
  // A rewritten tip is new to everyone.
  const current = state && (state.version ?? 1) === tip.version ? state : undefined
  if (isDone(tip, current, context.evidence)) return false
  if (!current) return true
  if (current.optedOut) return false
  if (!current.closedAt) return true
  // Closed: it may come back, but only in a later session.
  if (tip.comesBack === 0) return false
  if (current.closedAt >= context.sessionStartedAt) return false
  if (tip.comesBack === 1) return current.shown < 2
  return true
}

/** Only tips that come back every time offer Don't Show Again. */
export function offersDontShowAgain(tip: Tip, state: HelpState | undefined): boolean {
  return tip.comesBack === "always" && (state?.shown ?? 0) >= 1
}

/**
 * Of the tips that want this screen, the one that shows: highest priority,
 * then the first to ask.
 */
export function pickTip<T extends { priority: number; order: number }>(
  candidates: readonly T[]
): T | null {
  let best: T | null = null
  for (const candidate of candidates) {
    if (
      !best ||
      candidate.priority > best.priority ||
      (candidate.priority === best.priority && candidate.order < best.order)
    )
      best = candidate
  }
  return best
}
