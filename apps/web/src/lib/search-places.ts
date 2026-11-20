// The places search can take a person to by name: the shell's own pages and
// each Space. Matched in the browser as they type, so a place shows before
// any result does.

export interface SearchPlace {
  id: string
  name: string
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * The places whose name the query could be the start of: every word typed
 * begins a word of the name. In the order given, at most `limit`.
 */
export function matchPlaces<Place extends SearchPlace>(
  places: readonly Place[],
  query: string,
  limit = 4
): Place[] {
  const typed = words(query)
  if (typed.length === 0) return []
  const matches: Place[] = []
  for (const place of places) {
    const name = words(place.name)
    if (typed.every((word) => name.some((part) => part.startsWith(word)))) {
      matches.push(place)
      if (matches.length === limit) break
    }
  }
  return matches
}
