/**
 * What Settings > Help lists: the concepts and tips that apply to this
 * Worktable, and which tips the person has already seen.
 */
import type { HelpState } from "@worktable/types/setup"
import {
  ALL_TIPS,
  CONCEPTS,
  CONCEPT_GROUPS,
  type Concept,
  type HelpCondition,
  type Tip,
} from "./registry"

type Conditions = Partial<Record<HelpCondition, boolean>>

function applies(item: { onlyIf?: HelpCondition }, conditions: Conditions) {
  return !item.onlyIf || conditions[item.onlyIf] === true
}

/** How Worktable Works, in its two groups, without parts this one lacks. */
export function conceptGroups(
  conditions: Conditions
): { id: Concept["group"]; title: string; concepts: Concept[] }[] {
  return CONCEPT_GROUPS.map((group) => ({
    ...group,
    concepts: CONCEPTS.filter(
      (concept) => concept.group === group.id && applies(concept, conditions)
    ),
  })).filter((group) => group.concepts.length > 0)
}

export function visibleTips(conditions: Conditions): Tip[] {
  return ALL_TIPS.filter((tip) => applies(tip, conditions))
}

/** Seen once it has shown, or been closed or done. */
export function tipSeen(state: HelpState | undefined): boolean {
  return Boolean(state && (state.shown > 0 || state.closedAt || state.doneAt))
}
