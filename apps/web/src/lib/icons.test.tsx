import { expect, it } from "bun:test"
import { Icon } from "lucide-react"
import dynamicIconImports from "lucide-react/dynamicIconImports.mjs"
import { renderToStaticMarkup } from "react-dom/server"
import { NamedIcon, POPULAR_ICONS } from "./icons"

const glyph = (html: string) => html.replace(/^<svg[^>]*>|<\/svg>$/g, "")

it("draws popular icons without the catalog, exactly as the catalog would", async () => {
  for (const name of POPULAR_ICONS) {
    const load = dynamicIconImports[name as keyof typeof dynamicIconImports]
    expect(load).toBeDefined()
    const { __iconNode } = await load()
    expect(glyph(renderToStaticMarkup(<NamedIcon name={name} />))).toBe(
      glyph(renderToStaticMarkup(<Icon iconNode={__iconNode} />))
    )
  }
})
