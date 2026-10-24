import { expect, test } from "bun:test"
import { defaultSharingPolicy, type ShareLink } from "@worktable/types"
import { defaultShareLink, defaultShareLinkExpiry } from "./share-links"

const DAY = 86_400_000

function link(
  id: string,
  daysAgo: number,
  overrides: Partial<ShareLink> = {}
): ShareLink {
  return {
    id,
    spaceId: "space",
    documentId: "doc_plan",
    kind: "doc",
    path: "plan",
    title: "Plan",
    label: "",
    level: "view",
    createdBy: { id: "owner", name: "Owner" },
    createdAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
    expiresAt: null,
    hasPassword: false,
    lastUsedAt: null,
    status: "active",
    tokenHint: "abcd",
    canManage: true,
    comments: {
      acceptComments: true,
      autoPaused: false,
    },
    ...overrides,
  }
}

test("the default link is the oldest unlabelled one the reader can still hand out", () => {
  const paused = link("paused", 3, { status: "blocked", blockedBy: "paused" })
  const links = [
    link("newer", 1),
    link("labelled", 9, { label: "Board" }),
    link("revoked", 8, { status: "revoked" }),
    link("expired", 7, { status: "expired" }),
    link("theirs", 6, { canManage: false }),
    paused,
  ]
  // A link the owner policy holds back is still the one to show, with why.
  expect(defaultShareLink(links)).toBe(paused)
  expect(defaultShareLink(links.slice(1, 5))).toBeNull()
})

test("new links expire in two weeks, or sooner when the owner policy says so", () => {
  expect(defaultShareLinkExpiry(defaultSharingPolicy())).toBe("14")
  expect(
    defaultShareLinkExpiry({ ...defaultSharingPolicy(), maxExpiryDays: 7 })
  ).toBe("7")
})
