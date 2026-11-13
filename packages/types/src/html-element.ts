/**
 * An element of an HTML Doc a comment is about. Agents rewrite these pages,
 * so nothing here is a position: the element is found again by what it is
 * and where it sits, as a passage is found by its words. The page matches it
 * against the elements on screen and the server against the page as written;
 * both use matchHtmlElement so they agree on where a comment belongs.
 *
 * This module has no dependencies: the app loads it with an HTML Doc.
 * HtmlElementSchema, beside the other comment schemas, is its saved form.
 */
export interface HtmlElement {
  /** Lowercase tag name. */
  tag: string
  id?: string
  classes?: string[]
  /** Attributes that name the element: data-*, role, href, src, alt and the like. */
  attrs?: Record<string, string>
  /** The page's text just before the element, and just after it. */
  before?: string
  after?: string
  /** The last heading before the element. */
  heading?: string
  /** Tags from the body down, as `section#pricing > table > tr:nth-of-type(3)`. */
  path: string
  /** Its opening tag as the browser had it. */
  html?: string
  /**
   * How far along the element's width the comment was pinned, from 0 to 1.
   * Places the pin only; it never helps find the element.
   */
  pin?: number
}

/**
 * Reads an element as a page's runtime describes it, dropping anything that
 * is not the expected kind. The server checks sizes when the comment is saved.
 */
export function readHtmlElement(value: unknown): HtmlElement | null {
  if (!value || typeof value !== "object") return null
  const from = value as Record<string, unknown>
  if (typeof from["tag"] !== "string" || typeof from["path"] !== "string")
    return null
  const element: HtmlElement = { tag: from["tag"], path: from["path"] }
  for (const name of ["id", "before", "after", "heading", "html"] as const) {
    const text = from[name]
    if (typeof text === "string" && text) element[name] = text
  }
  const classes = from["classes"]
  if (Array.isArray(classes))
    element.classes = classes.filter(
      (name): name is string => typeof name === "string" && name.length > 0
    )
  const attrs = from["attrs"]
  if (attrs && typeof attrs === "object")
    element.attrs = Object.fromEntries(
      Object.entries(attrs).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    )
  const pin = from["pin"]
  if (typeof pin === "number" && pin >= 0 && pin <= 1) element.pin = pin
  return element
}

/** How much of an element's text a comment keeps as its quote. */
export const HTML_ELEMENT_QUOTE_LENGTH = 200

/** How much text either side of an element its description keeps. */
export const HTML_ELEMENT_CONTEXT_LENGTH = 64

/** One element of a page, described the way a comment's element is. */
export interface HtmlElementCandidate {
  id?: string
  classes?: readonly string[]
  attrs?: Readonly<Record<string, string>>
  /** Its text, as far as HTML_ELEMENT_QUOTE_LENGTH. */
  text?: string
  before?: string
  after?: string
  heading?: string
  path: string
}

export interface HtmlElementMatch {
  index: number
  /** Exact when the element still reads the same. */
  match: "exact" | "fuzzy"
}

