import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { markdownHtmlPlugins } from "./markdown-html"

function render(markdown: string): string {
  return renderToStaticMarkup(
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={markdownHtmlPlugins}>
      {markdown}
    </Markdown>
  )
}

describe("HTML in Markdown Docs", () => {
  it("renders formatting HTML and drops anything active or styling", () => {
    const html = render(
      [
        "<details open><summary>More</summary>\n\nInside **bold**\n\n</details>",
        'Press <kbd>K</kbd>, H<sub>2</sub>O and <mark>this</mark>. <span onclick="steal()" style="position:fixed">x</span>',
        "<script>steal()</script><style>body{display:none}</style>",
        '<iframe src="https://example.com"></iframe><img src="a.png" onerror="steal()">',
      ].join("\n\n")
    )
    expect(html).toContain("<details open")
    expect(html).toContain("<summary>More</summary>")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<kbd>K</kbd>")
    expect(html).toContain("<sub>2</sub>")
    expect(html).toContain("<mark>this</mark>")
    expect(html).not.toMatch(/script|<style|iframe|onclick|onerror|position:fixed/)
    expect(html).toContain('<img src="a.png"')
  })

  it("keeps authored ids apart from the app's, with links to them still working", () => {
    const html = render(
      '<a href="#root">Jump</a> <div id="root">x</div>\n\nNote[^1]\n\n[^1]: Text.'
    )
    expect(html).toContain('id="user-content-root"')
    expect(html).toContain('href="#user-content-root"')
    const href = html.match(/href="#([^"]+)"[^>]*data-footnote-ref/)?.[1]
    expect(href).toBeTruthy()
    expect(html).toContain(`id="${href}"`)
  })
})
