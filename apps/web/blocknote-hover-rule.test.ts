import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "bun:test"
import { dropSuggestionHover } from "./blocknote-hover-rule"

const require = createRequire(import.meta.url)

describe("BlockNote's style sheet", () => {
  it("has no :hover rule whose subject is any element, once built", () => {
    const path = require.resolve("@blocknote/shadcn/style.css")
    const css = dropSuggestionHover(readFileSync(path, "utf8"))
    // A :hover rule ending in `> *` or ` *` makes Chrome restyle the whole
    // subtree of every element whose hover changes.
    expect(css).not.toMatch(/:hover\s*[>+~ ]\s*\*\s*[,{]/)
    // The rest of each rule list stays.
    expect(css).toContain("[data-type=modification] .bn-suggestion-mark:hover")
  })
})