/**
 * Finds a comment's element among the page's elements with its tag.
 *
 * An element that kept its id, or its place, words and neighbors, is found
 * outright. So is the one element still between the same text as before,
 * whatever it says now, and the one element that still says the same thing
 * under the same heading, wherever it moved. Otherwise the closest element
 * is taken, and only when it is clearly closer than the rest. Look-alikes
 * are never it: the same button in another row, the same line under another
 * heading, or whatever slid into the place of an element that was removed.
 * When nothing qualifies the comment is not moved.
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
    (candidate.before ?? "") === (anchor.before ?? "") &&
    (candidate.after ?? "") === (anchor.after ?? "")
      ? [index]
      : []
  )
  if (inPlace.length === 1) return found(inPlace[0]!)

  // The comment's own text is compared with every element's: count its
  // letter pairs once.
  const counted = new Map<string, Map<string, number>>()
  const pairs = (value: string) => {
    let out = counted.get(value)
    if (out) return out
    out = new Map<string, number>()
    const lower = value.toLowerCase()
    for (let at = 0; at < lower.length - 1; at++) {
      const pair = lower.slice(at, at + 2)
      out.set(pair, (out.get(pair) ?? 0) + 1)
    }
    counted.set(value, out)
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
  /** The same heading, or one reworded around the same words. */
  const sameHeading = (candidate: HtmlElementCandidate) => {
    const before = (anchor.heading ?? "").toLowerCase()
    const now = (candidate.heading ?? "").toLowerCase()
    if (before === now) return true
    const [short, long] =
      before.length < now.length ? [before, now] : [now, before]
    return (
      (short.length >= 4 && long.includes(short)) || alike(before, now) >= 0.6
    )
  }

  // The one element that still says the same thing under the same heading
  // is it, wherever it moved. A few words could be anything's.
  if (text.length >= 16) {
    const worded = candidates.flatMap((candidate, index) =>
      same(candidate) ? [index] : []
    )
    if (worded.length === 1 && sameHeading(candidates[worded[0]!]!))
      return found(worded[0]!)
  }

  const context = (anchor.before ?? "").length + (anchor.after ?? "").length
  /**
   * How much of the text on one side is as it was. The nearest words count
   * for half: they are what sets an element apart from the one beside it.
   */
  const side = (
    was: string,
    now: string,
    nearest: (text: string) => string
  ) => (alike(was, now) + alike(nearest(was), nearest(now))) / 2
  const measured = candidates.map((candidate) => {
    const before = side(
      anchor.before ?? "",
      candidate.before ?? "",
      (text) => text.slice(-24)
    )
    const after = side(anchor.after ?? "", candidate.after ?? "", (text) =>
      text.slice(0, 24)
    )
    return {
      nearby: (before + after) / 2,
      // The side that changed more: an element beside one that was removed
      // keeps one side whole and loses the other.
      least: Math.min(before, after),
      said: alike(text, candidate.text ?? ""),
    }
  })

  // The one element still between the same text is it, whatever it says
  // now: a status that was changed is still that row's status.
  if (context >= 24) {
    let top = -1
    let topNearby = 0
    let nextNearby = 0
    for (let index = 0; index < measured.length; index++) {
      const { nearby } = measured[index]!
      if (nearby > topNearby) {
        nextNearby = topNearby
        topNearby = nearby
        top = index
      } else if (nearby > nextNearby) nextNearby = nearby
    }
    if (top >= 0 && topNearby >= 0.9 && topNearby - nextNearby >= 0.1)
      return found(top)
  }

  /** Among much the same text as before, and under the same heading. */
  const placedLike = (candidate: HtmlElementCandidate, index: number) => {
    const { nearby, least } = measured[index]!
    if (context >= 24 && least < 0.6) return false
    return sameHeading(candidate) || nearby >= 0.9
  }
  // The element in its place, between the same text, is it even when it
  // reads differently: what took a removed element's place is not between
  // the same text.
  const placed = candidates.findIndex(
    (candidate, index) =>
      candidate.path === anchor.path && placedLike(candidate, index)
  )
  if (placed >= 0 && context >= 24 && measured[placed]!.nearby >= 0.8)
    return found(placed)

  // A word or a number says little about which element it is: "No" is in
  // every other cell. Short text counts for less, and less is then needed.
  const textWeight = 0.35 * Math.min(1, text.length / 12)
  /** Whether what it says, or how it is named, is enough to know it by. */
  const telling =
    text.length >= 12 || (!text && Object.keys(anchor.attrs ?? {}).length > 0)
  const score = (candidate: HtmlElementCandidate, index: number) => {
    // Look-alikes are other elements: among other text, under another
    // heading, or saying something else.
    if (!placedLike(candidate, index)) return 0
    const { nearby, said } = measured[index]!
    if (text && said < (text.length >= 12 ? 0.6 : 0.3)) return 0
    // The less an element says, the more what is beside it has to vouch
    // for it: a new row where the old one was has cells that read the same.
    if (context >= 24 && !telling && nearby < 0.85) return 0
    return (
      textWeight * said +
      0.2 * nearby +
      0.15 * samePlace(anchor.path, candidate.path) +
      0.1 * (sameHeading(candidate) ? 1 : 0) +
      0.1 * sameSet(anchor.classes ?? [], candidate.classes ?? []) +
      0.1 * sameAttrs(anchor.attrs ?? {}, candidate.attrs ?? {})
    )
  }

  let best = -1
  let bestScore = 0
  let nextScore = 0
  for (let index = 0; index < candidates.length; index++) {
    const value = score(candidates[index]!, index)
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
  // The element in its place reads differently, and its words are on
  // another element: either could be it.
  if (
    placed >= 0 &&
    placed !== best &&
    !same(candidates[placed]!) &&
    same(candidates[best]!)
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
