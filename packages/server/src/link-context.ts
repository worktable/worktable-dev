// The sentence a link sits in, as people read it beside the link's source.
//
// Extractors wrap the link's own words in LINK_OPEN and LINK_CLOSE inside the
// plain text of its line or block. The context is the sentence holding those
// words, trimmed around the link when it is long, with the link's place in it
// so a reader can show which words link.

export const LINK_OPEN = "\u0001"
export const LINK_CLOSE = "\u0002"

const CONTEXT_MAX = 160
/** How much text to keep before the link when a sentence must be trimmed. */
const LEAD = 50

export interface LinkContext {
  text: string
  /** Where the link's words sit in `text`. */
  mark?: { start: number; length: number }
}

const sentences = new Intl.Segmenter("en", { granularity: "sentence" })

/** The sentence around the marked link in `marked`, trimmed to fit a row. */
export function sentenceContext(marked: string): LinkContext {
  const collapsed = marked.replace(/\s+/g, " ")
  const open = collapsed.indexOf(LINK_OPEN)
  const close = collapsed.indexOf(LINK_CLOSE, open + 1)
  const plain = collapsed.replaceAll(LINK_OPEN, "").replaceAll(LINK_CLOSE, "")
  if (open === -1 || close === -1) return { text: fit(plain.trim()) }
  const linkStart = open
  const linkEnd = close - 1

  // Every sentence the link's words touch, so a link across a sentence
  // break (or an abbreviation the segmenter splits at) stays whole.
  let from = -1
  let to = -1
  for (const { index, segment } of sentences.segment(plain)) {
    const end = index + segment.length
    if (end <= linkStart || index > Math.max(linkStart, linkEnd - 1)) continue
    if (from === -1) from = index
    to = end
  }
  if (from === -1) return { text: fit(plain.trim()) }

  const raw = plain.slice(from, to)
  const lead = raw.length - raw.trimStart().length
  const sentence = raw.trim()
  const start = linkStart - from - lead
  const length = linkEnd - linkStart
  if (sentence.length <= CONTEXT_MAX) {
    return { text: sentence, ...(length > 0 ? { mark: { start, length } } : {}) }
  }
  // Long: keep some lead-in, the link, and what follows, with ellipses.
  const windowStart = Math.max(
    0,
    Math.min(start - LEAD, sentence.length - CONTEXT_MAX)
  )
  const windowEnd = Math.min(sentence.length, windowStart + CONTEXT_MAX)
  const before = windowStart > 0 ? "…" : ""
  const text = `${before}${sentence.slice(windowStart, windowEnd).trim()}${windowEnd < sentence.length ? "…" : ""}`
  const shift = before.length - windowStart -
    (sentence.slice(windowStart, windowEnd).length -
      sentence.slice(windowStart, windowEnd).trimStart().length)
  const markStart = start + shift
  const visible = Math.min(length, text.length - markStart)
  return {
    text,
    ...(length > 0 && markStart >= 0 && visible > 0
      ? { mark: { start: markStart, length: visible } }
      : {}),
  }
}

function fit(text: string): string {
  return text.length <= CONTEXT_MAX ? text : `${text.slice(0, CONTEXT_MAX).trim()}…`
}
