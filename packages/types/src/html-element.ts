import { z } from "zod"

/**
 * An element of an HTML Doc a comment is about. Agents rewrite these pages,
 * so nothing here is a position: the element is found again by what it is
 * and where it sits, as a passage is found by its words. The page matches it
 * against the elements on screen and the server against the page as written;
 * both use matchHtmlElement so they agree on where a comment belongs.
 */
export const HtmlElementSchema = z.object({
  /** Lowercase tag name. */
  tag: z.string().min(1).max(40),
  id: z.string().min(1).max(200).optional(),
  classes: z.array(z.string().min(1).max(80)).max(6).optional(),
  /** Attributes that name the element: data-*, role, href, src, alt and the like. */
  attrs: z.record(z.string().max(40), z.string().max(160)).optional(),
  /** Text of the nearest ancestor that says more than the element does. */
  within: z.string().max(120).optional(),
  /** The last heading before the element. */
  heading: z.string().max(120).optional(),
  /** Tags from the body down, as `section#pricing > table > tr:nth-of-type(3)`. */
  path: z.string().min(1).max(600),
  /** Its opening tag as the browser had it. */
  html: z.string().max(300).optional(),
  /**
   * How far along the element's width the comment was pinned, from 0 to 1.
   * Places the pin only; it never helps find the element.
   */
  pin: z.number().min(0).max(1).optional(),
})

export type HtmlElement = z.infer<typeof HtmlElementSchema>

/** How much of an element's text a comment keeps as its quote. */
export const HTML_ELEMENT_QUOTE_LENGTH = 200

/** One element of a page, described the way a comment's element is. */
export interface HtmlElementCandidate {
  id?: string
  classes?: readonly string[]
  attrs?: Readonly<Record<string, string>>
  /** Its text, as far as HTML_ELEMENT_QUOTE_LENGTH. */
  text?: string
  within?: string
  heading?: string
  path: string
}

export interface HtmlElementMatch {
  index: number
  /** Exact when the element still reads the same. */
  match: "exact" | "fuzzy"
}

/**
 * Finds a comment's element among the page's elements with its tag. An
 * element that kept its id or its place and words is found outright; after a
 * rewrite the closest one is taken, and only when it is clearly closer than
 * the rest, so a comment is never moved to a look-alike.
 *
 * Self-contained: the HTML Doc runtime carries this function's source into
 * the page, where nothing else from this module exists.
 */
