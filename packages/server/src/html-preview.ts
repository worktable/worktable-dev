import { createHash, randomUUID } from "node:crypto"
import {
  MAX_DOCUMENT_PREVIEW_BYTES,
  MAX_DOCUMENT_PREVIEW_PIXELS,
  type DocumentId,
  type WidgetFile,
} from "@worktable/types"
import type { Page } from "playwright-core"
import { withDocPathLock } from "./doc-path-lock.ts"
import { resolveDocAlias } from "./doc-aliases.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import {
  readRegisteredDocumentSourceLocked,
  registeredDocumentSourceRevision,
} from "./document-write-service.ts"
import { readWidgetDocument, withWidgetWriteLock } from "./widget-store.ts"
import { getWidgetVersion } from "./widget-version-store.ts"
import {
  readWidgetState,
  queryRecords,
  RecordQueryError,
} from "./record-store.ts"
import { hasScope } from "./token-store.ts"
import {
  applyWidgetTheme,
  injectWidgetHostStyles,
  injectWidgetRuntime,
} from "./widget-authoring.ts"
import {
  buildWidgetCsp,
  deniedWidgetQueryCollection,
  widgetRecordReadGuard,
  WidgetRecordAccessError,
} from "./widget-runtime-policy.ts"
import { previewFontVersion, fulfillPreviewFont } from "./preview-fonts.ts"
import { withPreviewPage } from "./document-preview-browser.ts"
import { productFontIssue } from "./product-fonts.ts"

export interface HtmlPreviewSnapshot {
  spaceId: string
  path: string
  documentId: DocumentId
  sourceRevision: string
  html: string
  permissions: WidgetFile["permissions"]
  state: Record<string, unknown>
  historical: boolean
}
export interface HtmlPreviewOptions {
  theme?: "light" | "dark"
  width?: number
  height?: number
  fullPage?: boolean
  clip?: { x: number; y: number; width: number; height: number }
  timeoutMs?: number
}
export interface HtmlPreviewDiagnostic {
  level: "warning" | "error" | "info"
  code: string
  message: string
}
export interface HtmlPreviewCapture {
  mimeType: "image/png"
  bytes: Uint8Array
  width: number
  height: number
  status: "complete" | "partial"
  diagnostics: HtmlPreviewDiagnostic[]
  stateFingerprint: string
  dataMode: "live-read-only" | "static-history"
  observedAt: string
  completedAt: string
  capturedAt: string
  rendererVersion: string
  fontVersion: string
}

/** Called while namespace and widget transaction locks are held. */
export async function freezeSavedHtmlPreviewSnapshotLocked(input: {
  spaceId: string
  path: string
  documentId: DocumentId
  html: string
  widget: WidgetFile
}): Promise<HtmlPreviewSnapshot> {
  return {
    spaceId: input.spaceId,
    path: input.path,
    documentId: input.documentId,
    sourceRevision: await registeredDocumentSourceRevision({
      documentId: input.documentId,
      path: input.path,
      format: { id: BUILTIN_DOCUMENT_FORMATS.html, sourceVersion: 1 },
      source: { kind: "file", relativePath: `docs/${input.path}.html` },
      bytes: new TextEncoder().encode(input.html),
    }),
    html: input.html,
    permissions: structuredClone(input.widget.permissions),
    state: structuredClone(await readWidgetState(input.spaceId, input.path)),
    historical: false,
  }
}

/** Called while namespace and widget transaction locks are held. */
export async function freezeHtmlPreviewSnapshotLocked(input: {
  spaceId: string
  path: string
  expectedRevision?: string
  versionId?: string
}): Promise<HtmlPreviewSnapshot> {
  const source = await readRegisteredDocumentSourceLocked(input)
  if (source.format.id !== BUILTIN_DOCUMENT_FORMATS.html)
    throw new Error("Document is not HTML")
  if (
    input.expectedRevision &&
    source.sourceRevision !== input.expectedRevision
  )
    throw Object.assign(
      new Error(
        "Document changed; read its current revision before requesting a preview"
      ),
      { code: "REVISION_CONFLICT" }
    )
  if (input.versionId) {
    const version = await getWidgetVersion(
      input.spaceId,
      source.path,
      input.versionId
    )
    if (!version) throw new Error("HTML document version not found")
    return {
      spaceId: input.spaceId,
      path: source.path,
      documentId: source.documentId,
      sourceRevision: `version:${input.versionId}:${version.after.contentHash}`,
      html: version.after.content.html,
      permissions: structuredClone(version.after.content.widget.permissions),
      state: {},
      historical: true,
    }
  }
  const document = await readWidgetDocument(input.spaceId, source.path)
  if (!document.data)
    throw new Error(document.error ?? "HTML document not found")
  const html = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)
  if (html !== document.data.html)
    throw Object.assign(
      new Error("HTML source changed while capturing preview; retry"),
      { code: "REVISION_CONFLICT" }
    )
  return {
    spaceId: input.spaceId,
    path: source.path,
    documentId: source.documentId,
    sourceRevision: source.sourceRevision,
    html,
    permissions: structuredClone(document.data.widget.permissions),
    state: structuredClone(await readWidgetState(input.spaceId, source.path)),
    historical: false,
  }
}

