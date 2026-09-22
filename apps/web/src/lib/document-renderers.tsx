import { lazy, type ComponentType } from "react"
import { preloadableComponent } from "@worktable/ui/lib/preloadable-component"
import type { DocumentRenderer } from "@worktable/types"

export interface DocumentRendererProps {
  spaceId: string
  documentPath: string
  formatId?: string
}

interface BrowserDocumentRendererRegistration {
  disposition: DocumentRenderer["disposition"]
  preload: (formatId: string) => Promise<unknown>
  component: ComponentType<DocumentRendererProps>
}

const loadDocRenderer = () => import("@/components/doc-document")
const loadHtmlRenderer = () => import("@/components/html-document")
const doc = preloadableComponent<DocumentRendererProps>(() =>
  loadDocRenderer().then((module) => ({ default: module.DocDocumentRenderer }))
)
const html = preloadableComponent<DocumentRendererProps>(() =>
  loadHtmlRenderer().then((module) => ({ default: module.HtmlDocumentRenderer }))
)

const preloadDocRenderer = (formatId: string) =>
  Promise.all([
    doc.preload(),
    loadDocRenderer().then((module) => module.preloadDocEditor(formatId)),
  ])

const DOCUMENT_RENDERERS: Readonly<
  Record<string, BrowserDocumentRendererRegistration>
> = {
  quickdraw: {
    disposition: "trusted-component",
    component: lazy(() => import("@/components/drawing-document")),
    preload: () => import("@/components/drawing-document"),
  },
  doc: {
    disposition: "trusted-component",
    preload: preloadDocRenderer,
    component: doc.Component,
  },
  html: {
    disposition: "opaque-sandbox",
    preload: html.preload,
    component: html.Component,
  },
}

/** Resolve only code-owned renderer keys with their fixed trust disposition. */
export function browserDocumentRenderer(
  renderer: DocumentRenderer
): BrowserDocumentRendererRegistration | null {
  const registration = DOCUMENT_RENDERERS[renderer.key]
  return registration?.disposition === renderer.disposition
    ? registration
    : null
}

/** Code hint only: route and renderer requests still validate the live path. */
export function preloadOpeningDocumentRenderer() {
  try {
    const opening = JSON.parse(
      document.getElementById("worktable-opening-data")?.textContent ?? "null"
    )
    if (opening?.pathname !== location.pathname) return
    const preload =
      opening.preloadKey === "rich-text"
        ? preloadDocRenderer("worktable.rich-text")
        : opening.preloadKey === "markdown"
          ? preloadDocRenderer("worktable.markdown")
          : opening.preloadKey === "html"
            ? html.preload()
            : undefined
    void preload?.catch(() => {})
  } catch {
    // A missing or malformed optional hint falls back to normal route loading.
  }
}