export function matchHtmlElement(
  anchor: HtmlElementCandidate,
  candidates: readonly HtmlElementCandidate[]
): HtmlElementMatch | null {
  const text = anchor.text ?? ""
  const same = (candidate: HtmlElementCandidate) =>
    (candidate.text ?? "") === text
  const found = (index: number): HtmlElementMatch => ({
    index,
    match: same(candidates[index]!) ? "exact" : "fuzzy",
  })

  if (anchor.id) {
    const withId = candidates.flatMap((candidate, index) =>
      candidate.id === anchor.id ? [index] : []
    )
    if (withId.length === 1) return found(withId[0]!)
  }
  const inPlace = candidates.flatMap((candidate, index) =>
    candidate.path === anchor.path &&
    same(candidate) &&
    (candidate.within ?? "") === (anchor.within ?? "")
      ? [index]
      : []
  )
  if (inPlace.length === 1) return found(inPlace[0]!)

  const pairs = (value: string) => {
    const out = new Map<string, number>()
    const lower = value.toLowerCase()
    for (let at = 0; at < lower.length - 1; at++) {
      const pair = lower.slice(at, at + 2)
      out.set(pair, (out.get(pair) ?? 0) + 1)
    }
    return out
  }
  /** Shared letter pairs, from 0 to 1: reworded text still scores. */
  const alike = (a: string, b: string) => {
    if (a === b) return 1
    if (a.length < 2 || b.length < 2) return 0
    const left = pairs(a)
    const right = pairs(b)
    let shared = 0
    for (const [pair, count] of left)
      shared += Math.min(count, right.get(pair) ?? 0)
    return (2 * shared) / (a.length - 1 + (b.length - 1))
  }
  /** How much of two paths agrees, from the body down and the element up. */
  const samePlace = (a: string, b: string) => {
    if (a === b) return 1
    const left = a.split(" > ")
    const right = b.split(" > ")
    const shorter = Math.min(left.length, right.length)
    let head = 0
    while (head < shorter && left[head] === right[head]) head++
    let tail = 0
    while (
      tail < shorter - head &&
      left[left.length - 1 - tail] === right[right.length - 1 - tail]
    )
      tail++
    return (head + tail) / Math.max(left.length, right.length)
  }
  const sameSet = (a: readonly string[], b: readonly string[]) => {
    if (a.length === 0 && b.length === 0) return 1
    const shared = a.filter((value) => b.includes(value)).length
    return shared / (a.length + b.length - shared)
  }
  const sameAttrs = (
    a: Readonly<Record<string, string>>,
    b: Readonly<Record<string, string>>
  ) => {
    const names = Object.keys(a)
    if (names.length === 0) return 1
    return names.filter((name) => a[name] === b[name]).length / names.length
  }
  // A word or a number says little about which element it is: "No" is in
  // every other cell. Short text counts for less, and less is then needed.
  const textWeight = 0.35 * Math.min(1, text.length / 12)
  const score = (candidate: HtmlElementCandidate) => {
    const around = alike(anchor.within ?? "", candidate.within ?? "")
    // What surrounds it tells look-alikes apart, as the text either side of
    // a quote does: the same button in another row is another element.
    if (anchor.within && candidate.within && around < 0.75) return 0
    return (
      textWeight * alike(text, candidate.text ?? "") +
      0.2 * around +
      0.15 * samePlace(anchor.path, candidate.path) +
      0.1 * ((anchor.heading ?? "") === (candidate.heading ?? "") ? 1 : 0) +
      0.1 * sameSet(anchor.classes ?? [], candidate.classes ?? []) +
      0.1 * sameAttrs(anchor.attrs ?? {}, candidate.attrs ?? {})
    )
  }

  let best = -1
  let bestScore = 0
  let nextScore = 0
  for (let index = 0; index < candidates.length; index++) {
    const value = score(candidates[index]!)
    if (value > bestScore) {
      nextScore = bestScore
      bestScore = value
      best = index
    } else if (value > nextScore) nextScore = value
  }
  // Close enough to be it, and clear of the runner-up: two look-alikes are
  // a miss, not a guess.
  if (
    best < 0 ||
    bestScore < 0.6 * (textWeight + 0.65) ||
    bestScore - nextScore < 0.05
  )
    return null
  return found(best)
}

const ELEMENT_NAMES: Record<string, string> = {
  img: "Image",
  picture: "Image",
  svg: "Graphic",
  canvas: "Graphic",
  video: "Video",
  audio: "Audio",
  table: "Table",
  tr: "Row",
  td: "Cell",
  th: "Cell",
  button: "Button",
  a: "Link",
  input: "Field",
  select: "Field",
  textarea: "Field",
  form: "Form",
  ul: "List",
  ol: "List",
  li: "List Item",
  p: "Paragraph",
  h1: "Heading",
  h2: "Heading",
  h3: "Heading",
  h4: "Heading",
  h5: "Heading",
  h6: "Heading",
  nav: "Navigation",
  header: "Header",
  footer: "Footer",
  figure: "Figure",
  pre: "Code",
  code: "Code",
}

/** What to call an element that has no words of its own to quote. */
export function htmlElementName(element: Pick<HtmlElement, "tag" | "attrs">) {
  const said = element.attrs?.["alt"] || element.attrs?.["aria-label"]
  const name = ELEMENT_NAMES[element.tag] ?? "Section"
  return said ? `${name}: ${said}` : name
}
