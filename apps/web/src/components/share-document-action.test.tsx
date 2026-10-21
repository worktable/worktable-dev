import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ShareLink } from "@worktable/types"
import { formatArchiveDate } from "@/lib/lifetime"
import { ShareLinkList } from "./share-document-action"

const DAY = 86_400_000

function link(overrides: Partial<ShareLink>): ShareLink {
  return {
    id: "lnk_aaaaaaaaaaaaaaaaaaaaaa",
    spaceId: "space",
    documentId: "doc_plan",
    kind: "doc",
    path: "plan",
    title: "Plan",
    label: "",
    level: "view",
    createdBy: { id: "owner", name: "Owner" },
    createdAt: new Date(Date.now() - 10 * DAY).toISOString(),
    expiresAt: null,
    hasPassword: false,
    lastUsedAt: null,
    status: "active",
    tokenHint: "abcd",
    canManage: true,
    comments: {
      acceptComments: true,
      anonymousAllowed: false,
      showSharerName: false,
      visitorsSee: "own",
      autoPaused: false,
    },
    ...overrides,
  }
}

test("a document's links say what each allows, and only the one just made shows its URL", () => {
  const expires = new Date(Date.now() + 30 * DAY).toISOString()
  const expired = new Date(Date.now() - DAY).toISOString()
  const moved = link({
    expiresAt: expires,
    lastUsedAt: new Date(Date.now() - 2 * DAY - 60_000).toISOString(),
  })
  const board = link({
    id: "lnk_bbbbbbbbbbbbbbbbbbbbbb",
    label: "Board",
    expiresAt: expired,
    status: "expired",
    canManage: false,
  })
  const made = link({ id: "lnk_cccccccccccccccccccccc", label: "Acme" })
  const url =
    "https://share.example.test/s/ws/abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"

  const html = renderToStaticMarkup(
    <ShareLinkList
      links={[made, moved, board]}
      created={{ link: made, url }}
      editingId={null}
      disabled={false}
      onEdit={() => {}}
      onRevoke={() => {}}
      onCopied={() => {}}
    />
  )
  const text = html.replace(/<[^>]+>/g, "")

  expect(text).toContain(
    `Untitled linkCan view · Expires ${formatArchiveDate(expires)} · Last opened 2 days ago`
  )
  expect(text).toContain(
    `BoardCan view · Expired ${formatArchiveDate(expired)} · Not opened yet`
  )
  expect(text).toContain("AcmeCan view · Not opened yet")
  // A URL exists only in the response that made the link.
  expect(html.split(url)).toHaveLength(2)
  expect(text).toContain("Copy it now. It won’t be shown again.")
  // Only links the reader may manage have actions.
  expect(html).toContain('aria-label="Actions for Untitled link"')
  expect(html).not.toContain('aria-label="Actions for Board"')
})
