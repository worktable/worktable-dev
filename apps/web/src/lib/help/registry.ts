/**
 * Every piece of help Worktable shows, in one place: the concepts in How
 * Worktable Works, the tips that show on their own, the help icons, and Try
 * Next. Each line is written here once and read wherever it appears, so the
 * wording stays the same everywhere. Copy follows the agreed spec: fewest
 * words, said the way people talk.
 */
import type { HelpEvidenceId } from "@worktable/types/setup"

export const DOCS_URL = "https://docs.worktable.dev"

/** A page on the docs site. */
export function docsUrl(path: string): string {
  return `${DOCS_URL}/${path.replace(/^\/+/, "")}`
}

// ============================================================
// Concepts
// ============================================================

export const CONCEPT_IDS = [
  "worktable",
  "agents",
  "spaces",
  "docs",
  "html-docs",
  "drawings",
  "files",
  "records",
  "comments",
  "threads",
  "pending",
  "library",
  "temporary-docs",
  "versions",
  "share-links",
  "who-can-see-it",
  "agent-replies",
  "linked-work",
] as const

export type ConceptId = (typeof CONCEPT_IDS)[number]

/** What a concept needs to be shown at all. */
export type HelpCondition = "teams" | "links" | "files" | "library"

export interface Concept {
  id: ConceptId
  name: string
  group: "parts" | "behaviour"
  /** The line in How Worktable Works. */
  short: string
  /** The text in its first tip and its help icon. */
  full: string
  /** Its section on the docs site. */
  docs: string
  onlyIf?: HelpCondition
}

export const CONCEPTS: readonly Concept[] = [
  {
    id: "worktable",
    name: "Worktable",
    group: "parts",
    short: "Where your work and your agents meet.",
    full: "Your Worktable holds your Spaces. Every agent you connect works in it.",
    docs: "concepts/#worktable",
  },
  {
    id: "agents",
    name: "Agents",
    group: "parts",
    short: "Connect the agents you already use.",
    full: "Connect ChatGPT, Claude, Grok Bot or others. Each one works in the Spaces it can access.",
    docs: "concepts/#agents",
  },
  {
    id: "spaces",
    name: "Spaces",
    group: "parts",
    short: "Like a project, a client or a topic.",
    full: "A Space holds one area of work, whatever you want it to be. Agents work in the Spaces they can access.",
    docs: "concepts/#spaces",
  },
  {
    id: "docs",
    name: "Docs",
    group: "parts",
    short: "Notes, plans and research.",
    full: "Write in rich text or Markdown. You and your agents edit the same Doc.",
    docs: "concepts/#docs",
  },
  {
    id: "html-docs",
    name: "HTML Docs",
    group: "parts",
    short: "Pages you can click through.",
    full: "Comparisons, mockups, explainers, slideshows and tools, often built by your agents. They can use your Records.",
    docs: "concepts/#html-docs",
  },
  {
    id: "drawings",
    name: "Drawings",
    group: "parts",
    short: "Sketches and diagrams.",
    full: "Draw freehand or add shapes and images. Your agents can read and edit them too.",
    docs: "concepts/#drawings",
  },
  {
    id: "files",
    name: "Files",
    group: "parts",
    short: "Images, PDFs and spreadsheets.",
    full: "Add any file to a Space. Your agents can open it.",
    docs: "concepts/#files",
    onlyIf: "files",
  },
  {
    id: "records",
    name: "Records",
    group: "parts",
    short: "Tables of things that change one by one.",
    full: "Like tasks, leads or sources. Agents can add and update rows, and pages can use them.",
    docs: "concepts/#records",
  },
  {
    id: "comments",
    name: "Comments",
    group: "parts",
    short: "Comment on any line or any part of a page.",
    full: "Send a comment to a person or an agent, or leave it as a note.",
    docs: "concepts/#comments",
  },
  {
    id: "threads",
    name: "Threads",
    group: "parts",
    short: "Conversations with people and agents.",
    full: "A thread belongs to the whole Worktable or to one Space. In a group thread, @mention the agent you want.",
    docs: "concepts/#threads",
  },
  {
    id: "pending",
    name: "Pending",
    group: "parts",
    short: "Anything that needs you.",
    full: "Things waiting on you, like a request sent to you or a message that didn't get through.",
    docs: "concepts/#pending",
  },
  {
    id: "library",
    name: "Library",
    group: "parts",
    short: "What your team approved for agents to use.",
    full: "Skills and other material your team approved for its agents. Agents suggest changes, and someone approves them.",
    docs: "concepts/#library",
    onlyIf: "library",
  },
  {
    id: "temporary-docs",
    name: "Temporary Docs",
    group: "behaviour",
    short: "Most new Docs archive after a week untouched.",
    full: "This keeps your Spaces tidy. Archived Docs stay readable by your agents, and you can restore them. You or your agent can change the date, or keep a Doc for good.",
    docs: "concepts/#temporary-docs",
  },
  {
    id: "versions",
    name: "Versions",
    group: "behaviour",
    short: "Go back to an earlier version.",
    full: "Your edits and your agents' are saved as versions. Compare any two and restore one.",
    docs: "concepts/#versions",
  },
  {
    id: "share-links",
    name: "Share Links",
    group: "behaviour",
    short: "Anyone with the link sees it as it is now.",
    full: "Send a Doc or page to anyone. Links last 14 days unless you change it.",
    docs: "concepts/#share-links",
    onlyIf: "links",
  },
  {
    id: "who-can-see-it",
    name: "Who Can See It",
    group: "behaviour",
    short: "In a team, Spaces are shared unless you limit them.",
    full: "Choose who can open each Space, people and agents alike.",
    docs: "concepts/#who-can-see-it",
    onlyIf: "teams",
  },
  {
    id: "agent-replies",
    name: "Agent Replies",
    group: "behaviour",
    short: "Some agents answer on their own.",
    full: "Always-on agents like OpenClaw and Hermes answer any time. Others answer while Auto-reply is on. The rest see your message next time they're open.",
    docs: "concepts/#agent-replies",
  },
  {
    id: "linked-work",
    name: "Linked Work",
    group: "behaviour",
    short: "Docs, Records and pages can point to each other.",
    full: "Link one Doc from another. A Record can point to the Doc about it, and a page can show your Records.",
    docs: "concepts/#linked-work",
  },
]

