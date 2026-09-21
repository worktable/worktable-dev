import { lazy, type ComponentType, type LazyExoticComponent } from "react"
import type { DocumentRenderer } from "@worktable/types"

export interface DocumentRendererProps {
  spaceId: string
  documentPath: string
}

interface BrowserDocumentRendererRegistration {
  disposition: DocumentRenderer["disposition"]
  component: LazyExoticComponent<ComponentType<DocumentRendererProps>>
}

const DOCUMENT_RENDERERS: Readonly<
  Record<string, BrowserDocumentRendererRegistration>
> = {
  quickdraw: {
    disposition: "trusted-component",
    component: lazy(() => import("@/components/drawing-document")),
  },
  doc: {
    disposition: "trusted-component",
    component: lazy(() =>
      import("@/routes/spaces/$spaceId/docs/$.tsx").then((module) => ({
        default: module.DocDocumentRenderer,
      }))
    ),
  },
  html: {
    disposition: "opaque-sandbox",
    component: lazy(() =>
      import("@/routes/spaces/$spaceId/widgets/$.tsx").then((module) => ({
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
