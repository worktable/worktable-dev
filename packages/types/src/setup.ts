/**
 * Each person's own first steps in a Worktable. Items complete from things
 * Worktable sees happen, so the list never asks anyone to tick a box. The
 * person can skip inviting, which needs someone else.
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
  "agent-instructions",
  "first-task",
  "invite-team",
] as const

export type SetupItemId = (typeof SETUP_ITEM_IDS)[number]

/** Steps a person can pass over without doing them. */
export const SKIPPABLE_SETUP_ITEM_IDS = ["invite-team"] as const

/** Steps that complete in the person's own browser, such as copying a line. */
export const SELF_REPORTED_SETUP_ITEM_IDS = ["agent-instructions"] as const

/** When an item completed, and where, when there is a place to go back to. */
export interface SetupEvidence {
  at: string
  spaceId?: string
  path?: string
  /** The person chose to skip it. */
  skipped?: boolean
}

export interface PersonalSetup {
  items: Partial<Record<SetupItemId, SetupEvidence>>
  /** Getting Started is unpinned: no sidebar row and no line on Home. */
  hidden?: boolean
  /** A member has seen the welcome in the Space they joined. */
  welcomed?: boolean
}

export const EMPTY_PERSONAL_SETUP: PersonalSetup = { items: {} }