const CONCEPTS_BY_ID = new Map(CONCEPTS.map((concept) => [concept.id, concept]))

export function concept(id: ConceptId): Concept {
  return CONCEPTS_BY_ID.get(id)!
}

/** The two groups in How Worktable Works, in order. */
export const CONCEPT_GROUPS = [
  { id: "parts", title: "What's in Worktable" },
  { id: "behaviour", title: "How It Behaves" },
] as const satisfies readonly { id: Concept["group"]; title: string }[]

// ============================================================
// Tips that show on their own
// ============================================================

/**
 * Why a tip shows by itself. Something that changed while the person was
 * away is a status, shown where it happened, never a tip.
 */
export type TipReason = "must-know" | "first-meeting"

export type TipDisplay = "card" | "hint" | "inline"

export interface Tip {
  id: string
  /** Raise it when the words change, so people see the new ones. */
  version: number
  reason: TipReason
  display: TipDisplay
  /** "Concept" in the band when it teaches one; "Tip" otherwise. */
  concept?: ConceptId
  title?: string
  text: string
  /** Evidence that finishes it besides being closed. */
  doneWhen?: HelpEvidenceId
  /**
   * How often a closed tip comes back, in a later session: 0, once (the
   * default), or every time. Only "always" tips offer Don't Show Again.
   */
  comesBack: 0 | 1 | "always"
  /** Wins over a lower one that wants the same screen. */
  priority: number
  onlyIf?: HelpCondition
  learnMore?: string
  /** Where the tip lives in the Tips list in Settings > Help. */
  where: string
}

