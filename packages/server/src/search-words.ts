// ============================================================
// Words of a search, and the words a misspelled one meant
// ============================================================
//
// A search matches every word it is given, each as the start of a word
// in the text. A word that matches nothing as typed is searched as the
// nearest words the index holds instead: the index's own word list, by
// edits (a missing, extra or wrong letter, or two neighbours swapped).
// Short words take no edits, then one, then two, as Typesense rations
// them; measured on a real Worktable, the meant word was among the three
// nearest 97% of the time (research/2026-11-20-search-rework-claude).
// Words with digits or other marks (numbers, IDs, code) are never changed.

/** Letters from which a word may take one edit, and two. */
const ONE_EDIT_FROM = 4
const TWO_EDITS_FROM = 7
/** The nearest words a misspelled one is searched as. */
const NEAREST = 3

/**
 * A word as the index holds it: lower case, accents removed, as the
 * index's tokenizer (unicode61, remove_diacritics 2) folds it.
 */
export function foldWord(word: string): string {
  return word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

/** The words of a search, as typed, leaving out marks with no letters. */
export function searchWords(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
}

/** Edits a word may take: none when short, one, then two when long. */
export function editBudget(word: string): number {
  const length = [...word].length
  return length < ONE_EDIT_FROM ? 0 : length < TWO_EDITS_FROM ? 1 : 2
}

/** Whether a word may be corrected at all: letters only, long enough. */
export function correctable(folded: string): boolean {
  return /^\p{L}+$/u.test(folded) && editBudget(folded) > 0
}

/**
 * Optimal string alignment distance: edits, with a swap of neighbours as
 * one. Stops early, returning max + 1, once the distance must exceed max.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let before: number[] = []
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, before[j - 2]! + 1)
      }
      row.push(value)
      if (value < best) best = value
    }
    if (best > max) return max + 1
    before = previous
    previous = row
  }
  return previous[b.length]!
}

/** A word of the index's list, and how many items hold it. */
export interface IndexedWord {
  term: string
  docs: number
}

/** What a misspelled word is searched as: a whole word, or a word start. */
export interface NearWord {
  text: string
  prefix: boolean
}

/**
 * The nearest words to `word` (folded) in the index's list: closest first,
 * then the ones more items hold. With `prefix`, the word may be the start
 * of a longer word still being typed, so word starts are compared too.
 */
export function nearestWords(
  word: string,
  vocabulary: readonly IndexedWord[],
  prefix: boolean
): NearWord[] {
  const max = editBudget(word)
  if (max === 0) return []
  const found = new Map<string, NearWord & { distance: number; docs: number }>()
  const consider = (text: string, isPrefix: boolean, distance: number, docs: number) => {
    const key = `${isPrefix ? "*" : "="}${text}`
    const known = found.get(key)
    if (known && (known.distance < distance || (known.distance === distance && known.docs >= docs))) {
      return
    }
    found.set(key, { text, prefix: isPrefix, distance, docs })
  }
  for (const { term, docs } of vocabulary) {
    const whole = editDistance(word, term, max)
    if (whole <= max) consider(term, false, whole, docs)
    if (prefix && term.length > word.length) {
      const start = term.slice(0, word.length)
      const distance = editDistance(word, start, max)
      if (distance <= max && distance < whole) consider(start, true, distance, docs)
    }
  }
  return [...found.values()]
    .sort((a, b) => a.distance - b.distance || b.docs - a.docs)
    .slice(0, NEAREST)
    .map(({ text, prefix: isPrefix }) => ({ text, prefix: isPrefix }))
}

/** A phrase of the index's query language, matching `text` exactly. */
function phrase(text: string): string {
  return `"${text.replaceAll('"', '""')}"`
}

/** A word of a search, as the index's query matches it. */
export type QueryWord =
  | { word: string; as: "typed" }
  | { word: string; as: "nearest"; near: NearWord[] }

/** The index's query: every word, as typed (as a word start) or as its nearest words. */
export function indexQuery(words: readonly QueryWord[]): string {
  return words
    .map((word) =>
      word.as === "typed"
        ? `${phrase(word.word)}*`
        : `(${word.near.map((near) => `${phrase(near.text)}${near.prefix ? "*" : ""}`).join(" OR ")})`
    )
    .join(" AND ")
}
