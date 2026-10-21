import { QueryClient } from "@tanstack/react-query"
import { documentQueryKeys } from "@/lib/documents-queries"
import { notePageLinks } from "@/lib/sharing-cache"
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ShareLink } from "@worktable/types"
import { formatArchiveDate } from "@/lib/lifetime"
import { ShareLinkList } from "./share-links-dialog"

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

test("link changes preserve the next expiry even when the active count stays the same", () => {
  const client = new QueryClient()
  const key = documentQueryKeys.page("space", "plan")
  client.setQueryData(key, {
    kind: "document",
    sharing: { activeLinks: 0, canCreate: true },
  })
  const read = () =>
    client.getQueryData<{
      sharing: { activeLinks: number; nextExpiry?: string }
    }>(key)!.sharing
  const later = new Date(Date.now() + 7 * DAY).toISOString()
  const sooner = new Date(Date.now() + DAY).toISOString()
  notePageLinks(client, "space", "plan", [link({ expiresAt: later })])
  expect(read()).toMatchObject({ activeLinks: 1, nextExpiry: later })
  notePageLinks(client, "space", "plan", [link({ expiresAt: sooner })])
  expect(read()).toMatchObject({ activeLinks: 1, nextExpiry: sooner })
  notePageLinks(client, "space", "plan", [
    link({ expiresAt: sooner, status: "revoked" }),
  ])
  expect(read().activeLinks).toBe(0)
  expect(read().nextExpiry).toBeUndefined()
})
