/**
 * A passage a comment is about, found again by its words rather than by a
 * position, so it survives rewrites of the text around it. The page matches
 * it against the text on screen and the server against a Doc's Markdown;
 * both use this one rule so they agree on where a comment belongs.
 */
export interface PassageSelector {
  /** The selected text. */
  quote: string
  /** Text just before the quote, to tell repeated quotes apart. */
  prefix?: string
  /** Text just after the quote. */
  suffix?: string
}

export interface PassageMatch {
  /** Offsets into the searched text, end exclusive. */
  start: number
  end: number
  /** Exact when the quote is still there word for word. */
  match: "exact" | "fuzzy"
}

/** How much text either side of a quote a selector keeps. */
export const PASSAGE_CONTEXT_LENGTH = 32

/** Fewer words than this are too little to recognize once reworded. */
const FUZZY_MIN_WORDS = 4
/** Share of the quote's words a reworded passage must still have. */
const FUZZY_MIN_SHARE = 0.75

export function normalizePassageText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** The text and its context either side of one range, as a selector stores them. */
export function passageSelector(
  text: string,
  start: number,
  end: number
): PassageSelector {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - PASSAGE_CONTEXT_LENGTH), start),
    suffix: text.slice(end, end + PASSAGE_CONTEXT_LENGTH),
  }
}

/** Text with whitespace runs collapsed, and the offset each character came from. */
function collapse(text: string): { text: string; from: number[] } {
  const chars: string[] = []
  const from: number[] = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (/\s/.test(char)) {
      if (chars.length > 0 && chars[chars.length - 1] !== " ") {
        chars.push(" ")
        from.push(index)
      }
      continue
    }
    chars.push(char)
    from.push(index)
  }
  return { text: chars.join(""), from }
}

function sharedEnd(a: string, b: string): number {
  let length = 0
  while (
    length < a.length &&
    length < b.length &&
    a[a.length - 1 - length] === b[b.length - 1 - length]
  )
    length++
  return length
}

function sharedStart(a: string, b: string): number {
  let length = 0
  while (length < a.length && length < b.length && a[length] === b[length])
    length++
  return length
}

/** Lower case that keeps every character at its offset. */
function lowerInPlace(text: string): string {
  return Array.from(text, (char) => {
    const lower = char.toLowerCase()
    return lower.length === char.length ? lower : char
  }).join("")
}

/** The occurrence of `quote` whose surroundings best match the context. */
function bestOccurrence(
  text: string,
  quote: string,
  prefix: string,
  suffix: string
): number {
  let best = -1
  let bestScore = -1
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
    const before = text.slice(Math.max(0, at - prefix.length - 1), at).trimEnd()
    const after = text
      .slice(at + quote.length, at + quote.length + suffix.length + 1)
      .trimStart()
    const score = sharedEnd(before, prefix) + sharedStart(after, suffix)
    if (score > bestScore) {
      best = at
      bestScore = score
    }
  }
  return best
}

/**
 * Where a passage is in `text` now. A quote that appears more than once goes
 * to the place whose surrounding text matches best. A quote that is gone
 * matches a stretch of about its length that keeps most of its words, or
 * nothing.
 */
export function findPassage(
  text: string,
  selector: PassageSelector
): PassageMatch | null {
  const quote = normalizePassageText(selector.quote)
  if (!quote) return null
  const haystack = collapse(text)
  const prefix = normalizePassageText(selector.prefix ?? "")
  const suffix = normalizePassageText(selector.suffix ?? "")
  let at = bestOccurrence(haystack.text, quote, prefix, suffix)
  // A rewrite often only changes capitals, as when sentences are joined.
  if (at < 0)
    at = bestOccurrence(
      lowerInPlace(haystack.text),
      lowerInPlace(quote),
      lowerInPlace(prefix),
      lowerInPlace(suffix)
    )
  if (at >= 0) {
    return {
      start: haystack.from[at]!,
      end: haystack.from[at + quote.length - 1]! + 1,
      match: "exact",
    }
  }
  const fuzzy = findReworded(haystack.text, quote)
  if (!fuzzy) return null
  return {
    start: haystack.from[fuzzy.start]!,
    end: haystack.from[fuzzy.end - 1]! + 1,
    match: "fuzzy",
  }
}

interface Word {
  value: string
  start: number
  end: number
}

function words(text: string): Word[] {
  const out: Word[] = []
  for (const found of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    out.push({
      value: found[0].toLowerCase(),
      start: found.index,
      end: found.index + found[0].length,
    })
  }
  return out
}

/** The window of the quote's length that shares the most of its words. */
function findReworded(
  text: string,
  quote: string
): { start: number; end: number } | null {
  const wanted = words(quote)
  if (wanted.length < FUZZY_MIN_WORDS) return null
  const need = new Map<string, number>()
  for (const word of wanted) need.set(word.value, (need.get(word.value) ?? 0) + 1)
  const all = words(text)
  const size = wanted.length
  if (all.length < size) return null
  const have = new Map<string, number>()
  let shared = 0
  const add = (value: string) => {
    const count = have.get(value) ?? 0
    if (count < (need.get(value) ?? 0)) shared++
    have.set(value, count + 1)
  }
  const remove = (value: string) => {
    const count = have.get(value)! - 1
    have.set(value, count)
    if (count < (need.get(value) ?? 0)) shared--
  }
  let bestAt = -1
  let bestShared = 0
  for (let index = 0; index < all.length; index++) {
    add(all[index]!.value)
    if (index >= size) remove(all[index - size]!.value)
    if (index >= size - 1 && shared > bestShared) {
      bestShared = shared
      bestAt = index - size + 1
    }
  }
  if (bestAt < 0 || bestShared / size < FUZZY_MIN_SHARE) return null
  // Leave out words at either end that aren't the quote's.
  let first = bestAt
  let last = bestAt + size - 1
  while (first < last && !need.has(all[first]!.value)) first++
  while (last > first && !need.has(all[last]!.value)) last--
  return { start: all[first]!.start, end: all[last]!.end }
}
