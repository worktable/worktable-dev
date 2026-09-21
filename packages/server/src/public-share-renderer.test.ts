import { describe, expect, it } from "bun:test"
import { JSDOM } from "jsdom"
import {
  renderPublicDocProjection,
  renderPublicHtmlProjection,
} from "./public-share-renderer.ts"

describe("public Doc projection", () => {
  it("preserves rich document structure while removing active and internal links", async () => {
    const html = await renderPublicDocProjection(
      [
        {
          type: "heading",
          props: { level: 2 },
          content: [{ type: "text", text: "Launch", styles: { bold: true } }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "link",
              href: "/spaces/private/docs/plan",
              content: [{ type: "text", text: "Private plan", styles: {} }],
            },
            { type: "text", text: " and ", styles: {} },
            {
              type: "link",
              href: "https://example.com/reference",
              content: [{ type: "text", text: "reference", styles: {} }],
            },
          ],
        },
        {
          type: "table",
          content: {
            type: "tableContent",
            rows: [{ cells: [[{ type: "text", text: "Status", styles: {} }]] }],
          },
        },
      ],
      "blocknote"
    )

    expect(html).toContain("<h2")
    expect(html).toContain("<table")
    expect(html).toContain("Private plan")
    expect(html).not.toContain("/spaces/private")
    expect(html).toContain("https://example.com/reference")
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it("renders Markdown through the same inert projection", async () => {
    const html = await renderPublicDocProjection(
      "# Hello\n\n<script>alert(1)</script>\n\n- one\n- two",
      "markdown"
    )
    expect(html).toContain("<h1")
    expect(html).toContain("<ul")
    expect(html).not.toContain("<script")
  })
})

describe("public HTML-doc projection", () => {
  it("keeps safe links and layout while removing executable, private, and remote surfaces", () => {
    const html = renderPublicHtmlProjection(`<!doctype html>
      <html data-theme="dark"><head>
        <meta http-equiv="refresh" content="0;url=https://network.attacker.test">
        <link rel="stylesheet" href="https://network.attacker.test/style.css">
        <style>
          :root{--ad-bg:white}
          .card{color:red;background:var(--ad-bg) url(https://network.attacker.test/pixel)}
          html[data-theme="dark"]{--ad-bg:#111}
          html[data-theme="dark"] .dark-label{color:white}
        </style>
        <script>fetch("https://network.attacker.test")</script>
      </head><body onload="alert(1)">
        <main class="card" style="background:url(https://network.attacker.test/inline)">
          <h1>Useful report</h1>
          <p class="dark-label">Dark aware</p>
          <a data-kind="external" href="https://example.com/go" ping="https://network.attacker.test/ping" target="_self" rel="opener">Reference</a>
          <a data-kind="email" href="mailto:hello@example.com">Email</a>
          <a data-kind="fragment" href="#details">Details</a>
          <a data-kind="relative-private" href="/spaces/private/docs/plan">Private relative</a>
          <a data-kind="absolute-private" href="https://example.app.worktable.cloud/spaces/private/docs/plan">Private absolute</a>
          <a data-kind="unsafe" href="javascript:alert(1)">Unsafe</a>
          <form action="https://network.attacker.test/form"><input name="secret"></form>
          <iframe src="https://network.attacker.test/frame"></iframe>
          <img src="https://network.attacker.test/image" alt="Chart">
          <picture>
            <source srcset="https://network.attacker.test/responsive-image">
            <img data-kind="safe-picture" src="data:image/png;base64,iVBORw0KGgo=" alt="Embedded chart">
          </picture>
          <svg viewBox="0 0 20 20" aria-label="Progress chart">
            <defs>
              <linearGradient id="safe-gradient"><stop offset="0" stop-color="#fff" /></linearGradient>
            </defs>
            <path data-kind="safe-shape" d="M 1 1 L 19 19" fill="url(#safe-gradient)" onclick="alert(1)" />
            <path data-kind="remote-paint" d="M 2 2 L 18 18" fill="url(https://network.attacker.test/paint)" />
            <image href="https://network.attacker.test/svg-image" />
            <foreignObject><div>Unsafe SVG HTML</div></foreignObject>
          </svg>
          <details id="details"><summary>More</summary><p>Safe detail</p></details>
        </main>
      </body></html>`)

    const document = new JSDOM(html).window.document
    const external = document.querySelector('[data-kind="external"]')
    const email = document.querySelector('[data-kind="email"]')
    const fragment = document.querySelector('[data-kind="fragment"]')
    const themeRules = Array.from(
      document.querySelector<HTMLStyleElement>(
        'style[data-worktable-shared-theme="system"]'
      )?.sheet?.cssRules ?? []
    )
    const colorSchemeRule = themeRules.find(
      (rule) =>
        "selectorText" in rule &&
        (rule as CSSStyleRule).selectorText === ":root"
    ) as CSSStyleRule | undefined
    const darkMedia = themeRules.find(
      (rule) =>
        "media" in rule &&
        (rule as CSSMediaRule).media.mediaText ===
          "(prefers-color-scheme: dark)"
    ) as CSSMediaRule | undefined
    const darkRules = Array.from(darkMedia?.cssRules ?? [])
    const darkRoot = darkRules.find(
      (rule) =>
        "selectorText" in rule &&
        (rule as CSSStyleRule).selectorText === ":root"
    ) as CSSStyleRule | undefined
    const darkLabel = darkRules.find(
      (rule) =>
        "selectorText" in rule &&
        (rule as CSSStyleRule).selectorText === ":root .dark-label"
    ) as CSSStyleRule | undefined
    const safeShape = document.querySelector('[data-kind="safe-shape"]')
    const remotePaint = document.querySelector('[data-kind="remote-paint"]')
    const safePicture = document.querySelector('[data-kind="safe-picture"]')

    expect(html).toContain("Useful report")
    expect(html).toContain("Safe detail")
    expect(colorSchemeRule?.style.getPropertyValue("color-scheme")).toBe(
      "light dark"
    )
    expect(darkRoot?.style.getPropertyValue("--ad-bg")).toBe("#111")
    expect(darkLabel?.style.getPropertyValue("color")).toBe("white")
    expect(html).toContain("color:red")
    expect(html).toContain("Chart")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<iframe")
    expect(html).not.toContain("<form")
    expect(html).not.toContain("<input")
    expect(html).not.toContain("onload")
    expect(html).not.toContain('src="https://')
    expect(html).not.toContain("network.attacker.test")
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false)
    expect(document.querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 20 20"
    )
    expect(safeShape?.getAttribute("d")).toBe("M 1 1 L 19 19")
    expect(safeShape?.getAttribute("fill")).toBe("url(#safe-gradient)")
    expect(safeShape?.hasAttribute("onclick")).toBe(false)
    expect(remotePaint?.hasAttribute("fill")).toBe(false)
    expect(document.querySelector("svg image")).toBeNull()
    expect(document.querySelector("foreignObject")).toBeNull()
    expect(html).not.toContain("Unsafe SVG HTML")
    expect(document.querySelector("picture")).toBeNull()
    expect(document.querySelector("source")).toBeNull()
    expect(safePicture?.getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw0KGgo="
    )
    expect(external?.getAttribute("href")).toBe("https://example.com/go")
    expect(external?.getAttribute("target")).toBe("_blank")
    expect(external?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(external?.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(email?.getAttribute("href")).toBe("mailto:hello@example.com")
    expect(email?.getAttribute("target")).toBe("_blank")
    expect(fragment?.getAttribute("href")).toBe("#details")
    expect(fragment?.getAttribute("target")).toBeNull()
    expect(
      document.querySelector('[data-kind="relative-private"]')?.localName
    ).toBe("span")
    expect(
      document.querySelector('[data-kind="absolute-private"]')?.localName
    ).toBe("span")
    expect(
      document.querySelector('[data-kind="unsafe"]')?.localName
    ).toBe("span")
  })
})
