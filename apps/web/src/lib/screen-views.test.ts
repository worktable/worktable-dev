import { afterEach, expect, it } from "bun:test"
import { getFreshBrowserCsrfToken } from "./http.ts"
import { noteScreen, screenOfRoute, sendScreens } from "./screen-views.ts"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

it("sends the screens a person moved through in one request, kinds only, with the session's CSRF token", async () => {
  const sent: Array<{ url: string; csrf: string | null; keepalive: boolean | undefined; body: unknown }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/gateway/session")) return Response.json({ csrfToken: "csrf-1" })
    sent.push({ url, csrf: new Headers(init?.headers).get("X-Worktable-CSRF"), keepalive: init?.keepalive, body: JSON.parse(String(init?.body)) })
    return new Response(null, { status: 204 })
  }) as typeof fetch
  await getFreshBrowserCsrfToken()

  for (const routeId of ["/", "/spaces/$spaceId/docs/$", "/spaces/$spaceId/docs/$", "/login", "/spaces/$spaceId/docs/$"])
    noteScreen(screenOfRoute(routeId))
  noteScreen("settings")
  // Moving around sends nothing; hiding the tab sends it all at once.
  expect(sent).toHaveLength(0)
  sendScreens()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ csrf: "csrf-1", keepalive: true })
  expect(sent[0]!.url.endsWith("/api/analytics/screens")).toBe(true)
  // A screen shown again after another counts again; staying on one doesn't.
  expect((sent[0]!.body as { screens: Array<{ screen: string }> }).screens.map((view) => view.screen)).toEqual(["home", "doc", "doc", "settings"])
  sendScreens()
  expect(sent).toHaveLength(1)

  // A refused send keeps its screens for the next one.
  let refuse = true
  const realSend = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (refuse) return new Response(null, { status: 503 })
    return realSend(input, init)
  }) as typeof fetch
  noteScreen("home")
  sendScreens()
  await new Promise((resolve) => setTimeout(resolve, 0))
  refuse = false
  noteScreen("records")
  sendScreens()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect((sent.at(-1)!.body as { screens: Array<{ screen: string }> }).screens.map((view) => view.screen)).toEqual(["home", "records"])
})
