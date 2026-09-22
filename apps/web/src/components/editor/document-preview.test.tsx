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

  it("escapes authored text and retains headings and table content", () => {
    const html = renderToStaticMarkup(<DocumentPreview content={[
      { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Notes", styles: {} }] },
      { type: "paragraph", content: [{ type: "text", text: "<img src=x onerror=alert(1)>", styles: { bold: true } }] },
      { type: "table", content: { rows: [{ cells: [[{ type: "text", text: "Cell", styles: {} }]] }] } },
    ]} />)
    expect(html).toContain("<h2>")
    expect(html).toContain("Notes")
    expect(html).toContain("<strong>&lt;img")
    expect(html).not.toContain("<img")
    expect(html).toContain("<table>")
    expect(html).toContain("Cell")
  })
})
