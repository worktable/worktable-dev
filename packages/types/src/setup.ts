/**
 * Each person's own first steps in a Worktable. Items complete from things
 * Worktable sees happen, so the list never asks anyone to tick a box.
 */

/**
 * The seeded Getting Started Space keeps the starter Space's id, which
 * Desktop and the CLI wait for on first run. Its settings mark it, so a
 * Welcome Space from before stays as it was.
 */
export const GETTING_STARTED_SPACE_ID = "welcome"
export const GETTING_STARTED_SETTING = "gettingStarted"

export const SETUP_ITEM_IDS = [
  "join-space",
  "connect-agent",
  "first-task",
  "invite-team",
] as const

export type SetupItemId = (typeof SETUP_ITEM_IDS)[number]

/** When an item completed, and where, when there is a place to go back to. */
export interface SetupEvidence {
  at: string
  spaceId?: string
  path?: string
}

export interface PersonalSetup {
  items: Partial<Record<SetupItemId, SetupEvidence>>
  /** Getting Started is unpinned: no sidebar row and no line on Home. */
  hidden?: boolean
  /** A member has seen the welcome in the Space they joined. */
  welcomed?: boolean
}

export const EMPTY_PERSONAL_SETUP: PersonalSetup = { items: {} }
