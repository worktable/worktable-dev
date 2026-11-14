import {
  libraryKey,
  skillTitle,
  type LibraryEntry,
  type LibraryRef,
  type SkillTexts,
} from "./library.ts"
import { diffLines, foldUnchanged, type DiffLine } from "./line-diff.ts"

// What the Library shows, worked out from what the server sent: the
// libraries there are, what each holds, what is pending and what changed lately.

/** A change that isn't live for agents yet: an agent's proposal or a draft. */
export type Waiting = "proposal" | "draft" | null

export const waitingOn = (
  entry: Pick<LibraryEntry, "removed" | "proposal" | "draft">
): Waiting =>
  entry.removed
    ? null
    : entry.proposal
      ? "proposal"
      : entry.draft
        ? "draft"
        : null

const byTitle = (a: LibraryEntry, b: LibraryEntry) =>
  skillTitle(a).localeCompare(skillTitle(b))

/** The views of the Library that aren't one library. */
export const VIEWS = ["pending", "removed"] as const
export type View = (typeof VIEWS)[number]

/** Where the Library is, from its address: `/library/<where>/<skill>`. */
export type LibraryPath =
  | { kind: "home" }
  | { kind: "view"; view: View }
  | { kind: "library"; key: string; skillId?: string }
  /** A skill named without its library, as links from elsewhere do. */
  | { kind: "skill"; skillId: string }

const LIBRARY_KEY = /^(worktable|space:.+|agent:.+)$/

export function parseLibraryPath(splat: string | undefined): LibraryPath {
  const [where, skillId] = (splat ?? "").split("/").filter(Boolean)
  if (!where) return { kind: "home" }
  if ((VIEWS as readonly string[]).includes(where) && !skillId)
    return { kind: "view", view: where as View }
  if (LIBRARY_KEY.test(where)) return { kind: "library", key: where, skillId }
  return { kind: "skill", skillId: where }
}

/** A library with skills in it: the Worktable's, a Space's or an agent's. */
export interface Place {
  key: string
  library: LibraryRef
  /** The Space's or agent's name; absent for the Worktable's, or when unknown. */
  name?: string
  count: number
}

const KIND_ORDER: Record<LibraryRef["kind"], number> = {
  worktable: 0,
  space: 1,
  agent: 2,
}

/**
 * Every library that holds a skill, the Worktable's first, then Spaces,
 * then agents, each kind by name; with how many changes are pending and how many skills went.
 */
export function placesOf(entries: LibraryEntry[]): {
  places: Place[]
  pending: number
  removed: number
} {
  const current = entries.filter((entry) => !entry.removed)
  const places = new Map<string, Place>()
  for (const entry of current) {
    const key = libraryKey(entry.library)
    const place = places.get(key) ?? {
      key,
      library: entry.library,
      name: entry.libraryName,
      count: 0,
    }
    place.count += 1
    places.set(key, place)
  }
  return {
    places: [...places.values()].sort(
      (a, b) =>
        KIND_ORDER[a.library.kind] - KIND_ORDER[b.library.kind] ||
        (a.name ?? "").localeCompare(b.name ?? "")
    ),
    pending: current.filter((entry) => waitingOn(entry)).length,
    removed: entries.length - current.length,
  }
}

/** The skills in one library, by title. */
export const skillsIn = (entries: LibraryEntry[], key: string) =>
  entries
    .filter((entry) => !entry.removed && libraryKey(entry.library) === key)
    .sort(byTitle)

/** Every change not yet live: agents' proposals, newest first, then drafts. */
export const pendingOf = (entries: LibraryEntry[]) =>
  entries
    .filter((entry) => waitingOn(entry))
    .sort(
      (a, b) =>
        Number(Boolean(b.proposal)) - Number(Boolean(a.proposal)) ||
        (b.proposal?.at ?? "").localeCompare(a.proposal?.at ?? "") ||
        byTitle(a, b)
    )

/** Skills removed lately, newest first. */
export const removedOf = (entries: LibraryEntry[]) =>
  entries
    .filter((entry) => entry.removed)
    .sort((a, b) => b.removed!.at.localeCompare(a.removed!.at))

/** The skills whose live version was saved last, newest first. */
export const recentOf = (entries: LibraryEntry[], count: number) =>
  entries
    .filter((entry) => !entry.removed && entry.live)
    .sort((a, b) => b.live!.savedAt.localeCompare(a.live!.savedAt))
    .slice(0, count)

// ---- What a change does to a skill's text ----

export type TextLine = DiffLine

export type TextPart =
  | { kind: "lines"; lines: TextLine[] }
  /** Unchanged lines kept out of sight until asked for. */
  | { kind: "fold"; lines: TextLine[] }

/**
 * A skill's text as lines: without the heading that repeats its title, and
 * without the blank lines a Doc ends on.
 */
function body(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n")
  if (/^#\s/.test(lines[0] ?? "")) {
    lines.shift()
    while (lines.length > 0 && lines[0]!.trim() === "") lines.shift()
  }
  return lines
}

const whole = (lines: string[], kind: TextLine["kind"]): TextPart[] => [
  { kind: "lines", lines: lines.map((text) => ({ kind, text })) },
]

/**
 * What a waiting change does to what agents have: the lines it drops and
 * adds, with unchanged stretches folded, or the whole text struck through
 * for a removal. Null when a text it needs can't be read.
 */
export function changeOf(
  entry: Pick<LibraryEntry, "proposal">,
  texts: SkillTexts
): TextPart[] | null {
  if (entry.proposal?.kind === "remove")
    return texts.live === null ? null : whole(body(texts.live), "removed")
  if (texts.next === undefined)
    return texts.live === null ? null : whole(body(texts.live), "same")
  if (texts.next === null) return null
  const next = body(texts.next)
  // A new skill, or one whose live text is lost, has nothing to compare with.
  if (texts.live === null) return whole(next, "same")
  const lines = diffLines(body(texts.live).join("\n"), next.join("\n"))
  if (!lines) return whole(next, "same")
  return foldUnchanged(lines).map((part) =>
    part.kind === "unchanged"
      ? { kind: "fold", lines: part.lines }
      : { kind: "lines", lines: part.lines }
  )
}
