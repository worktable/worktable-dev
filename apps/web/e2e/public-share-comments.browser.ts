import { expect, test, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import {
  PUBLIC_SHARE_ASSET_PATHS,
  PUBLIC_SHARE_COMMENT_CHECK_PATH,
  renderPublicCommentCheckPage,
  renderPublicDocumentPage,
  renderPublicLivePage,
} from "../../../packages/ui/src/public-share-page"

const shareOrigin = "https://share.example.test"
const checkOrigin = "https://content.example.test"
const token = "T".repeat(43)
const link = "a".repeat(32)
const at = "2026-10-22T08:00:00.000Z"
const source = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url))
const icon = source("assets/brand/worktable-icon-filled.svg").toString()

interface Post {
  body: string
  requestId: string
  name?: string
  anonymous?: boolean
  visitor: string
}

interface Stored extends Post {
  id: string
}

/** Real renderer and scripts; policy, routing, storage and Turnstile are fixtures. */
async function fixture(page: Page, live = false) {
  const workspaceId = live ? "workspace /é".repeat(9) : "ws_cloud"
  const url = `${shareOrigin}/s/${encodeURIComponent(workspaceId)}/${token}`
  const state = {
    accepting: true,
    anonymousAllowed: false,
    visitorsSee: "own" as "own" | "all",
  }
  const posts: Post[] = []
  const stored: Stored[] = []
  const views: string[] = []
  const errors: string[] = []
  const parentReadable: boolean[] = []
  const outsideRequests: string[] = []
  const backend: {
    frames: number
    containment: boolean
    onPost: (post: Post) => Promise<"ok" | "error" | "uncertain">
  } = {
    frames: 0,
    containment: true,
    onPost: async () => "ok",
  }
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.text().startsWith("check-parent-readable:"))
      parentReadable.push(message.text().endsWith("true"))
  })
  await page.route("**/*", async (route) => {
    const request = route.request()
    const target = new URL(request.url())
    if (
      target.origin === shareOrigin &&
      target.pathname === new URL(url).pathname
    ) {
      const comments = {
        ...state,
        link,
        checkUrl: checkOrigin + PUBLIC_SHARE_COMMENT_CHECK_PATH,
      }
      const html = live
        ? renderPublicLivePage(
            { title: "Live report" },
            { url: "https://tool.example.test/running", poll: 5 },
            icon,
            comments
          )
        : renderPublicDocumentPage(
            {
              kind: "doc",
              title: "Review",
              format: "markdown",
              projectionHtml: "<h1>Review</h1>",
            },
            icon,
            comments
          )
      return route.fulfill({
        contentType: "text/html",
        body: html,
        headers: {
          "Referrer-Policy": "no-referrer",
          ...(backend.containment
            ? {
                "Content-Security-Policy": [
                  "default-src 'none'",
                  `script-src ${shareOrigin + PUBLIC_SHARE_ASSET_PATHS.comments} ${shareOrigin + PUBLIC_SHARE_ASSET_PATHS.live}`,
                  "style-src 'unsafe-inline'",
                  "img-src 'self'",
                  "font-src 'self'",
                  "connect-src 'self'",
                  `frame-src https://tool.example.test ${checkOrigin + PUBLIC_SHARE_COMMENT_CHECK_PATH}`,
                  "base-uri 'none'",
                  "form-action 'none'",
                ].join("; "),
              }
            : {}),
        },
      })
    }
    if (
      target.origin === checkOrigin &&
      target.pathname === PUBLIC_SHARE_COMMENT_CHECK_PATH
    )
      return route.fulfill({
        contentType: "text/html",
        body: renderPublicCommentCheckPage("test-widget", shareOrigin),
        headers: {
          "Content-Security-Policy": [
            "default-src 'none'",
            `script-src ${checkOrigin + PUBLIC_SHARE_ASSET_PATHS.commentCheck} https://challenges.cloudflare.com`,
            "frame-src https://challenges.cloudflare.com",
            "style-src 'unsafe-inline'",
            "connect-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            `frame-ancestors ${shareOrigin}`,
          ].join("; "),
        },
      })
    const scripts: Record<string, string> = {
      [PUBLIC_SHARE_ASSET_PATHS.comments]: "public-share-comments.js",
      [PUBLIC_SHARE_ASSET_PATHS.commentCheck]: "public-share-comment-check.js",
      [PUBLIC_SHARE_ASSET_PATHS.live]: "public-share-live.js",
    }
    if (scripts[target.pathname])
      return route.fulfill({
        contentType: "text/javascript",
        body: source(`packages/ui/src/${scripts[target.pathname]}`),
      })
    if (target.pathname === PUBLIC_SHARE_ASSET_PATHS.icon)
      return route.fulfill({ contentType: "image/svg+xml", body: icon })
    if (target.pathname.endsWith(".woff2")) {
      const name = target.pathname.endsWith("fraunces-variable-latin.woff2")
        ? "fraunces-variable-latin.woff2"
        : "general-sans-variable.woff2"
      return route.fulfill({
        contentType: "font/woff2",
        body: source(`apps/desktop/ui/fonts/${name}`),
      })
    }
    if (target.origin === "https://challenges.cloudflare.com") {
      if (target.pathname === "/test-widget-frame")
        return route.fulfill({
          contentType: "text/html",
          body: "<p>Human check</p>",
        })
      return route.fulfill({
        contentType: "text/javascript",
        body: `
        let readable = false;
        try { void window.parent.document.body; readable = true; } catch {}
        console.log("check-parent-readable:" + readable);
        window.turnstile = { render(node, options) {
          const challenge = document.createElement("iframe");
          challenge.src = "https://challenges.cloudflare.com/test-widget-frame";
          challenge.addEventListener("load", () => options.callback("test-human-token"));
          node.append(challenge); return "widget";
        } };
      `,
      })
    }
    if (target.origin === "https://tool.example.test") {
      backend.frames++
      return route.fulfill({
        contentType: "text/html",
        body: '<script>parent.postMessage({type:"worktable.navigation.handshake",navigationToken:"test-navigation-token"},"*")</script><h1>Running tool</h1><button onclick="this.textContent=\'Used tool\'">Use tool</button>',
      })
    }
    if (
      target.origin === shareOrigin &&
      target.pathname.endsWith("/comments")
    ) {
      const visitor = request.headers()["x-share-visitor"] ?? ""
      if (request.method() === "GET") {
        views.push(visitor)
        const comments = stored
          .filter(
            (row) => state.visitorsSee === "all" || row.visitor === visitor
          )
          .map((row) => ({
            id: row.id,
            name: row.name ?? null,
            body: row.body,
            receivedAt: at,
            mine: row.visitor === visitor,
            replies: [{ body: "Thanks for the feedback.", from: null, at }],
          }))
        return route.fulfill({ json: { ...state, comments } })
      }
      const post: Post = { ...request.postDataJSON(), visitor }
      posts.push(post)
      const outcome = await backend.onPost(post)
      if (outcome === "error")
        return route.fulfill({
          status: 400,
          json: { error: { code: "INVALID_REQUEST" } },
        })
      let row = stored.find(
        (item) => item.visitor === visitor && item.requestId === post.requestId
      )
      if (!row) {
        row = { ...post, id: `vc_${stored.length}` }
        stored.push(row)
      }
      return outcome === "uncertain"
        ? route.fulfill({ status: 502, json: { error: { code: "ERROR" } } })
        : route.fulfill({
            status: 201,
            json: {
              id: row.id,
              receivedAt: at,
              pass: "test-pass",
              passMaxAge: 7200,
            },
          })
    }
    if (target.origin === "https://attacker.example")
      outsideRequests.push(target.href)
    return route.fulfill({ status: 404, body: "" })
  })
  await page.goto(url)
  return {
    state,
    posts,
    stored,
    views,
    errors,
    parentReadable,
    outsideRequests,
    backend,
  }
}

