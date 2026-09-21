import { createContext, useContext } from "react"
import type { LucideIcon } from "lucide-react"

/** Provenance chip rendered in the breadcrumb next to the doc title. */
export interface PageMetaChip {
  /** "You" | "Agent" | "File" | … — from CATEGORY_LABELS. */
  label: string
  /** Bronze dot (agent presence) vs muted dot. */
  agent: boolean
  /** ISO timestamp of the last write, for the relative time. */
  updatedAtIso: string | null
  stale: boolean
  /** Newest version is a human edit or review checkpoint. */
  reviewed: boolean
  staleDetail?: string
}

export interface PageShareTarget {
  kind: "doc" | "html"
  spaceId: string
  artifactKey: string
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
  chip?: PageMetaChip
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

export interface PageMetaContextValue {
  pageMeta: PageMeta | null
  setPageMeta: (meta: PageMeta | null) => void
}

export const PageMetaContext = createContext<PageMetaContextValue | undefined>(
  undefined
)

export function usePageMeta() {
  const context = useContext(PageMetaContext)
  if (!context) {
    throw new Error("usePageMeta must be used within PageMetaContext")
  }
  return context
}
