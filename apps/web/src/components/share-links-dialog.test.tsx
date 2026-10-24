import { QueryClient } from "@tanstack/react-query"
import { documentQueryKeys } from "@/lib/documents-queries"
import { notePageLinks } from "@/lib/sharing-cache"
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { LinkGrantSchema, type ShareLink } from "@worktable/types"
import { formatArchiveDate } from "@/lib/lifetime"
import { LiveDataPanel } from "./share-link-access"
import { DefaultLink, OtherLinkList } from "./share-links-dialog"

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
      autoPaused: false,
    },
    ...overrides,
  }
}

const text = (html: string) => html.replace(/<[^>]+>/g, "")

test("the default link offers its URL to copy, and says when it doesn't open", () => {
  const url =
    "https://share.example.test/s/ws/abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"
  const soon = new Date(Date.now() + 14 * DAY - 60_000).toISOString()
  const shown = renderToStaticMarkup(
    <DefaultLink
      link={link({ url, expiresAt: soon, hasPassword: true })}
      menu={null}
      onCopied={() => {}}
    />
  )
  expect(shown).toContain(`value="${url}"`)
  // Expiry and password have their own rows in the dialog.
  expect(text(shown)).toBe("Copy")

  const held = text(
    renderToStaticMarkup(
      <DefaultLink
        link={link({ url, status: "blocked", blockedBy: "paused" })}
        menu={null}
        onCopied={() => {}}
      />
    )
  )
  expect(held).toContain("Paused")

  // Links made before their URLs were kept can't be copied again.
  const sealed = text(
    renderToStaticMarkup(
      <DefaultLink link={link({})} menu={null} onCopied={() => {}} />
    )
  )
  expect(sealed).toContain("Make a new link to copy it again.")
})

test("other links say how each stands, and only the reader's own have menus", () => {
  const later = new Date(Date.now() + 40 * DAY).toISOString()
  const expired = new Date(Date.now() - DAY).toISOString()
  const board = link({
    label: "Board",
    hasPassword: true,
    expiresAt: later,
    lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
  })
  const old = link({
    id: "lnk_bbbbbbbbbbbbbbbbbbbbbb",
    label: "Old",
    expiresAt: expired,
    status: "expired",
    canManage: false,
  })
  const audit = link({
    id: "lnk_cccccccccccccccccccccc",
    label: "Audit",
    level: "comment",
    comments: { ...board.comments, autoPaused: true },
  })
  const html = renderToStaticMarkup(
    <OtherLinkList
      links={[board, old, audit]}
      editingId={null}
      form={null}
      menu={(_link, label) => <button aria-label={label} />}
    />
  )
  expect(text(html)).toContain(
    `BoardPassword · Expires ${formatArchiveDate(later)} · Opened today`
  )
  expect(text(html)).toContain(`OldExpired ${formatArchiveDate(expired)}`)
  expect(text(html)).toContain("AuditNever expires · Comments paused")
  expect(html).toContain('aria-label="Actions for Board"')
  expect(html).not.toContain('aria-label="Actions for Old"')
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

test("live data offers to remove a collection deleted since the link was saved", () => {
  const grant = LinkGrantSchema.parse({
    version: 1,
    collections: { "old-tasks": { fields: [] } },
  })
  const html = renderToStaticMarkup(
    <LiveDataPanel
      grant={grant}
      access={{
        grant,
        effectiveGrant: { ...grant, collections: {} },
        collections: {},
        counts: {},
        sentences: [],
        warnings: [],
        issues: [
          {
            collectionId: "old-tasks",
            message: "This collection is gone.",
          },
        ],
        stateReadable: true,
      }}
      checking={false}
      checkFailed={false}
      canTurnOn
      busy={false}
      url={undefined}
      onRetry={() => {}}
      onTurnOn={() => {}}
      onTurnOff={() => {}}
      onSaveGrant={async () => {}}
    />
  )
  expect(text(html)).toContain("This collection is gone.Remove")
})
