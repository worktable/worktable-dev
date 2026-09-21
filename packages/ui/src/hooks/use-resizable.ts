import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

export interface UseResizableOptions {
  /**
   * Which edge of the pane the drag handle sits on. "right" for a left
   * sidebar (dragging right grows the pane), "left" for a right-side panel
   * (dragging left grows it).
   */
  edge: "left" | "right"
  /** Width in px used before any user resize and on double-click reset. */
  defaultSize: number
  minSize: number
  maxSize: number
  /** localStorage key; omit to skip persistence. */
  storageKey?: string
}

/** Step in px applied per arrow-key press on the focused handle. */
const KEYBOARD_STEP = 16

export function clampSize(size: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, size))
}

/**
 * Read a persisted size, falling back to the default when the key is absent,
 * unreadable, or holds a non-finite value. Out-of-range values clamp rather
 * than reset so a later min/max change keeps the user's intent.
 */
export function readStoredSize(
  storageKey: string | undefined,
  { defaultSize, minSize, maxSize }: Omit<UseResizableOptions, "edge">
): number {
  if (!storageKey) return defaultSize
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw === null) return defaultSize
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return defaultSize
    return clampSize(parsed, minSize, maxSize)
  } catch {
    return defaultSize
  }
}

/**
 * The live size is held OUTSIDE React, in a per-storage-key store read via
 * useSyncExternalStore. Holding it in useState looked equivalent but was not:
 * during the prerendered-shell boot of "/", React can discard a render
 * attempt after the useState initializer ran and re-commit with the default —
 * the persisted width silently reverted to the default on every home-route
 * load (observed live; refs survived while state was reset). An external
 * store is immune to attempt discards, and as a bonus two panes sharing a
 * storageKey stay in sync.
 */
export interface SizeStore {
  get: () => number
  set: (next: number) => void
  subscribe: (onChange: () => void) => () => void
}

export function createSizeStore(initial: number): SizeStore {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return
      value = next
      for (const onChange of listeners) onChange()
    },
    subscribe: (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
  }
}

const sharedSizeStores = new Map<string, SizeStore>()

export function getSharedSizeStore(
  storageKey: string,
  options: Omit<UseResizableOptions, "edge">
): SizeStore {
  let store = sharedSizeStores.get(storageKey)
  if (!store) {
    store = createSizeStore(readStoredSize(storageKey, options))
    sharedSizeStores.set(storageKey, store)
  }
  return store
}

interface DragState {
  pointerId: number
  startX: number
  startSize: number
}

/**
 * Drag-to-resize behavior for a pane with one draggable edge. Returns the
 * current size (px) to apply as an inline width, an `isResizing` flag call
 * sites use to suspend width transitions during the drag, and `handleProps`
 * to spread onto a ResizeHandle (or any element): pointer-capture drag,
 * double-click reset, arrow/Home/End keyboard resize, and separator ARIA.
 *
 * While a drag is live, `data-resizing` is set on <body>; globals.css keys
 * off it to disable pointer events on iframes (which would otherwise swallow
 * the drag) and suppress text selection.
 */
export function useResizable(options: UseResizableOptions) {
  const { edge, defaultSize, minSize, maxSize, storageKey } = options
  const localStoreRef = useRef<SizeStore | null>(null)
  const store = storageKey
    ? getSharedSizeStore(storageKey, options)
    : (localStoreRef.current ??= createSizeStore(defaultSize))
  const size = useSyncExternalStore(
    store.subscribe,
    store.get,
    () => defaultSize
  )
  const [isResizing, setIsResizing] = useState(false)
  const dragRef = useRef<DragState | null>(null)

  const persist = useCallback(
    (next: number) => {
      if (!storageKey) return
      try {
        localStorage.setItem(storageKey, String(Math.round(next)))
      } catch {
        // localStorage unavailable
      }
    },
    [storageKey]
  )

  const applySize = useCallback(
    (next: number) => {
      const clamped = clampSize(next, minSize, maxSize)
      store.set(clamped)
      return clamped
    },
    [store, minSize, maxSize]
  )

  // The body attribute is set synchronously in onPointerDown, not from an
  // effect: waiting for the React commit leaves a frame where a fast drag can
  // cross into a still-interactive iframe, whose (process-isolated) document
  // then steals the pointer stream and kills the drag. The effect only
  // guarantees removal if the handle unmounts mid-drag.
  useEffect(() => {
    if (!isResizing) return
    return () => document.body.removeAttribute("data-resizing")
  }, [isResizing])

  const endDrag = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    document.body.removeAttribute("data-resizing")
    setIsResizing(false)
    persist(store.get())
  }, [persist, store])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startSize: store.get(),
      }
      document.body.setAttribute("data-resizing", "")
      setIsResizing(true)
    },
    [store]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag || e.pointerId !== drag.pointerId) return
      const delta =
        edge === "right" ? e.clientX - drag.startX : drag.startX - e.clientX
      applySize(drag.startSize + delta)
    },
    [edge, applySize]
  )

  const onDoubleClick = useCallback(() => {
    persist(applySize(defaultSize))
  }, [applySize, defaultSize, persist])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      let next: number
      const grow = edge === "right" ? 1 : -1
      switch (e.key) {
        case "ArrowRight":
          next = store.get() + grow * KEYBOARD_STEP
          break
        case "ArrowLeft":
          next = store.get() - grow * KEYBOARD_STEP
          break
        case "Home":
          next = minSize
          break
        case "End":
          next = maxSize
          break
        default:
          return
      }
      e.preventDefault()
      persist(applySize(next))
    },
    [edge, minSize, maxSize, applySize, persist, store]
  )

  return {
    size,
    isResizing,
    setSize: applySize,
    handleProps: {
      role: "separator" as const,
      "aria-orientation": "vertical" as const,
      "aria-valuenow": Math.round(size),
      "aria-valuemin": minSize,
      "aria-valuemax": maxSize,
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
      onDoubleClick,
      onKeyDown,
      "data-resizing": isResizing ? "" : undefined,
    },
  }
}