test("mobile visitors recover, keep edited drafts and follow refreshed comment settings", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: "light" })
  const f = await fixture(page)
  const toggle = page.getByRole("button", { name: "Comment", exact: true })
  const text = page.getByLabel("Comment", { exact: true })
  const send = page.getByRole("button", { name: "Send", exact: true })
  await toggle.click()
  await expect(
    page.getByRole("checkbox", { name: "Comment anonymously" })
  ).toBeHidden()
  await page.getByLabel("Your name").fill("Casey")
  await text.fill("First draft")
  f.backend.onPost = async () => "error"
  for (let attempt = 0; attempt < 2; attempt++) {
    await send.click()
    await expect(send).toBeEnabled()
    await expect(page.locator(".comment-status")).toContainText("Couldn't send")
  }
  expect(f.posts[0]!.requestId).toBe(f.posts[1]!.requestId)
  f.backend.onPost = async () => "ok"
  await text.fill("Revised draft")
  await send.click()
  await expect(page.locator(".comment-list")).toContainText("Revised draft")
  expect(f.posts[2]!.requestId).not.toBe(f.posts[1]!.requestId)
  let release = () => {}
  f.backend.onPost = () =>
    new Promise((resolve) => {
      release = () => resolve("ok")
    })
  await text.fill("Submitted draft")
  await send.click()
  await expect.poll(() => f.posts.length).toBe(4)
  await text.fill("Next draft")
  release()
  await expect(page.locator(".comment-list")).toContainText("Submitted draft")
  await expect(text).toHaveValue("Next draft")
  await expect(page.locator(".comment-status")).toBeEmpty()
  f.state.accepting = false
  f.state.anonymousAllowed = true
  f.state.visitorsSee = "all"
  const outside =
    '<img src="https://attacker.example/pixel"> https://attacker.example/'
  f.stored.push({
    id: "vc_outside",
    body: outside,
    name: "Visitor",
    requestId: "outside",
    visitor: "different",
  })
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await toggle.click()
  await expect(page.locator(".comment-closed")).toBeVisible()
  await expect(page.locator(".comment-list")).toContainText(outside)
  await expect(page.locator(".comment-list a, .comment-list img")).toHaveCount(
    0
  )
  f.state.accepting = true
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await toggle.click()
  await expect(text).toBeVisible()
  await expect(text).toHaveValue("Next draft")
  await expect(
    page.getByRole("checkbox", { name: "Comment anonymously" })
  ).toBeVisible()
  await expect(page.locator(".comment-note")).toContainText("Other visitors")
  expect(f.parentReadable.length).toBeGreaterThan(0)
  expect(f.parentReadable.every((readable) => !readable)).toBe(true)
  expect(f.errors).toEqual([])
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: testInfo.outputPath("visitor-comments-mobile.png"),
    fullPage: true,
  })
})

