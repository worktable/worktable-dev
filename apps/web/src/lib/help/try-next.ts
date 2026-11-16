/**
 * Which Try Next cards a person has done, from what Worktable saw happen.
 * Shared by Home's Try Next and its row in Settings > Help.
 */
import type { HomeRun } from "@worktable/types"
import type { PersonalSetup } from "@worktable/types/setup"
import { TRY_NEXT, type TryNextCard, type TryNextId } from "./registry"

export interface TryNextStatus {
  card: TryNextCard
  done: boolean
}

/** Done for real: a skipped Getting Started step isn't. */
function stepDone(setup: PersonalSetup, id: "agent-instructions" | "invite-team") {
  return Boolean(setup.items[id] && !setup.items[id].skipped)
}

export function tryNextStatus(
  setup: PersonalSetup,
  options: {
    canInvite: boolean
    /** Share links work here. Without them there's no Share a Link. */
    links?: boolean
  }
): TryNextStatus[] {
  return TRY_NEXT.filter(
    (card) =>
      (card.id !== "invite-team" || options.canInvite) &&
      (card.id !== "share-link" || options.links !== false)
  ).map((card) => ({
    card,
    done:
      card.doneWhen === "invite-team"
        ? stepDone(setup, "invite-team")
        : Boolean(setup.helpEvidence?.[card.doneWhen]) ||
          // Copying the rules line in Getting Started is the same step.
          (card.id === "agent-rules" && stepDone(setup, "agent-instructions")),
  }))
}

export function tryNextProgress(statuses: TryNextStatus[]) {
  return {
    done: statuses.filter((status) => status.done).length,
    total: statuses.length,
  }
}

/** A Try Next card on Home, or the Getting Started step that leads it. */
export type HomeTryNextCard =
  | { kind: "setup"; id: "connect-agent"; done: false }
  | { kind: "card"; id: TryNextId; card: TryNextCard; done: boolean }

/**
 * Whether a Try Next card that is also a Getting Started step leads: the
 * rules step until it's done, and inviting once it was skipped.
 */
function leads(setup: PersonalSetup, id: TryNextId): boolean {
  if (id === "agent-rules") return !stepDone(setup, "agent-instructions")
  if (id === "invite-team") return Boolean(setup.items["invite-team"]?.skipped)
  return false
}

/**
 * Home's Try Next, in order: Getting Started steps that were skipped or not
 * done lead, so skipping setup never leaves Home empty. Connecting an agent
 * is Getting Started's own; the rest are Try Next cards moved up. Null when
 * every card is done.
 */
export function homeTryNext(
  setup: PersonalSetup,
  options: {
    canInvite: boolean
    links: boolean
    /** A Doc of the person's own to share or comment on; Home shows those cards only with one. */
    doc: boolean
  }
): { cards: HomeTryNextCard[]; done: number; total: number } | null {
  const statuses = tryNextStatus(setup, options).filter(
    ({ card }) =>
      options.doc || (card.id !== "share-link" && card.id !== "note-to-agent")
  )
  const progress = tryNextProgress(statuses)
  if (progress.done === progress.total) return null
  const leading: HomeTryNextCard[] = []
  const rest: HomeTryNextCard[] = []
  if (!setup.items["connect-agent"])
    leading.push({ kind: "setup", id: "connect-agent", done: false })
  for (const { card, done } of statuses) {
    const entry: HomeTryNextCard = { kind: "card", id: card.id, card, done }
    if (!done && leads(setup, card.id)) leading.push(entry)
    else rest.push(entry)
  }
  return { cards: [...leading, ...rest], ...progress }
}

/** Formats Try Next names as a Doc: not pages, drawings or files. */
const NOT_A_DOC = new Set(["worktable.html", "worktable.quickdraw", "worktable.file"])

/**
 * The person's most recent Space and Doc of their own, from Home's Latest:
 * work by them or an agent, outside Getting Started. Try Next's prompts and
 * lines use them.
 */
export function recentOwnWork(
  runs: readonly HomeRun[],
  options: { self?: string; skipSpace: (spaceId: string) => boolean }
): { spaceId?: string; doc?: { spaceId: string; path: string; title: string } } {
  let spaceId: string | undefined
  for (const run of runs) {
    if (options.skipSpace(run.spaceId)) continue
    if (run.actor.kind !== "agent" && run.actor.id !== options.self) continue
    spaceId ??= run.spaceId
    const doc = run.docs.find((item) => !NOT_A_DOC.has(item.formatId))
    if (doc)
      return {
        spaceId,
        doc: { spaceId: run.spaceId, path: doc.path, title: doc.title },
      }
  }
  return { spaceId }
}