export const TIPS = {
  temporaryDoc: {
    id: "temporary-doc",
    version: 1,
    reason: "must-know",
    display: "card",
    concept: "temporary-docs",
    title: "Temporary Docs",
    // {date} is the Doc's archive date.
    text: "This archives on {date} if no one touches it. Your agents can still read it, and you can restore it.",
    doneWhen: "temporary-kept",
    comesBack: 1,
    priority: 30,
    where: "A temporary Doc",
  },
  recordsMeet: {
    id: "records-meet",
    version: 1,
    reason: "first-meeting",
    display: "card",
    concept: "records",
    title: "Records",
    text: "Records are rows that change one by one. Agents can add and update them, and pages can use them.",
    doneWhen: "records-edited",
    comesBack: 0,
    priority: 20,
    learnMore: "guides/records/",
    where: "Records",
  },
  recordsView: {
    id: "records-view",
    version: 1,
    reason: "must-know",
    display: "hint",
    text: "Filters and sorting stay on this device. Copy the link to share this view.",
    comesBack: 0,
    priority: 25,
    where: "Records, after a sort or filter",
  },
  htmlComment: {
    id: "html-comment",
    version: 1,
    reason: "first-meeting",
    display: "hint",
    text: "Click any part of this page to comment on it.",
    doneWhen: "html-commented",
    comesBack: 0,
    priority: 20,
    where: "HTML Docs",
  },
  drawingMeet: {
    id: "drawing-meet",
    version: 1,
    reason: "first-meeting",
    display: "card",
    concept: "drawings",
    title: "Drawings",
    text: "Your agents can read and edit this. Ask one to add a diagram.",
    comesBack: 0,
    priority: 20,
    where: "Drawings",
  },
  fileMeet: {
    id: "file-meet",
    version: 1,
    reason: "first-meeting",
    display: "card",
    concept: "files",
    title: "Files",
    text: "Your agents can open files in this Space.",
    comesBack: 0,
    priority: 20,
    onlyIf: "files",
    where: "Files",
  },
  threadsMeet: {
    id: "threads-meet",
    version: 1,
    reason: "first-meeting",
    display: "card",
    concept: "threads",
    title: "Threads",
    text: "Talk with people and agents here. In a group, @mention the agent you want.",
    doneWhen: "thread-message",
    comesBack: 0,
    priority: 20,
    where: "Threads",
  },
  libraryMeet: {
    id: "library-meet",
    version: 1,
    reason: "first-meeting",
    display: "card",
    concept: "library",
    title: "Library",
    text: "What's here is approved for your team's agents to use, like skills.",
    doneWhen: "skill-added",
    comesBack: 0,
    priority: 20,
    onlyIf: "library",
    learnMore: "agents/skills/",
    where: "Library",
  },
  pendingMeet: {
    id: "pending-meet",
    version: 1,
    reason: "first-meeting",
    display: "hint",
    text: "Anything that needs you lands here.",
    comesBack: 0,
    priority: 15,
    where: "Home, Pending",
  },
} as const satisfies Record<string, Tip>

export type TipKey = keyof typeof TIPS
export const ALL_TIPS: readonly Tip[] = Object.values(TIPS)

// ============================================================
// Help icons
// ============================================================

export interface HelpIconEntry {
  concept: ConceptId
  /** A line about this place, shown above the concept's text. */
  line?: string
}

export const HELP_ICONS = {
  startAsTemporary: { concept: "temporary-docs" },
  archiving: {
    concept: "temporary-docs",
    line: "How many Docs archive each day. Click a day to keep one.",
  },
  pending: { concept: "pending" },
  versions: {
    concept: "versions",
    line: "Automatic versions get cleared out over time. Save one to keep it.",
  },
  shareLinks: { concept: "share-links" },
  spaceAccess: { concept: "who-can-see-it" },
  agentReplies: { concept: "agent-replies" },
  alwaysOn: { concept: "agent-replies" },
} as const satisfies Record<string, HelpIconEntry>

export type HelpIconKey = keyof typeof HELP_ICONS

/** The agent's own line under Agent Replies, by its app. */
export function agentReplyLine(agentName: string, kind: string): string | null {
  switch (kind) {
    case "session":
      return `${agentName} answers here while you have it open.`
    case "called":
      return `${agentName} answers any time.`
    case "chat":
    case "task":
      return `${agentName} answers while Auto-reply is on.`
    default:
      return null
  }
}

// ============================================================
// Welcome
// ============================================================

export interface WelcomeScreen {
  title: string
  line: string
}

export const WELCOME = {
  owner: {
    eyebrow: "Welcome to Worktable",
    screens: [
      {
        title: "Your agents share one place",
        line: "What ChatGPT saves, Claude can open and build on.",
      },
      {
        title: "Work stays after the chat",
        line: "Plans and research land in Spaces, where you and your agents find them later.",
      },
      {
        title: "Pages you can share",
        line: "Ask for a mockup, a comparison or an explainer, and send it to anyone with a link.",
      },
    ],
  },
  joiner: {
    // {team} is the Worktable's name.
    eyebrow: "Welcome to {team}",
    screens: [
      {
        title: "Your team's work is here",
        line: "Open a Space to catch up.",
      },
      {
        title: "Bring your own agents",
        line: "Connect yours and it can read and add to the team's work.",
      },
      {
        title: "Pages you can share",
        line: "Mockups, comparisons and explainers your team made. Send any of them with a link.",
      },
    ],
  },
} as const