export async function freezeHtmlPreviewSnapshot(input: {
  spaceId: string
  path: string
  expectedRevision?: string
  versionId?: string
}): Promise<HtmlPreviewSnapshot> {
  return withDocPathLock(input.spaceId, async () => {
    const alias = await resolveDocAlias(input.spaceId, input.path)
    if (!alias.path) throw new Error(alias.error ?? "Document not found")
    return withWidgetWriteLock(input.spaceId, alias.path, () =>
      freezeHtmlPreviewSnapshotLocked({ ...input, path: alias.path! })
    )
  })
}

const ORIGIN = "https://worktable-preview.invalid"
const MAX_QUERIES = 64
const MAX_REPLY_BYTES = 2 * 1024 * 1024
const MAX_PIXELS = MAX_DOCUMENT_PREVIEW_PIXELS

interface BrokerRequest {
  path?: unknown
  method?: unknown
  body?: unknown
}
interface BrokerReply {
  ok: boolean
  status: number
  body: unknown
}
const failure = (status: number, code: string, error: string): BrokerReply => ({
  ok: false,
  status,
  body: { error, code },
})

/** The only data authority used by the preview frame. No generic HTTP proxy. */
export function createHtmlPreviewBroker(
  snapshot: HtmlPreviewSnapshot,
  scopes: string[]
) {
  const base = `/api/spaces/${encodeURIComponent(snapshot.spaceId)}/widgets/__document/${Buffer.from(snapshot.path, "utf8").toString("base64url")}`
  const queries = new Map<string, Promise<BrokerReply>>()
  let calls = 0
  let replyBytes = 0
  const bounded = (body: unknown): BrokerReply => {
    const bytes = Buffer.byteLength(JSON.stringify(body))
    replyBytes += bytes
    if (bytes > MAX_REPLY_BYTES || replyBytes > 8 * 1024 * 1024)
      return failure(
        413,
        "PREVIEW_DATA_LIMIT",
        "Preview data exceeds its capture budget"
      )
    return { ok: true, status: 200, body }
  }
  return async (request: BrokerRequest): Promise<BrokerReply> => {
    if (++calls > MAX_QUERIES)
      return failure(
        429,
        "PREVIEW_QUERY_LIMIT",
        "Preview data request limit reached"
      )
    if (snapshot.historical)
      return failure(
        403,
        "STATIC_HISTORY",
        "Historical previews do not execute live data requests"
      )
    if (
      !hasScope(scopes, "documents:read") &&
      !hasScope(scopes, "widgets:read")
    )
      return failure(
        403,
        "FORBIDDEN",
        "HTML preview requires document read authority"
      )
    if (typeof request.path !== "string" || request.path.length > 4096)
      return failure(400, "INVALID_REQUEST", "Invalid preview data request")
    let target: URL
    try {
      target = new URL(request.path, ORIGIN)
    } catch {
      return failure(400, "INVALID_REQUEST", "Invalid preview data request")
    }
    if (target.origin !== ORIGIN || target.search || target.hash)
      return failure(
        403,
        "PREVIEW_READ_ONLY",
        "Preview may only read this document's state and authorized Records"
      )
    const method = request.method === undefined ? "GET" : request.method
    if (target.pathname === `${base}/state` && method === "GET") {
      if (snapshot.permissions.state?.read === false)
        return failure(403, "FORBIDDEN", "Document does not permit state reads")
      return bounded({ state: structuredClone(snapshot.state) })
    }
    const suffix = target.pathname.startsWith(`${base}/records/`)
      ? target.pathname.slice(`${base}/records/`.length)
      : ""
    const match = /^([a-z0-9][a-z0-9-]*)\/query$/.exec(suffix)
    if (!match || method !== "POST")
      return failure(
        403,
        "PREVIEW_READ_ONLY",
        "Persistent writes and unsupported operations are disabled during preview"
      )
    if (!hasScope(scopes, "records:read"))
      return failure(
        403,
        "FORBIDDEN",
        "Records-backed preview requires records:read authority"
      )
    if (
      request.body !== undefined &&
      request.body !== null &&
      (typeof request.body !== "string" || request.body.length > 32768)
    )
      return failure(
        400,
        "INVALID_REQUEST",
        "Preview query body is too large or invalid"
      )
    let query: unknown
    try {
      query = request.body ? JSON.parse(request.body as string) : {}
    } catch {
      return failure(400, "INVALID_REQUEST", "Preview query body must be JSON")
    }
    const collection = match[1]!
    const key = `${collection}\0${JSON.stringify(query)}`
    const prior = queries.get(key)
    if (prior) return structuredClone(await prior)
    const pending = (async (): Promise<BrokerReply> => {
      try {
        const denied = await deniedWidgetQueryCollection(
          snapshot.spaceId,
          snapshot.permissions,
          collection,
          query
        )
        if (denied)
          return failure(
            403,
            "FORBIDDEN",
            `Document does not permit reading Records collection ${denied}`
          )
        const body = await queryRecords(snapshot.spaceId, collection, query, {
          authorizeCollection: widgetRecordReadGuard(snapshot.permissions),
        })
        return bounded(body)
      } catch (error) {
        if (error instanceof WidgetRecordAccessError)
          return failure(403, "FORBIDDEN", error.message)
        return failure(
          error instanceof RecordQueryError ? 400 : 500,
          "PREVIEW_QUERY_FAILED",
          error instanceof Error ? error.message : "Preview query failed"
        )
      }
    })()
    queries.set(key, pending)
    return structuredClone(await pending)
  }
}

