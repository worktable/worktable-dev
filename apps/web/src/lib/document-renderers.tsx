import { lazy, type ComponentType, type LazyExoticComponent } from "react"
import type { DocumentRenderer } from "@worktable/types"

export interface DocumentRendererProps {
  spaceId: string
  documentPath: string
  formatId?: string
}

interface BrowserDocumentRendererRegistration {
  disposition: DocumentRenderer["disposition"]
  preload: (formatId: string) => Promise<unknown>
  component: LazyExoticComponent<ComponentType<DocumentRendererProps>>
}

const loadDocRenderer = () => import("@/components/doc-document")
const loadHtmlRenderer = () => import("@/components/html-document")

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
    preload: (formatId) =>
      loadDocRenderer().then((module) => module.preloadDocEditor(formatId)),
    component: lazy(() =>
      loadDocRenderer().then((module) => ({
        default: module.DocDocumentRenderer,
      }))
    ),
  },
  html: {
    disposition: "opaque-sandbox",
    preload: loadHtmlRenderer,
    component: lazy(() =>
      loadHtmlRenderer().then((module) => ({
        default: module.HtmlDocumentRenderer,
      }))
    ),
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
