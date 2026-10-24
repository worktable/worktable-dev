import { expect, test } from "bun:test"
import {
  renderPublicDocumentPage,
  renderPublicLivePage,
} from "./public-share-page"

const source = "https://github.com/worktable/worktable-dev/tree/0123abc"

test("every shared document offers its source in the footer, and only a safe https link", () => {
  const pages = [
    renderPublicDocumentPage(
      {
        kind: "doc",
        format: "markdown",
        title: "Plan",
        sourceUrl: source,
        projectionHtml: "<p>Hi</p>",
      },
      "<svg></svg>"
    ),
    renderPublicDocumentPage(
      { kind: "html", title: "Tool", sourceUrl: source, contentUrl: "/c" },
      "<svg></svg>"
    ),
    renderPublicLivePage(
      { title: "Tool", sourceUrl: source },
      { url: "/f", poll: 0 },
      "<svg></svg>"
    ),
  ]
  for (const page of pages)
    expect(page).toContain(
      `<footer class="share-footer"><a href="${source}" target="_blank" rel="noopener noreferrer">Source</a></footer>`
    )
  for (const sourceUrl of [
    undefined,
    "javascript:alert(1)",
    "https://user:pass@example.com/",
  ])
    expect(
      renderPublicDocumentPage(
        { kind: "html", title: "Tool", sourceUrl, contentUrl: "/c" },
        "<svg></svg>"
      )
    ).not.toContain('share-footer">')
})