function dimensions(options: HtmlPreviewOptions) {
  const width = options.width ?? 1024
  const height = options.height ?? 768
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 128 ||
    height < 128 ||
    width > 2048 ||
    height > 2048
  )
    throw new Error(
      "HTML preview viewport must be between 128 and 2048 pixels per dimension"
    )
  const clip = options.clip
  if (
    clip &&
    (!Object.values(clip).every(Number.isFinite) ||
      clip.x < 0 ||
      clip.y < 0 ||
      clip.width < 1 ||
      clip.height < 1 ||
      clip.x > 100_000 ||
      clip.y > 100_000 ||
      clip.width > width ||
      clip.height > height)
  )
    throw new Error(
      "HTML preview clip size must fit the viewport and use nonnegative document coordinates"
    )
  return { width, height }
}

function captureTimeout(options?: HtmlPreviewOptions): number {
  return Math.min(30_000, Math.max(250, options?.timeoutMs ?? 5_000))
}

/** Rendering boundary is also used by browser acceptance fixtures. */
export async function captureHtmlPreviewOnPage(
  page: Page,
  input: {
    snapshot: HtmlPreviewSnapshot
    scopes: string[]
    options?: HtmlPreviewOptions
    signal?: AbortSignal
  }
): Promise<HtmlPreviewCapture> {
  const snapshot = structuredClone(input.snapshot)
  const options = input.options ?? {}
  const viewport = dimensions(options)
  if (
    !hasScope(input.scopes, "documents:read") &&
    !hasScope(input.scopes, "widgets:read")
  )
    throw new Error("HTML preview requires document read authority")
  if (
    Buffer.byteLength(snapshot.html) +
      Buffer.byteLength(JSON.stringify(snapshot.state)) >
    8 * 1024 * 1024
  )
    throw new Error("HTML preview source exceeds its input budget")
  const timeoutMs = captureTimeout(options)
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  // Leave time to return a partial image when authored assets never settle.
  const readinessDeadline = deadline - Math.min(750, timeoutMs / 4)
  const observedAt = new Date(startedAt).toISOString()
  const remaining = (until = deadline) => {
    const milliseconds = until - Date.now()
    if (milliseconds <= 0)
      throw Object.assign(
        new Error("HTML preview exceeded its capture deadline"),
        { code: "PREVIEW_TIMEOUT" }
      )
    return milliseconds
  }
  const bounded = async <T>(
    operation: () => Promise<T>,
    until = deadline
  ): Promise<T> => {
    const milliseconds = remaining(until)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(
                  new Error("HTML preview exceeded its capture deadline"),
                  { code: "PREVIEW_TIMEOUT" }
                )
              ),
            milliseconds
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const diagnostics: HtmlPreviewDiagnostic[] = []
  const diagnostic = (
    code: string,
    message: string,
    level: HtmlPreviewDiagnostic["level"] = "warning"
  ) => {
    if (
      diagnostics.length < 40 &&
      !diagnostics.some(
        (item) => item.code === code && item.message === message
      )
    )
      diagnostics.push({ level, code, message: message.slice(0, 1000) })
  }
  const productFontFallback = productFontIssue()
  if (productFontFallback)
    diagnostic("preview_product_font_fallback", productFontFallback, "info")
  const broker = createHtmlPreviewBroker(snapshot, [...input.scopes])
  const binding = `preview_${randomUUID().replaceAll("-", "")}`
  let pending = 0
  let lastActivity = Date.now()
  let loadedDocument = false
  let complete = true
  await bounded(() => page.setViewportSize(viewport))
  await bounded(() =>
    page.emulateMedia({
      colorScheme: options.theme ?? "dark",
      reducedMotion: "reduce",
    })
  )
  page.on("framenavigated", (frame) => {
    if (
      loadedDocument &&
      frame.parentFrame() === page.mainFrame() &&
      frame.url() !== `${ORIGIN}/document`
    )
      diagnostic(
        "preview_navigation_blocked",
        "The document attempted to leave its captured source"
      )
  })
  page.on("pageerror", (error) =>
    diagnostic("runtime_error", error.message, "error")
  )
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().includes("Content Security Policy")
    )
      diagnostic(
        "preview_policy_blocked",
        "The preview content policy blocked a resource or operation"
      )
    if (
      message.type() === "error" &&
      /Failed to decode downloaded font|OTS parsing error/.test(message.text())
    )
      diagnostic(
        "preview_font_decode_failed",
        "A document font could not be decoded"
      )
  })
  await bounded(() =>
    page.exposeBinding(binding, async (source, message: unknown) => {
      if (
        source.frame !== page.mainFrame() ||
        !message ||
        typeof message !== "object"
      )
        return null
      const data = message as Record<string, unknown>
      if (data.type === "diagnostic") {
        diagnostic(
          typeof data.code === "string" ? data.code : "widget_diagnostic",
          typeof data.message === "string"
            ? data.message
            : "HTML runtime diagnostic",
          data.level === "error" ? "error" : "warning"
        )
        return null
      }
      if (data.type !== "request") return null
      pending++
      lastActivity = Date.now()
      try {
        const reply = await broker(data)
        if (!reply.ok) {
          const body = reply.body as { code: string; error: string }
          diagnostic(body.code, body.error)
        }
        return reply
      } finally {
        pending--
        lastActivity = Date.now()
      }
    })
  )
  const host = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe id="artifact" sandbox="${snapshot.historical ? "" : "allow-scripts"}" referrerpolicy="no-referrer" src="/document"></iframe><script>
