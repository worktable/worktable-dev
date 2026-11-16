/**
 * What Settings > Help lists in How Worktable Works: the ideas that apply to
 * this Worktable, the parts first and how they behave after, in one list.
 */
import { CONCEPTS, type Concept, type HelpCondition } from "./registry"

type Conditions = Partial<Record<HelpCondition, boolean>>

export function visibleConcepts(conditions: Conditions): Concept[] {
  return CONCEPTS.filter(
    (concept) => !concept.onlyIf || conditions[concept.onlyIf] === true
  )
}
