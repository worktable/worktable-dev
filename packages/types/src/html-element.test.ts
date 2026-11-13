import { describe, expect, it } from "bun:test"
import { matchHtmlElement, type HtmlElementCandidate } from "./html-element"

/** A table's rows as a page describes their Edit buttons. */
const buttons = (names: string[]): HtmlElementCandidate[] =>
  names.map((name, at) => ({
    classes: ["action"],
    text: "Edit",
    before: `${names[at - 1] ? `${names[at - 1]} Ltd $400 Edit ` : ""}${name} Ltd $400`,
    after: names[at + 1] ? `${names[at + 1]} Ltd $400 Edit` : "",
    heading: "Customers",
    path: `main > table > tbody > tr:nth-of-type(${at + 1}) > td:nth-of-type(3) > button`,
  }))

/** One row's cells, in a table with a row above and a row below. */
const cells = (label: string, values: string[]): HtmlElementCandidate[] =>
  values.map((text, at) => ({
    text,
    before: ["Version history 30 days 1 year Forever", label, ...values.slice(0, at)].join(" "),
    after: [...values.slice(at + 1), "Single sign-on No No Yes"].join(" "),
    heading: "Plans",
    path: `main > table > tbody > tr:nth-of-type(4) > td:nth-of-type(${at + 2})`,
  }))

/** A list's items. */
const items = (texts: string[]): HtmlElementCandidate[] =>
  texts.map((text, at) => ({
    text,
    before: texts.slice(0, at).join(" "),
    after: texts.slice(at + 1).join(" "),
    heading: "Checklist",
    path: `main > ul > li:nth-of-type(${at + 1})`,
  }))

describe("matchHtmlElement", () => {
  it("finds an element that kept its place and words", () => {
    const page = buttons(["Acme", "Birch", "Cedar"])
    expect(matchHtmlElement(page[1]!, page)).toEqual({
      index: 1,
      match: "exact",
    })
  })

  it("follows an element a rewrite moved, by the text beside it", () => {
    // A row was added above: the old place now holds another row's button.
    const before = buttons(["Acme", "Birch", "Cedar"])
    const after = buttons(["Aspen", "Acme", "Birch", "Cedar"])
    expect(matchHtmlElement(before[1]!, after)).toEqual({
      index: 2,
      match: "exact",
    })
  })

  it("stays with an element whose words changed", () => {
    // A cell that said No now says Yes; the cell beside it still says No.
    const [, team] = cells("Audit log", ["No", "No", "Yes"])
    expect(
      matchHtmlElement(team!, cells("Audit log", ["No", "Yes", "Yes"]))
    ).toEqual({ index: 1, match: "fuzzy" })
    const price = (text: string): HtmlElementCandidate => ({
      classes: ["price"],
      text,
      before: "Plans Team",
      after: "Up to 12 people. Choose Team",
      heading: "Team",
      path: "main > section#plans > article > div",
    })
    expect(
      matchHtmlElement(price("$49 per month"), [
        price("$39 per month, billed yearly"),
      ])
    ).toEqual({ index: 0, match: "fuzzy" })
  })

  it("follows an item moved within its list by its words", () => {
    const list = [
      "Finish the migration guide",
      "Load test the sync service",
      "Record the product demo video",
    ]
    const [, , video] = items(list)
    expect(
      matchHtmlElement(video!, items([list[2]!, list[0]!, list[1]!]))
    ).toEqual({ index: 0, match: "exact" })
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

  it("does not move a short cell to a new row put where its row was", () => {
    // Audit log moved up and its cell changed; Guest access, with the same
    // values, now sits between the rows Audit log was between.
    const row = (label: string, above: string, below: string) => ({
      text: "No",
      before: `${above} ${label}`,
      after: `Yes Yes ${below}`,
      heading: "What each plan includes",
      path: "main > table > tbody > tr:nth-of-type(4) > td:nth-of-type(2)",
    })
    const history = "Version history 30 days 1 year Forever"
    const signOn = "Single sign-on No No Yes"
    expect(
      matchHtmlElement(
        { ...row("Audit log", history, signOn), after: `No Yes ${signOn}` },
        [
          {
            ...row("Audit log", "Share links Yes Yes Yes", history),
            path: "main > table > tbody > tr:nth-of-type(3) > td:nth-of-type(2)",
          },
          {
            ...row("Guest access", history, signOn),
            path: "main > table > tbody > tr:nth-of-type(5) > td:nth-of-type(2)",
          },
        ]
      )
    ).toBeNull()
  })

  it("does not move a comment to what took a removed element's place", () => {
    // The second testimonial was removed; the third is now second.
    const quotes = [
      "We cut our stockouts by half in the first season.",
      "It paid for itself in six weeks, I can't imagine going back.",
      "Transfers between our three shops used to take a phone call.",
    ]
    const cards = (texts: string[]) =>
      items(texts).map((item, at) => ({
        ...item,
        heading: "What Retailers Say",
        path: `main > section > blockquote:nth-of-type(${at + 1})`,
      }))
    const [, removed] = cards(quotes)
    expect(
      matchHtmlElement(removed!, cards([quotes[0]!, quotes[2]!]))
    ).toBeNull()
  })

  it("does not move a comment to the same words somewhere else", () => {
    // The row is gone; the buttons left belong to other rows.
    const [, birch] = buttons(["Acme", "Birch", "Cedar"])
    expect(matchHtmlElement(birch!, buttons(["Acme", "Cedar"]))).toBeNull()
    // The line was taken out of one plan; another plan still has it.
    const line = (plan: string): HtmlElementCandidate => ({
      text: "Priority support",
      before: "Low-stock forecasts Smart alerts Weekly margin reports",
      after: "Choose plan",
      heading: plan,
      path: `main > section > div:nth-of-type(${plan === "Starter" ? 1 : 2}) > ul > li:nth-of-type(4)`,
    })
    expect(
      matchHtmlElement(line("Starter"), [
        { ...line("Growth"), before: "Smart alerts Weekly margin reports Supplier sync" },
      ])
    ).toBeNull()
    expect(
      matchHtmlElement(birch!, [
        { text: "Sign out", path: "header > nav > button" },
      ])
    ).toBeNull()
  })
})
