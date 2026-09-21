import { createElement, lazy, useState, type ComponentType } from "react"

/** Reuse completed preloads without introducing another Suspense fallback. */
export function preloadableComponent<Props extends object>(
  loader: () => Promise<{ default: ComponentType<Props> }>
) {
  let resolved: ComponentType<Props> | undefined
  let pending: ReturnType<typeof loader> | undefined
  const preload = () => {
    pending ??= loader().then(
      (module) => {
        resolved = module.default
        return module
      },
      (error: unknown) => {
        pending = undefined
        throw error
      }
    )
    return pending
  }
  const Lazy = lazy(preload)
  function Preloadable(props: Props) {
    // Freeze the choice per mount: changing a live subtree from Lazy to its
    // resolved component could remount an editor and discard selection/state.
    const [Component] = useState(() => resolved ?? Lazy)
    return createElement(Component, props)
  }
  return { Component: Preloadable, preload }
}
