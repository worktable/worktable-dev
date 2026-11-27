import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
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
  /** Full action name used for accessibility and the tooltip. */
  label: string
  /** Optional compact visible label. */
  displayLabel?: string
  icon?: LucideIcon
  pendingLabel?: string
  pending?: boolean
  disabled?: boolean
  onClick: () => void
}

/**
 * A transient header action tied to the user's current context (such as a text
 * selection). Shown with its full label so it remains clear on narrow screens,
 * temporarily taking the header's primary action slot while active.
 */
export interface PageContextualAction {
  /** Full visible label, kept in full even on narrow screens. */
  label: string
  icon?: LucideIcon
  pendingLabel?: string
  pending?: boolean
  disabled?: boolean
  /**
   * Keep the current DOM selection/focus when pressed so pointerdown does not
   * clear a selection before click runs.
   */
  preserveSelection?: boolean
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

export type SetPageContextualAction = (
  owner: symbol,
  action: PageContextualAction | null
) => void

// Pages set their meta; the shell header reads it. Separate contexts keep a
// page that only sets meta from re-rendering whenever the header changes.
export const PageMetaContext = createContext<PageMeta | null>(null)

export const SetPageMetaContext = createContext<
  ((meta: PageMeta | null) => void) | undefined
>(undefined)

// Contextual actions use their own channel so transient UI (like text
// selection) only updates the header action slot without re-rendering
// breadcrumbs, the page menu, or the page itself.
export const PageContextualActionContext =
  createContext<PageContextualAction | null>(null)

export const SetPageContextualActionContext = createContext<
  SetPageContextualAction | undefined
>(undefined)

export interface OwnedPageContextualAction {
  owner: symbol
  action: PageContextualAction
}

/**
 * Resolve the next active contextual header action. Clearing only removes an
 * entry owned by the same caller so an unmounting component cannot wipe out a
 * newer caller's action across transitions.
 */
export function resolvePageContextualAction(
  current: OwnedPageContextualAction | null,
  owner: symbol,
  action: PageContextualAction | null
): OwnedPageContextualAction | null {
  if (action === null) {
    return current?.owner === owner ? null : current
  }
  if (current?.owner === owner && current.action === action) {
    return current
  }
  return { owner, action }
}

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

/** The open page's active contextual header action, if any. */
export function usePageContextualAction(): PageContextualAction | null {
  return useContext(PageContextualActionContext)
}

/**
 * Publish a transient contextual action to the shared app header.
 * Each caller owns its registration so unmounting cannot clear a newer
 * caller's action across transitions.
 */
export function useHeaderContextualAction(
  action: PageContextualAction | null
): void {
  const setContextualAction = useContext(SetPageContextualActionContext)
  const [owner] = useState(() => Symbol("header-contextual-action"))
  const latestOnClick = useRef(action?.onClick)
  useLayoutEffect(() => {
    latestOnClick.current = action?.onClick
  })
  const handleClick = useCallback(() => {
    latestOnClick.current?.()
  }, [])

  const active = action !== null
  const label = action?.label
  const icon = action?.icon
  const pendingLabel = action?.pendingLabel
  const pending = action?.pending
  const disabled = action?.disabled
  const preserveSelection = action?.preserveSelection

  const published = useMemo<PageContextualAction | null>(
    () =>
      active && label !== undefined
        ? {
            label,
            icon,
            pendingLabel,
            pending,
            disabled,
            preserveSelection,
            onClick: handleClick,
          }
        : null,
    [
      active,
      label,
      icon,
      pendingLabel,
      pending,
      disabled,
      preserveSelection,
      handleClick,
    ]
  )

  useEffect(() => {
    if (!setContextualAction) return
    setContextualAction(owner, published)
  }, [published, owner, setContextualAction])

  useEffect(() => {
    if (!setContextualAction) return
    return () => setContextualAction(owner, null)
  }, [owner, setContextualAction])
}
