import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { DocumentPreview } from "./document-preview"

describe("a rich Doc's reading preview", () => {
  it("loads an image's stored path from where the Doc's files load", () => {
    const html = renderToStaticMarkup(
      <DocumentPreview
        content={[
          { id: "a", type: "image", props: { url: "readme/shot.png", caption: "Shot" }, children: [] },
        ]}
        resolveUrl={(url) => `/files/${url}`}
      />
    )
    expect(html).toContain('src="/files/readme/shot.png"')
  })
})
