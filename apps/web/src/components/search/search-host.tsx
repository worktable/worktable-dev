import { lazy, Suspense, useEffect, useState } from "react"
import { onOpenSearch } from "@/lib/search-open"
import type { SearchState } from "./search-palette"

const SearchPalette = lazy(() => import("./search-palette"))

/**
 * Keeps search's place in the sidebar: it hears every way search is asked
 * for, remembers what was typed between openings, and loads search's own
 * code the first time it opens, if the idle preload hasn't already.
 */
export function SearchHost() {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [state, setState] = useState<SearchState>({
    query: "",
    kind: null,
    spaceId: null,
  })
  useEffect(
    () =>
      onOpenSearch(() => {
        setLoaded(true)
        setOpen(true)
      }),
    []
  )
  if (!loaded) return null
  return (
    <Suspense fallback={null}>
      <SearchPalette
        open={open}
        onOpenChange={setOpen}
        state={state}
        onStateChange={setState}
      />
    </Suspense>
  )
}