/** The words inside the welcome's still pictures. */
export const WELCOME_PICTURES = {
  agents: {
    more: "+ more",
    doc: "Launch plan",
    wrote: "wrote this · Mon",
    added: "added Pricing · Tue",
  },
  space: {
    chat: "Here's a summary of the five competitors…",
    closed: "Closed · last week",
    name: "Atlas",
    rows: ["Overview", "Competitor research"],
    kept: "Still here",
  },
  page: {
    title: "Launch explainer",
    link: "Anyone with the link",
    copied: "Copied",
    commenter: "Lena",
    comment: "Can we see yearly too?",
  },
} as const

// ============================================================
// Try Next
// ============================================================

export const TRY_NEXT_IDS = [
  "another-agent",
  "interactive-page",
  "share-link",
  "note-to-agent",
  "agent-rules",
  "invite-team",
] as const

export type TryNextId = (typeof TRY_NEXT_IDS)[number]

export interface TryNextCard {
  id: TryNextId
  title: string
  /** {doc} is a recent Doc of the person's own. */
  line: string
  doneWhen: HelpEvidenceId | "invite-team"
}

export const TRY_NEXT: readonly TryNextCard[] = [
  {
    id: "another-agent",
    title: "Add Another Agent",
    line: "What one saves, the others can open and build on.",
    doneWhen: "another-agent",
  },
  {
    id: "interactive-page",
    title: "Ask for an Interactive Page",
    line: "Something you can click through and share.",
    doneWhen: "html-doc-made",
  },
  {
    id: "share-link",
    title: "Share a Link",
    line: "Send {doc} to anyone with a link. They can comment on it.",
    doneWhen: "link-made",
  },
  {
    id: "note-to-agent",
    title: "Leave a Note for Your Agent",
    line: "On {doc}. Your agent sees it next time it's open.",
    doneWhen: "note-to-agent",
  },
  {
    id: "agent-rules",
    title: "Add Worktable to Your Agent's Rules",
    line: "So your agents save here without being asked.",
    doneWhen: "rules-added",
  },
  {
    id: "invite-team",
    title: "Invite Your Team",
    line: "They see the same work, and so do their agents.",
    doneWhen: "invite-team",
  },
]

export const PAGE_KINDS = [
  { id: "compare", label: "A comparison" },
  { id: "mock", label: "A clickable mockup" },
  { id: "explain", label: "An explainer" },
  { id: "slides", label: "A slideshow" },
] as const

export type PageKind = (typeof PAGE_KINDS)[number]["id"]

/** The prompt to copy, built from the person's own Space and Doc. */
export function pagePrompt(
  kind: PageKind,
  where: { space?: string; doc?: string }
): string {
  const doc = where.doc
  const space = where.space
  switch (kind) {
    case "compare":
      return doc
        ? `Compare the options in ${doc} as an interactive page in Worktable. Let me weigh what matters and see what comes out ahead.`
        : "Make an interactive page in Worktable that compares the options I'm deciding between. Ask me what they are first."
    case "mock":
      return space
        ? `Make a clickable mockup for ${space} as a page in Worktable, so I can click through it and comment on any part.`
        : "Make a clickable mockup of what I'm working on as a page in Worktable, so I can click through it and comment on any part. Ask me what it is first."
    case "explain":
      return space
        ? `Explain how ${space} works as an interactive page in Worktable, with a diagram I can click through.`
        : "Explain something I'm working on as an interactive page in Worktable, with a diagram I can click through. Ask me what first."
    case "slides":
      return doc
        ? `Turn ${doc} into a short slideshow in Worktable that I can present and share.`
        : "Make a short slideshow in Worktable about what I'm working on, that I can present and share. Ask me what it's about first."
  }
}

export const NOTE_STARTERS = [
  { id: "missing", label: "What's missing here?", text: "What's missing here?" },
  { id: "shorter", label: "Can you make this shorter?", text: "Can you make this shorter?" },
  {
    id: "page",
    label: "Turn this into a page I can share.",
    text: "Turn this into a page I can share.",
  },
  { id: "own", label: "Write my own", text: "" },
] as const

export type NoteStarterId = (typeof NOTE_STARTERS)[number]["id"]

/** The line people paste into their agent's own rules. */
export const AGENT_RULES_LINE =
  "I keep my work in Worktable. When I ask you to write, plan, research or track something, save it in Worktable without me saying so, and look there for context before asking me."
