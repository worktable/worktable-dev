import { Hono } from "hono"
import {
  SHARE_CAPABILITY_HEADER,
  SHARE_PREVIEW_APPS,
  SHARE_UNLOCK_HEADER,
  SHARE_VIEW_BROWSERS,
  SHARE_VIEW_DEVICES,
  SHARE_VIEW_HEADERS,
  SHARE_VIEW_NETWORKS,
  ShareViewMessage,
} from "@worktable/hosted-contract"
import { cameThroughGateway, isHosted } from "../hosted.ts"
import { resolveShareLinkView } from "../share-link-views.ts"
import { ShareLinksStoreError } from "../share-links-store.ts"
import {
  recordSharePreview,
  recordShareView,
  type ShareViewVisitor,
} from "../share-views.ts"

const DIGEST = /^[a-f0-9]{32,64}$/
const COUNTRY = /^[A-Z]{2}$/
const MAX_BODY_BYTES = 512
const UNAVAILABLE = {
  error: "This link isn't available.",
  code: "LINK_UNAVAILABLE",
}

function oneOf<T extends string>(
  values: readonly T[],
  value: string | undefined
): T | null {
  return value !== undefined && (values as readonly string[]).includes(value)
    ? (value as T)
    : null
}

/**
 * Views of shared pages, as the gateway forwards them. Only the gateway may
 * call it: the visitor fields are the gateway's, never the page's. Views are
 * kept for links that would count them, which in this release are live HTML
 * links on Worktable Cloud.
 */
export function createPublicShareViewsRouter(): Hono {
  const router = new Hono()
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("X-Content-Type-Options", "nosniff")
    if (!cameThroughGateway(c.req.raw))
      return c.json({ error: "Forbidden", code: "GATEWAY_REQUIRED" }, 403)
    return next()
  })
  router.post("/", async (c) => {
    if (new URL(c.req.url).search) return c.json(UNAVAILABLE, 404)
    const length = Number(c.req.header("Content-Length") ?? NaN)
    if (!(length > 0 && length <= MAX_BODY_BYTES))
      return c.json(UNAVAILABLE, 404)
    let body: unknown
    try {
      const text = await c.req.text()
      body = text.length <= MAX_BODY_BYTES ? JSON.parse(text) : null
    } catch {
      body = null
    }
    const message = ShareViewMessage.safeParse(body)
    if (!message.success) return c.json(UNAVAILABLE, 404)

    let view: Awaited<ReturnType<typeof resolveShareLinkView>>
    try {
      view = await resolveShareLinkView(
        c.req.header(SHARE_CAPABILITY_HEADER) ?? "",
        { unlock: c.req.header(SHARE_UNLOCK_HEADER), revision: false }
      )
    } catch (error) {
      if (error instanceof ShareLinksStoreError) return c.json(UNAVAILABLE, 404)
      throw error
    }
    if (
      !view ||
      typeof view === "string" ||
      !countsViews(view.link)
    )
      return c.json(UNAVAILABLE, 404)

    if (message.data.kind === "preview") {
      const app = oneOf(
        SHARE_PREVIEW_APPS,
        c.req.header(SHARE_VIEW_HEADERS.PREVIEW)
      )
      if (!app) return c.json(UNAVAILABLE, 404)
      recordSharePreview(view.link.id, app)
      return c.json({ counted: false, first: false })
    }

    const visitor = c.req.header(SHARE_VIEW_HEADERS.VISITOR)
    const day = c.req.header(SHARE_VIEW_HEADERS.DAY)
    const country = c.req.header(SHARE_VIEW_HEADERS.COUNTRY)
    const seen: ShareViewVisitor = {
      visitor: visitor && DIGEST.test(visitor) ? visitor : null,
      day: day && DIGEST.test(day) ? day : null,
      country: country && COUNTRY.test(country) ? country : null,
      network: oneOf(SHARE_VIEW_NETWORKS, c.req.header(SHARE_VIEW_HEADERS.NETWORK)),
      browser: oneOf(SHARE_VIEW_BROWSERS, c.req.header(SHARE_VIEW_HEADERS.BROWSER)),
      device: oneOf(SHARE_VIEW_DEVICES, c.req.header(SHARE_VIEW_HEADERS.DEVICE)),
    }
    return c.json(recordShareView(view.link.id, message.data, seen))
  })
  router.all("*", (c) => c.json(UNAVAILABLE, 404))
  return router
}

/** Whether a link counts views: a live HTML link on Worktable Cloud, for now. */
export function countsViews(link: { kind: string; grant: unknown }): boolean {
  return isHosted() && link.kind === "html" && link.grant !== null
}
