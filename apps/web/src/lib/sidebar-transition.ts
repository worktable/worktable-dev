import { flushSync } from "react-dom"

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => {
    ready: Promise<void>
    finished: Promise<void>
  }
}

/** Whether sidebar trees open as view transitions in this browser. */
export const sidebarTransitions =
  typeof document !== "undefined" &&
  "startViewTransition" in document &&
  typeof CSS !== "undefined" &&
  CSS.supports("view-transition-name: none")

/** Undoes the markers of the transition in progress, if any. */
let settleCurrent: (() => void) | null = null

/**
 * Opens or closes part of the sidebar as a view transition. The browser
 * snapshots the rows on screen, the update builds the new tree, and then
 * the rows slide from their old place to their new one while the opened
 * panel fades in. The browser animates the snapshots on the compositor, so
 * building the tree can delay the motion but never stutter it.
 *
 * `changing` is the collapsible that opens or closes. Everything around it
 * keeps its size, so each such block slides as one; the blocks that hold
 * it grow or shrink, so the walk goes inside them instead. Without view
 * transitions, or with reduced motion, the update applies at once and the
 * panel's own height transition runs.
 */
export function transitionSidebar(
  changing: Element,
  update: () => void,
  panel: () => Element | null
): void {
  const start = (document as ViewTransitionDocument).startViewTransition
  if (
    !sidebarTransitions ||
    !start ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update()
    return
  }
  const viewport = changing.closest('[data-slot="scroll-area-viewport"]')
  const sidebar = changing.closest("[data-worktable-sidebar-root]")
  if (!viewport || !sidebar) {
    update()
    return
  }
  // A new transition replaces the one in progress; clear its markers first.
  settleCurrent?.()
  const bounds = viewport.getBoundingClientRect()
  const from = changing.getBoundingClientRect().top
  // Closing pulls up rows from below the fold by the open panel's height.
  const closing = collapsiblePanel(changing)?.getBoundingClientRect().height ?? 0
  const reach = bounds.bottom + closing
  const named: HTMLElement[] = []
  const name = (element: Element, kind: string) => {
    if (!(element instanceof HTMLElement)) return
    element.style.setProperty("view-transition-name", `sidebar-${named.length}`)
    element.style.setProperty("view-transition-class", kind)
    named.push(element)
  }
  const around = (container: Element) => {
    for (const child of container.children) {
      if (child.contains(changing)) {
        if (child === changing) {
          // Its row stays; an open panel fades out as it closes. A panel
          // built hidden ahead of opening takes no part until it shows.
          for (const part of child.children)
            if (part.getBoundingClientRect().height > 0)
              name(part, "sidebar-row")
        } else around(child)
        continue
      }
      const box = child.getBoundingClientRect()
      // Blocks above the change don't move; blocks off screen aren't seen.
      if (box.height === 0 || box.bottom <= from) continue
      if (box.bottom < bounds.top || box.top > reach) continue
      name(child, "sidebar-row")
    }
  }
  around(viewport)
  for (const cover of sidebar.querySelectorAll("[data-sidebar-motion-cover]"))
    name(cover, "sidebar-cover")
  // The scrollbar shows while the pointer is over the sidebar, but during
  // the transition the pointer is over the snapshots instead. Hold it while
  // it shows, and let its thumb glide to its new length with the rows.
  const area = viewport.closest('[data-slot="scroll-area"]')
  const held = area?.matches(":hover") ?? false
  if (area && held) {
    area.setAttribute("data-scrollbar-held", "")
    const thumb = area.querySelector('[data-slot="scroll-area-thumb"]')
    if (thumb) name(thumb, "sidebar-thumb")
  }

  // Only the sidebar's pieces take part: the page underneath stays live, so
  // a caret or drawing in the main view doesn't freeze, and the snapshot
  // covers the sidebar rather than the whole window.
  const root = document.documentElement
  root.setAttribute("data-sidebar-transition", "")

  const settle = () => {
    if (settleCurrent !== settle) return
    settleCurrent = null
    root.removeAttribute("data-sidebar-transition")
    area?.removeAttribute("data-scrollbar-held")
    for (const element of named) {
      element.style.removeProperty("view-transition-name")
      element.style.removeProperty("view-transition-class")
    }
  }
  settleCurrent = settle

  const transition = start.call(document, () => {
    flushSync(update)
    const opened = panel()
    if (opened && !named.includes(opened as HTMLElement))
      name(opened, "sidebar-panel")
  })
  // A second tap can cut a transition short; the update still applies.
  transition.ready.catch(() => undefined)
  void transition.finished.catch(() => undefined).finally(settle)
}

/** The open panel of a collapsible root, once it has rendered. */
export function collapsiblePanel(root: Element | null | undefined) {
  return (
    root?.querySelector(':scope > [data-slot="collapsible-content"]') ?? null
  )
}

/** A sidebar collapsible's onOpenChange that opens and closes it as above. */
export function transitionOpenChange(set: (open: boolean) => void) {
  return (open: boolean, details?: { event?: Event }) => {
    const target = details?.event?.target
    const root =
      target instanceof Element
        ? target.closest('[data-slot="collapsible"]')
        : null
    if (!root) return set(open)
    transitionSidebar(
      root,
      () => set(open),
      () => collapsiblePanel(root)
    )
  }
}
