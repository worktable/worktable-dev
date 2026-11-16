/**
 * Which Try Next cards a person has done, from what Worktable saw happen.
 * Shared by Home's Try Next and its row in Settings > Help.
 */
import type { PersonalSetup } from "@worktable/types/setup"
import { TRY_NEXT, type TryNextCard } from "./registry"

export interface TryNextStatus {
  card: TryNextCard
  done: boolean
}

export function tryNextStatus(
  setup: PersonalSetup,
  options: { canInvite: boolean }
): TryNextStatus[] {
  return TRY_NEXT.filter(
    (card) => card.id !== "invite-team" || options.canInvite
  ).map((card) => ({
    card,
    done:
      card.doneWhen === "invite-team"
        ? Boolean(setup.items["invite-team"] && !setup.items["invite-team"].skipped)
        : Boolean(setup.helpEvidence?.[card.doneWhen]),
  }))
}

export function tryNextProgress(statuses: TryNextStatus[]) {
  return {
    done: statuses.filter((status) => status.done).length,
    total: statuses.length,
  }
}
