// Where the Library is, from its address. Kept apart from the rest of the
// Library's model: the Library route reads it before the page loads, so it
// rides in the bundle every page loads.

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
