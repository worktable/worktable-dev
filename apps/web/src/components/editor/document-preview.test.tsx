import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { DocumentPreview } from "./document-preview"

describe("saved document preview", () => {
  it("shows readable content without rendering the entire large document or changing its source", () => {
    const content = Array.from({ length: 2000 }, (_, index) => ({
      id: `block-${index}`,
      type: "paragraph",
      content: [{ type: "text", text: `Preview paragraph ${index}`, styles: {} }],
      children: [],
    }))
    const before = JSON.stringify(content)
    const html = renderToStaticMarkup(<DocumentPreview content={content} />)
    expect(html).toContain("Preview paragraph 0")
    expect(html).not.toContain("Preview paragraph 1999")
    expect(html).toContain("More content is opening")
    expect(html.length).toBeLessThan(20_000)
    expect(html).not.toContain("contenteditable")
    expect(JSON.stringify(content)).toBe(before)
  })

  it("draws nested checklists, collapsed diagrams and numbered items as the editor does", () => {
    const text = (value: string) => [{ type: "text", text: value, styles: {} }]
    const html = renderToStaticMarkup(<DocumentPreview content={[
      { type: "checkListItem", props: { checked: false }, content: text("Parent"), children: [
        { type: "checkListItem", props: { checked: true }, content: text("Child") },
      ] },
      { type: "mermaid", props: { data: "graph TD\n  A --> B", title: "Flow", collapsed: "true" } },
      { type: "numberedListItem", props: { start: 3 }, content: text("Third") },
      { type: "numberedListItem", content: text("Fourth") },
    ]} />)
    // Numbers are stamped on items, so markers render as one kerned string.
    expect(html).toMatch(/<li data-index="3"[^>]*><span>Third/)
    expect(html).toMatch(/<li data-index="4"[^>]*><span>Fourth/)
    expect(html).not.toMatch(/<ul[^>]*>\s*<ul/)
    expect(html).toMatch(/task-list-item[^>]*>.*Parent.*<ul class="contains-task-list">.*Child/s)
    expect(html).toContain("worktable-diagram-collapsed")
    expect(html).not.toContain("worktable-preview-diagram")
  })

  it("puts what goes under the title right after the opening heading, or first without one", () => {
    const text = (value: string) => [{ type: "text", text: value, styles: {} }]
    const byline = <div data-byline>Byline</div>
    const order = (html: string) =>
      ["Title", "Byline", "Body"].sort((a, b) => html.indexOf(a) - html.indexOf(b))

    const rich = renderToStaticMarkup(<DocumentPreview afterTitle={byline} content={[
      { type: "heading", props: { level: 1 }, content: text("Title") },
      { type: "paragraph", content: text("Body") },
    ]} />)
    expect(order(rich)).toEqual(["Title", "Byline", "Body"])

    const markdown = renderToStaticMarkup(
      <DocumentPreview afterTitle={byline} content={"\n# Title\n\nBody\n\n# Title again"} />
    )
    expect(order(markdown)).toEqual(["Title", "Byline", "Body"])
    expect(markdown.match(/data-byline/g)).toHaveLength(1)

    const untitled = renderToStaticMarkup(
      <DocumentPreview afterTitle={byline} content={"## Title\n\nBody"} />
    )
    expect(order(untitled)).toEqual(["Byline", "Title", "Body"])
  })

  it("shows a rich Doc's name in grey where its title is empty or missing", () => {
    const text = (value: string) => [{ type: "text", text: value, styles: {} }]
    const byline = <div data-byline>Byline</div>
    const placeholder = (html: string) =>
      html.match(/<h1 class="worktable-title-placeholder">([^<]*)<\/h1>/)?.[1]

    const empty = renderToStaticMarkup(<DocumentPreview titlePlaceholder="Untitled 2" afterTitle={byline} content={[
      { id: "t", type: "heading", props: { level: 1 }, content: [] },
      { id: "p", type: "paragraph", content: text("Body") },
    ]} />)
    expect(placeholder(empty)).toBe("Untitled 2")
    expect(empty.indexOf("Untitled 2")).toBeLessThan(empty.indexOf("Byline"))

    const missing = renderToStaticMarkup(<DocumentPreview titlePlaceholder="Field notes" afterTitle={byline} content={[
      { id: "p", type: "paragraph", content: text("Body") },
    ]} />)
    expect(placeholder(missing)).toBe("Field notes")
    expect(missing.indexOf("Field notes")).toBeLessThan(missing.indexOf("Byline"))
    expect(missing.indexOf("Byline")).toBeLessThan(missing.indexOf("Body"))

    const titled = renderToStaticMarkup(<DocumentPreview titlePlaceholder="Plan" content={[
      { id: "t", type: "heading", props: { level: 1 }, content: text("Q3 plan") },
    ]} />)
    expect(placeholder(titled)).toBeUndefined()
  })

  it("escapes authored text and retains headings and table content", () => {
    const html = renderToStaticMarkup(<DocumentPreview content={[
      { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Notes", styles: {} }] },
      { type: "paragraph", content: [{ type: "text", text: "<img src=x onerror=alert(1)>", styles: { bold: true } }] },
      { type: "table", content: { rows: [{ cells: [[{ type: "text", text: "Cell", styles: {} }]] }] } },
    ]} />)
    expect(html).toMatch(/<h2[ >]/)
    expect(html).toContain("Notes")
    expect(html).toContain("<strong>&lt;img")
    expect(html).not.toContain("<img")
    expect(html).toMatch(/<table[ >]/)
    expect(html).toContain("Cell")
  })
})
