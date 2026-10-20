import { afterEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  pendingInvitationEmail,
  sendInvitationAgain,
  type Invited,
} from "@/lib/invite-people"
import type { InvitationEmailStatus } from "@/lib/team-api"
import { InviteResult } from "./invite-people"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const invited = (status: InvitationEmailStatus | null): Invited => ({
  email: "dana@example.test",
  id: "inv_1",
  url: "https://worktable.example.test/join?invite=inv_1",
  status,
})

function render(status: InvitationEmailStatus | null) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <InviteResult invited={invited(status)} onChange={() => {}} />
    </QueryClientProvider>
  )
}

test("an invitation that wasn't emailed says why, and offers Send again only where it can help", () => {
  const cases: Array<[InvitationEmailStatus | null, string | null, boolean]> = [
    ["failed", "Email didn’t send", true],
    ["unavailable", "Email unavailable right now", true],
    ["limited", "Email limit reached", false],
    ["not_allowed", "Can’t email this address here", false],
    [null, null, false],
  ]
  for (const [status, reason, retry] of cases) {
    const html = render(status)
    if (reason) expect(html).toContain(reason)
    expect(html.includes(">Send again</button>")).toBe(retry)
    expect(html).toContain(">Copy link</button>")
  }
  // Without email on this Worktable, the row is just the link.
  expect(render(null)).not.toMatch(/Email|Can’t/)
  const sent = render("sent")
  expect(sent).toContain(">Emailed<")
  expect(sent).not.toContain("Copy link")
})

test("sending again emails that invitation and returns its new status", async () => {
  const requests: Request[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(
      new Request(
        new URL(String(input), "https://worktable.example.test"),
        init
      )
    )
    return Response.json({ email: "sent" })
  }) as typeof fetch
  const next = await sendInvitationAgain(invited("failed"))
  expect(
    requests.map((request) => [request.method, new URL(request.url).pathname])
  ).toEqual([["POST", "/api/team/invitations/inv_1/email"]])
  expect(next).toEqual({ ...invited("failed"), status: "sent" })
})

test("Settings describes a pending invitation by its latest email", () => {
  // Emailed once, then a resend failed: the failure shows, and retrying is offered.
  expect(
    pendingInvitationEmail({ emailed: true, emailStatus: "failed" }, true)
  ).toEqual({
    detail: "Invited · Email didn’t send",
    send: "Send again",
  })
  expect(
    pendingInvitationEmail({ emailed: false, emailStatus: "limited" }, true)
  ).toEqual({
    detail: "Invited · Email limit reached",
    send: null,
  })
  expect(
    pendingInvitationEmail({ emailed: true, emailStatus: "sent" }, true)
  ).toEqual({
    detail: "Invited",
    send: "Send again",
  })
  expect(
    pendingInvitationEmail({ emailed: false, emailStatus: null }, false)
  ).toEqual({
    detail: "Invited",
    send: null,
  })
})
