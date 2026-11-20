import { useEffect, useState } from "react"
import { onOpenSearch } from "@/lib/search-open"
import SearchPalette, { type SearchState } from "./search-palette"

/**
 * Keeps search's place in the sidebar: it hears every way search is asked
 * for and remembers what was typed between openings.
 */
export function SearchHost() {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<SearchState>({
    query: "",
    kind: null,
    spaceId: null,
  })
  useEffect(() => onOpenSearch(() => setOpen(true)), [])
  return (
    <SearchPalette
      open={open}
      onOpenChange={setOpen}
      state={state}
      onStateChange={setState}
    />
  )
}
