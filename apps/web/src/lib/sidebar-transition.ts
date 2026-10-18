import { flushSync } from "react-dom"

const SLIDE = { duration: 240, easing: "cubic-bezier(0.33, 1, 0.68, 1)" }
const FADE = { duration: 220, easing: "cubic-bezier(0.33, 1, 0.68, 1)" }

/**
 * Opens or closes part of the sidebar, then animates the change. The update
 * applies at once, so what opens renders a single time and shows without
 * waiting for a frame. Afterwards the rows below slide from where they were
 * to where they are, and the opened panel fades in. Both animate only
 * transform and opacity, which the browser runs on the compositor, so work
 * on the page after the update can't stutter them.
 *
 * `changing` is the collapsible that opens or closes. Everything after it
 * keeps its size, so each such block slides as one; the blocks that hold it
 * grow or shrink, so the walk goes inside them instead. With reduced motion
 * the update applies without animation.
 */
export function transitionSidebar(
  changing: Element,
  update: () => void,
  panel: () => Element | null
): void {
  const viewport = changing.closest('[data-slot="scroll-area-viewport"]')
  if (!viewport || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update()
    return
  }
  const bounds = viewport.getBoundingClientRect()
  const from = changing.getBoundingClientRect().top
  // Closing pulls up rows from below the fold by the open panel's height.
  const closing = collapsiblePanel(changing)?.getBoundingClientRect().height ?? 0
  const reach = bounds.bottom + closing

  // Where each block that can move sits now, mid-slide included.
  const blocks: { element: HTMLElement; top: number }[] = []
  const around = (container: Element) => {
    for (const child of container.children) {
      if (child === changing) continue
      if (child.contains(changing)) {
        around(child)
        continue
      }
      const box = child.getBoundingClientRect()
      // Blocks above the change don't move; blocks off screen aren't seen.
      if (box.height === 0 || box.bottom <= from) continue
      if (box.bottom < bounds.top || box.top > reach) continue
      if (child instanceof HTMLElement) blocks.push({ element: child, top: box.top })
    }
  }
  around(viewport)
  const before = collapsiblePanel(changing)
  const shown = before !== null && before.getBoundingClientRect().height > 0

  for (const { element } of blocks) cancelMotion(element)
  flushSync(update)

  for (const { element, top } of blocks) {
    if (!element.isConnected) continue
    const offset = top - element.getBoundingClientRect().top
    if (Math.abs(offset) < 0.5) continue
    element.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: "none" }],
      SLIDE
    )
  }
  const opened = panel()
  if (opened instanceof HTMLElement && !shown) {
    cancelMotion(opened)
    opened.animate(
      [
        { opacity: 0, transform: "translateY(-6px)" },
        { opacity: 1, transform: "none" },
      ],
      FADE
    )
  }
}

function cancelMotion(element: Element) {
  for (const animation of element.getAnimations()) animation.cancel()
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
