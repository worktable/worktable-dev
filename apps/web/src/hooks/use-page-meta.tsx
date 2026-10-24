import { createContext, useContext } from "react"
import type { LucideIcon } from "lucide-react"
import type { DocumentSharingSummary } from "@worktable/types"

export interface PageShareTarget {
  kind: "doc" | "html"
  spaceId: string
  artifactKey: string
  /** The document's links from its page. */
  links: DocumentSharingSummary
}

/**
 * The page's share target. The server sends a page's links only to people
 * who may share here or manage its links, including while the owner policy
 * holds links back, so the dialog can say why; without them the page offers
 * no Share. Takes the summary's fields so callers can depend on primitives.
 */
export function pageShareTarget(
  target: Omit<PageShareTarget, "links">,
  activeLinks: number | undefined,
  canCreate: boolean | undefined
): PageShareTarget | undefined {
  if (activeLinks === undefined || canCreate === undefined) return undefined
  return { ...target, links: { activeLinks, canCreate } }
}

export interface PagePrimaryAction {
  label: string
  icon?: LucideIcon
  pendingLabel?: string
  pending?: boolean
  disabled?: boolean
  onClick: () => void
}

export interface PageSecondaryAction {
  /** Full action name used for accessibility and the tooltip. */
  label: string
  /** Optional compact visible label; its presence renders an outline button. */
  displayLabel?: string
  /** A line under the name in the tooltip, for what the action changes. */
  description?: string
  icon: LucideIcon
  pending?: boolean
  disabled?: boolean
  onClick: () => void
}

export interface PageAnnotationsAction {
  count: number
  open: boolean
  onToggle: () => void
}

export interface PageOverflowAction {
  id: string
  label: string
  icon: LucideIcon
  onSelect: () => void
  disabled?: boolean
  tone?: "default" | "destructive"
  separatorBefore?: boolean
}

export interface PageMeta {
  /** Optional artifact details shown from the breadcrumb accessory. */
  updatedAtLabel?: string
  provenanceLabel?: string
  /**
   * The document this page shows, for its lifetime and pin controls. Pages
   * that show the lifetime chip themselves say so with `lifetimeInPage`.
   */
  document?: { spaceId: string; path: string; lifetimeInPage?: boolean }
  /** Cloud-only owner control for a read-only public link. */
  shareTarget?: PageShareTarget
  /** The single most important action for the open artifact. */
  primaryAction?: PagePrimaryAction
  /** A quiet page-level utility rendered as an icon in the shared header. */
  secondaryAction?: PageSecondaryAction
  /** Opens the annotations inspector for the open artifact. */
  annotations?: PageAnnotationsAction
  /** Ordered artifact actions rendered in the shared shell's overflow menu. */
  overflowActions?: PageOverflowAction[]
  /**
   * Display name for the last breadcrumb crumb when the URL slug isn't the
   * label (e.g. widgets, whose id is a path but whose name is human-chosen).
   */
  titleOverride?: string
  /** Display name for a parent breadcrumb whose URL segment is an id. */
  parentTitleOverride?: string
}

/**
 * The one action a narrow-screen header keeps. Every other page control
 * lives in the page menu.
 */
export function narrowHeaderAction(
  meta: PageMeta | null
): "primary" | "secondary" | null {
  if (meta?.primaryAction) return "primary"
  if (meta?.secondaryAction) return "secondary"
  return null
}

// Pages set their meta; the shell header reads it. Separate contexts keep a
// page that only sets meta from re-rendering whenever the header changes.
export const PageMetaContext = createContext<PageMeta | null>(null)

export const SetPageMetaContext = createContext<
  ((meta: PageMeta | null) => void) | undefined
>(undefined)

/** The open page's header meta. */
export function usePageMeta(): PageMeta | null {
  return useContext(PageMetaContext)
}

/** Set the open page's header meta, without subscribing to it. */
export function useSetPageMeta(): (meta: PageMeta | null) => void {
  const setPageMeta = useContext(SetPageMetaContext)
  if (!setPageMeta) {
    throw new Error("useSetPageMeta must be used within SetPageMetaContext")
  }
  return setPageMeta
}