const frame=document.getElementById('artifact');
window.addEventListener('message',async event=>{
 if(event.source!==frame.contentWindow||!event.data||typeof event.data!=='object')return;
 const d=event.data;
 if(d.type==='worktable.widget.diagnostic'&&d.diagnostic){const v=d.diagnostic;await window.${binding}({type:'diagnostic',code:v.code,message:v.message,level:v.level});return}
 if(d.type==='worktable.navigation.open-document'){frame.contentWindow.postMessage({type:'worktable.navigation.response',id:d.id,ok:false,status:403,body:{code:'PREVIEW_READ_ONLY',error:'Navigation is disabled during preview'}},'*');return}
 if(d.type!=='worktable.api.request'||typeof d.id!=='string'||d.id.length>256)return;
 const result=await window.${binding}({type:'request',path:d.path,method:d.method,body:d.body});
 if(result)frame.contentWindow.postMessage({type:'worktable.api.response',id:d.id,...result},'*');
});</script></body></html>`
  const html = snapshot.historical
    ? injectWidgetHostStyles(applyWidgetTheme(snapshot.html, options.theme))
    : injectWidgetRuntime(
        applyWidgetTheme(snapshot.html, options.theme),
        snapshot.spaceId,
        snapshot.path
      )
  await bounded(() =>
    page.route("**/*", async (route) => {
      const request = route.request()
      const url = request.url()
      if (
        request.method() === "GET" &&
        url === `${ORIGIN}/` &&
        request.frame() === page.mainFrame()
      ) {
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: host,
          headers: {
            "Content-Security-Policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'",
          },
        })
      } else if (
        request.method() === "GET" &&
        url === `${ORIGIN}/document` &&
        request.frame().parentFrame() === page.mainFrame() &&
        !loadedDocument
      ) {
        loadedDocument = true
        let csp = buildWidgetCsp(false, ORIGIN).replace(
          "connect-src 'self'",
          "connect-src 'none'"
        )
        if (snapshot.historical)
          csp = csp.replace("script-src 'unsafe-inline'", "script-src 'none'")
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: html,
          headers: { "Content-Security-Policy": csp },
        })
      } else if (
        request.method() === "GET" &&
        url.startsWith(`${ORIGIN}/worktable-preview/fonts/`) &&
        request.resourceType() === "font"
      ) {
        const bytes = await fulfillPreviewFont(
          new URL(url).pathname.replace("/worktable-preview", "")
        )
        if (bytes)
          await route.fulfill({
            contentType: new URL(url).pathname.endsWith(".woff")
              ? "font/woff"
              : "font/woff2",
            body: Buffer.from(bytes),
            headers: { "Access-Control-Allow-Origin": "*" },
          })
        else await route.abort("blockedbyclient")
      } else {
        diagnostic(
          "preview_network_blocked",
          "A network request or navigation was blocked during preview"
        )
        await route.abort("blockedbyclient")
      }
    })
  )
  if (snapshot.historical)
    diagnostic(
      "static_history",
      "Historical HTML is rendered as static markup; scripts and live data are disabled",
      "info"
    )
  if (!snapshot.historical && snapshot.permissions.network)
    diagnostic(
      "preview_network_disabled",
      "External network access is disabled during preview"
    )
  await bounded(
    () =>
      page.goto(`${ORIGIN}/`, {
        waitUntil: "domcontentloaded",
        timeout: remaining(readinessDeadline),
      }),
    readinessDeadline
  )
  const frame = page
    .frames()
    .find((item) => item.parentFrame() === page.mainFrame())
  if (!frame) throw new Error("HTML preview frame did not initialize")
  const settle = async () => {
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (async () => {
          await frame.waitForLoadState("domcontentloaded", {
            timeout: Math.max(1, readinessDeadline - Date.now()),
          })
          // Data responses can insert new text/images after the initial DOM event.
          // Recheck fonts/assets after the broker is quiet, not just before reads.
          for (;;) {
            remaining(readinessDeadline)
            while (pending || Date.now() - lastActivity < 150) {
              if (Date.now() >= readinessDeadline)
                throw new Error(
                  "HTML data did not settle before the capture deadline"
                )
              await new Promise((resolve) => setTimeout(resolve, 25))
            }
            const activity = lastActivity
            // Script-disabled historical frames cannot run requestAnimationFrame
            // callbacks. Poll their native loading state from the trusted host.
            let failedImages: number
            let failedFonts: number
            if (snapshot.historical) {
              const assets = await frame.evaluate(() => ({
                loading:
                  document.fonts.status === "loading" ||
                  Array.from(document.images).some((image) => !image.complete),
                failedImages: Array.from(document.images).filter(
                  (image) => image.complete && !image.naturalWidth
                ).length,
                failedFonts: Array.from(document.fonts).filter(
                  (font) => font.status === "error"
                ).length,
              }))
              if (assets.loading) {
                await new Promise((resolve) => setTimeout(resolve, 25))
                continue
              }
              failedImages = assets.failedImages
              failedFonts = assets.failedFonts
            } else {
              const assets = await frame.evaluate(async () => {
                // CSS selects only faces needed by current text and layout;
                // never load every declared face just to take a screenshot.
                await document.fonts.ready
                const images = Array.from(document.images)
                const results = await Promise.all(
                  images.map((image) =>
                    image.decode().then(
                      () => true,
                      () => false
                    )
                  )
                )
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve())
                  )
                )
                return {
                  failedImages: results.filter((result) => !result).length,
                  failedFonts: Array.from(document.fonts).filter(
                    (font) => font.status === "error"
                  ).length,
                  loadingFonts: document.fonts.status === "loading",
                }
              })
              // Authored paint callbacks can select another font after the
              // first ready promise resolved, including with font-display:swap.
              if (assets.loadingFonts) continue
              failedImages = assets.failedImages
              failedFonts = assets.failedFonts
            }
            if (failedFonts)
              diagnostic(
                "preview_font_load_failed",
                `${failedFonts} requested font face(s) failed to load; fallback text may differ`
              )
            if (failedImages)
              diagnostic(
                "preview_image_decode_failed",
                `${failedImages} image(s) could not be decoded`
              )
            if (pending === 0 && activity === lastActivity) break
          }
        })(),
        new Promise<never>((_, reject) => {
          settleTimer = setTimeout(
            () =>
              reject(
                new Error(
                  "HTML assets or data did not settle before the capture deadline"
                )
              ),
            Math.max(1, readinessDeadline - Date.now())
          )
        }),
      ])
    } catch (error) {
      complete = false
      diagnostic(
        "preview_timeout",
        error instanceof Error ? error.message : "HTML preview did not settle"
      )
    } finally {
      clearTimeout(settleTimer)
    }
  }
  await settle()
  if (options.fullPage && !options.clip) {
    const contentHeight = await bounded(() =>
      frame.evaluate(() =>
        Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0
        )
      )
    )
    const height = Math.max(
      viewport.height,
      Math.min(contentHeight, 4096, Math.floor(MAX_PIXELS / viewport.width))
    )
    if (height < contentHeight)
      diagnostic(
        "preview_clipped",
        "Full-page preview reached its pixel limit; request a focused viewport"
      )
    await bounded(() => page.setViewportSize({ width: viewport.width, height }))
    lastActivity = Date.now()
  }
  let clip = options.clip
  if (clip) {
    const scroll = await bounded(() =>
      frame.evaluate(({ x, y }) => {
        window.scrollTo({ left: x, top: y, behavior: "instant" })
        return { x: window.scrollX, y: window.scrollY }
      }, clip!)
    )
    clip = { ...clip, x: clip.x - scroll.x, y: clip.y - scroll.y }
    lastActivity = Date.now()
    if (
      clip.x + clip.width > viewport.width ||
      clip.y + clip.height > viewport.height
    )
      throw new Error(
        "HTML preview clip extends beyond the document's scrollable content"
      )
  }
  if (options.fullPage || options.clip) await settle()
  if (options.fullPage && !options.clip) {
    // The sandboxed document's viewport grows with its iframe. Viewport units
    // or resize handlers can therefore increase content height again. Do not
    // claim a complete full page when that second layout exceeds the image.
    const remainingOverflow = await bounded(() =>
      frame.evaluate(
        () =>
          Math.max(
            document.documentElement.scrollHeight,
            document.body?.scrollHeight ?? 0
          ) > window.innerHeight
      )
    )
    if (remainingOverflow)
      diagnostic(
        "preview_clipped",
        "Full-page content extends below the captured image after viewport resizing; request a focused clip to inspect the remaining content"
      )
  }
  const bytes = await bounded(() =>
    page.screenshot({
      type: "png",
      animations: "disabled",
      caret: "hide",
      ...(clip ? { clip } : {}),
      timeout: Math.min(3000, remaining()),
    })
  )
  if (bytes.byteLength > MAX_DOCUMENT_PREVIEW_BYTES)
    throw new Error("HTML preview image exceeds its output budget")
  return {
    mimeType: "image/png",
    bytes,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    status:
      complete && !diagnostics.some((item) => item.level !== "info")
        ? "complete"
        : "partial",
    diagnostics,
    stateFingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          state: snapshot.state,
          permissions: snapshot.permissions,
        })
      )
      .digest("hex"),
    dataMode: snapshot.historical ? "static-history" : "live-read-only",
    observedAt,
    completedAt: new Date().toISOString(),
    capturedAt: new Date().toISOString(),
    rendererVersion: "worktable-html-1/playwright-1.61.1",
    fontVersion: previewFontVersion(),
  }
}

export async function captureHtmlPreview(input: {
  snapshot: HtmlPreviewSnapshot
  scopes: string[]
  options?: HtmlPreviewOptions
  signal?: AbortSignal
}): Promise<HtmlPreviewCapture> {
  dimensions(input.options ?? {})
  const timeout = new AbortController()
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout.signal])
    : timeout.signal
  return withPreviewPage(
    "html",
    async (page) => {
      // Start the requested capture limit after worker admission/startup. The
      // pool separately bounds total queue/startup time and kills stuck JS.
      const timer = setTimeout(
        () =>
          timeout.abort(
            new DOMException("HTML capture deadline exceeded", "TimeoutError")
          ),
        captureTimeout(input.options)
      )
      try {
        return await captureHtmlPreviewOnPage(page, { ...input, signal })
      } finally {
        clearTimeout(timer)
      }
    },
    { signal }
  )
}
