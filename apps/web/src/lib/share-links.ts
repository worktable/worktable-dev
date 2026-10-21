import type {
  DocumentShareLinks,
  ShareLink,
  ShareLinkBlockedBy,
  ShareLinkLevel,
  SharerPolicy,
} from "@worktable/types"
import { formatArchiveDate } from "./lifetime"

// What the share dialog says about links (v2), and the expiries it offers.

const DAY_MS = 86_400_000

export const SHARE_LINK_LEVEL_LABELS: Record<ShareLinkLevel, string> = {
  view: "Can view",
  comment: "Can comment",
  use: "Can use",
}

const BLOCKED_LABELS: Record<ShareLinkBlockedBy, string> = {
  paused: "Paused",
  space: "Not allowed in this Space",
  sharer: "Its creator can’t share anymore",
  password: "Needs a password",
  level: "Not available in this version",
  "expiry-cap": "Past the longest expiry",
}

/** Why the reader can't make a link to this document. */
export function createBlockedMessage(
  reason: DocumentShareLinks["createBlockedBy"]
): string {
  switch (reason) {
    case "paused":
      return "Links are paused for this Worktable."
    case "space":
      return "Links aren’t allowed in this Space."
    case "sharer":
      return "You can’t make links in this Space."
    default:
      return "This document can’t be shared by link right now."
  }
}

/** Links that still open: neither revoked nor expired. */
export function openShareLinkCount(links: readonly ShareLink[]): number {
  return links.filter(
    (link) => link.status !== "revoked" && link.status !== "expired"
  ).length
}

function lastOpened(iso: string, now: number): string {
  const days = Math.floor((now - Date.parse(iso)) / DAY_MS)
  if (days < 1) return "Last opened today"
  if (days === 1) return "Last opened yesterday"
  if (days < 30) return `Last opened ${days} days ago`
  return `Last opened ${formatArchiveDate(iso)}`
}

export interface ShareLinkDetail {
  text: string
  /** This part is why the link no longer opens. */
  stopped?: true
}

/**
 * What a link's row says under its label, such as "Can view · Expires Nov 21
 * · Last opened 2 days ago".
 */
export function shareLinkDetails(
  link: ShareLink,
  now = Date.now()
): ShareLinkDetail[] {
  const parts: ShareLinkDetail[] = [
    { text: SHARE_LINK_LEVEL_LABELS[link.level] },
  ]
  if (link.status === "expired" && link.expiresAt) {
    parts.push({
      text: `Expired ${formatArchiveDate(link.expiresAt)}`,
      stopped: true,
    })
  } else if (link.expiresAt) {
    parts.push({ text: `Expires ${formatArchiveDate(link.expiresAt)}` })
  }
  if (link.status === "blocked" && link.blockedBy) {
    parts.push({ text: BLOCKED_LABELS[link.blockedBy], stopped: true })
  }
  if (link.hasPassword) parts.push({ text: "Password" })
  parts.push({
    text: link.lastUsedAt ? lastOpened(link.lastUsedAt, now) : "Not opened yet",
  })
  return parts
}

/**
 * An expiry choice: "never", a number of days from now, or "keep" to leave
 * an edited link's expiry as it is.
 */
export type ShareLinkExpiry = string

const EXPIRY_DAYS = [7, 30, 90]

/**
 * Expiries within the owner policy's longest one, plus the edited link's own
 * date. A longest expiry that isn't among them is offered itself.
 */
export function shareLinkExpiryChoices(
  policy: SharerPolicy | undefined,
  editing: ShareLink | null
): Array<{ value: ShareLinkExpiry; label: string }> {
  const cap = policy?.maxExpiryDays ?? null
  const days = EXPIRY_DAYS.filter((count) => cap === null || count <= cap)
  if (cap !== null && !days.includes(cap)) days.push(cap)
  return [
    ...(editing?.expiresAt
      ? [{ value: "keep", label: formatArchiveDate(editing.expiresAt) }]
      : []),
    ...(cap === null ? [{ value: "never", label: "Never" }] : []),
    ...days.map((count) => ({
      value: String(count),
      label: count === 1 ? "1 day" : `${count} days`,
    })),
  ]
}

/** The chosen expiry, or the longest offered when it isn't. */
export function allowedShareLinkExpiry(
  choice: ShareLinkExpiry,
  choices: ReadonlyArray<{ value: ShareLinkExpiry }>
): ShareLinkExpiry {
  return choices.some((option) => option.value === choice)
    ? choice
    : (choices.at(-1)?.value ?? "never")
}

/** The expiry to send: a time, null for never, undefined to leave it. */
export function shareLinkExpiresAt(
  choice: ShareLinkExpiry,
  now = Date.now()
): string | null | undefined {
  if (choice === "keep") return undefined
  if (choice === "never") return null
  return new Date(now + Number(choice) * DAY_MS).toISOString()
}