test("a live tool keeps its state and a visitor can recover an uncertain submission", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" })
  const f = await fixture(page, true)
  const tool = page.frameLocator("main iframe")
  await tool.getByRole("button", { name: "Use tool" }).click()
  const toggle = page.getByRole("button", { name: "Comment", exact: true })
  await toggle.click()
  await page.getByLabel("Your name").fill("Casey")
  await page
    .getByLabel("Comment", { exact: true })
    .fill("Accepted but acknowledgement was lost")
  f.backend.onPost = async () => "uncertain"
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.locator(".comment-status")).toContainText("Couldn't send")
  await expect(tool.getByRole("button", { name: "Used tool" })).toBeVisible()
  expect(f.backend.frames).toBe(1)
  const visitor = f.posts[0]!.visitor
  await page.reload()
  await toggle.click()
  await expect(page.locator(".comment-list")).toContainText(
    "Accepted but acknowledgement was lost"
  )
  await expect(page.locator(".comment-list")).toContainText(
    "Thanks for the feedback."
  )
  expect(f.views.at(-1)).toBe(visitor)
  expect(f.parentReadable.every((readable) => !readable)).toBe(true)
  expect(f.errors).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath("visitor-comments-live.png"),
    fullPage: true,
  })
  // The trusted check endpoint does not admit authored navigation elsewhere.
  await page.evaluate(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      if (
        event.effectiveDirective === "frame-src" &&
        event.blockedURI.startsWith("https://attacker.example")
      )
        document.body.dataset.blockedNavigation = "true"
    })
  })
  await tool.locator("body").evaluate(() => {
    location.href = "https://attacker.example/record-data"
  })
  await expect(page.locator("body")).toHaveAttribute(
    "data-blocked-navigation",
    "true"
  )
  expect(f.outsideRequests).toEqual([])
  // Positive control: observing no request must depend on the parent policy.
  f.backend.containment = false
  await page.reload()
  await tool.locator("body").evaluate(() => {
    location.href = "https://attacker.example/record-data"
  })
  await expect
    .poll(() => f.outsideRequests)
    .toEqual(["https://attacker.example/record-data"])
})
