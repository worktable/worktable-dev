/**
 * Which welcome a person gets, when it opens on its own, and how its keys
 * move through it. Kept apart from the copy, since the app shell loads it.
 */

/** Someone who made the Worktable, or someone joining its team. */
export type WelcomeRole = "owner" | "joiner"

export function welcomeRole(role: "owner" | "member" | undefined): WelcomeRole {
  return role === "member" ? "joiner" : "owner"
}

/**
 * Whether the welcome opens without being asked. Owners meet it over
 * Connect Your Agent during setup; people joining a team skip setup, so
 * they meet it in the app. Each person sees it once.
 */
export function welcomesOnItsOwn(options: {
  enabled: boolean
  welcomed: boolean | undefined
  role: "owner" | "member" | undefined
  where: "setup" | "app"
}): boolean {
  if (!options.enabled || options.welcomed || !options.role) return false
  return options.where === "setup"
    ? options.role !== "member"
    : options.role === "member"
}

export type WelcomeStep = "next" | "back" | "finish"

/**
 * Enter and the right arrow go forward, the left arrow back. Escape
 * finishes only on the last screen: there is no Skip, but nobody is held
 * there once they've seen it all.
 */
export function welcomeKey(
  key: string,
  at: number,
  count: number
): WelcomeStep | null {
  const last = at >= count - 1
  switch (key) {
    case "Enter":
    case "ArrowRight":
      return last ? "finish" : "next"
    case "ArrowLeft":
      return at > 0 ? "back" : null
    case "Escape":
      return last ? "finish" : null
    default:
      return null
  }
}
