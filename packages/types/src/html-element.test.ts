import { describe, expect, it } from "bun:test"
import { matchHtmlElement, type HtmlElementCandidate } from "./html-element"

const row = (
  name: string,
  place: number,
  text = "Edit"
): HtmlElementCandidate => ({
  classes: ["action"],
  text,
  within: `${name} $400 ${text}`,
  heading: "Customers",
  path: `main > table > tbody > tr:nth-of-type(${place}) > td:nth-of-type(3) > button`,
})

describe("matchHtmlElement", () => {
  it("finds an element that kept its place and words", () => {
    const page = [row("Acme", 1), row("Birch", 2), row("Cedar", 3)]
    expect(matchHtmlElement(row("Birch", 2), page)).toEqual({
      index: 1,
      match: "exact",
    })
  })

  it("follows an element a rewrite moved, by what surrounds it", () => {
    // A row was added above: the old place now holds another row's button.
    const page = [row("Aspen", 1), row("Acme", 2), row("Birch", 3)]
    expect(matchHtmlElement(row("Birch", 2), page)).toEqual({
      index: 2,
      match: "exact",
    })
  })

  it("finds a reworded element and says its words changed", () => {
    const page: HtmlElementCandidate[] = [
      { text: "Plans", path: "main > section:nth-of-type(1) > h2" },
      {
        text: "What you get on each plan",
        heading: "Plans",
        path: "main > section:nth-of-type(2) > h2",
      },
    ]
    expect(
      matchHtmlElement(
        {
          text: "What each plan includes",
          heading: "Plans",
          path: "main > section:nth-of-type(2) > h2",
        },
        page
      )
    ).toEqual({ index: 1, match: "fuzzy" })
  })

  it("finds an element whose words changed in a small card", () => {
    const price = (text: string): HtmlElementCandidate => ({
      classes: ["price"],
      text,
      within: `Team ${text} Up to 12 people.`,
      heading: "Team",
      path: "main > section#plans > article > div",
    })
    expect(
      matchHtmlElement(price("$49 per month"), [
        price("$39 per month, billed yearly"),
      ])
    ).toEqual({ index: 0, match: "fuzzy" })
  })

  it("follows an item when another is added before it", () => {
    const list = (items: string[]) =>
      items.map((text, at) => ({
        text,
        within: items.join(" "),
        path: `main > ul > li:nth-of-type(${at + 1})`,
      }))
    const [, beta] = list(["Alpha", "Beta", "Gamma"])
    expect(
      matchHtmlElement(beta!, list(["Aardvark", "Alpha", "Beta", "Gamma"]))
    ).toEqual({ index: 2, match: "exact" })
  })

  it("keeps an element by its id through any rewrite", () => {
    const page: HtmlElementCandidate[] = [
      { text: "Other", path: "main > div:nth-of-type(1)" },
      { id: "total", text: "$52k", path: "main > footer > div" },
    ]
    expect(
      matchHtmlElement(
        { id: "total", text: "$48k", path: "main > div:nth-of-type(2)" },
        page
      )
    ).toEqual({ index: 1, match: "fuzzy" })
  })

  it("does not guess between a cell that changed and its neighbor that reads the same", () => {
    const cell = (place: number, text: string, row: string) => ({
      text,
      within: row,
      heading: "Plans",
      path: `main > table > tbody > tr:nth-of-type(4) > td:nth-of-type(${place})`,
    })
    // The commented cell said No and now says Yes; the one beside it still says No.
    const page = [cell(2, "No", "Audit log No Yes Yes"), cell(3, "Yes", "Audit log No Yes Yes")]
    expect(matchHtmlElement(cell(3, "No", "Audit log No No Yes"), page)).toBeNull()
    // With words long enough to count, the neighbor that kept them still
    // does not win: the comment stays with its cell or goes nowhere.
    const found = matchHtmlElement(
      cell(3, "Unlimited", "Agents 3 Unlimited Unlimited"),
      [
        cell(3, "50", "Agents 3 50 Unlimited"),
        cell(4, "Unlimited", "Agents 3 50 Unlimited"),
      ]
    )
    expect(found === null || found.index === 0).toBe(true)
  })

  it("does not move a comment to a look-alike or to something else", () => {
    // The row is gone; the button now in its place belongs to another row.
    expect(matchHtmlElement(row("Birch", 2), [row("Cedar", 2)])).toBeNull()
    expect(
      matchHtmlElement(row("Birch", 2), [row("Acme", 1), row("Cedar", 2)])
    ).toBeNull()
    expect(
      matchHtmlElement(row("Birch", 2), [
        { text: "Sign out", path: "header > nav > button" },
      ])
    ).toBeNull()
  })
})
