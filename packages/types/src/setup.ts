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
  /** What the person has seen of each piece of help, by its id. */
  help?: Record<string, HelpState>
  /** Things Worktable saw happen that finish help, such as a link made. */
  helpEvidence?: Partial<Record<HelpEvidenceId, SetupEvidence>>
  /** The first agents seen working for this person, to notice a second one. */
  agentsSeen?: string[]
  /** Try Next is hidden from Home; Settings > Help brings it back. */
  tryNextHidden?: boolean
}

/**
 * Things that finish a piece of help when they happen. Each is recorded once,
 * by the server where it sees it, or by the browser where only it can.
 */
export const HELP_EVIDENCE_IDS = [
  "another-agent",
  "html-doc-made",
  "html-commented",
  "link-made",
  "note-to-agent",
  "records-edited",
  "rules-added",
  "temporary-kept",
  "thread-message",
  "skill-added",
] as const

export type HelpEvidenceId = (typeof HELP_EVIDENCE_IDS)[number]

/** Evidence only the person's browser can see, so they report it. */
export const SELF_REPORTED_HELP_EVIDENCE_IDS = ["rules-added"] as const

/** One piece of help as this person has met it. */
export interface HelpState {
  /** How many times it showed on its own. */
  shown: number
  /** When it last showed, to keep a closed tip away until a later session. */
  lastShownAt?: string
  closedAt?: string
  doneAt?: string
  /** Don't Show Again. */
  optedOut?: boolean
  /** The version of the tip they saw; a rewritten tip shows again. */
  version?: number
}

/** What a browser can say about a piece of help. */
export const HELP_EVENTS = ["shown", "closed", "done", "optOut", "reset"] as const
export type HelpEvent = (typeof HELP_EVENTS)[number]

/** Help ids are short slugs, so a stored setup stays small. */
export const HELP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/** At most this many help entries are kept per person. */
export const HELP_STATE_MAX = 200

export const EMPTY_PERSONAL_SETUP: PersonalSetup = { items: {} }
