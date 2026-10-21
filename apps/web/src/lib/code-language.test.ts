import { describe, expect, it } from "bun:test"
import { CODE_LANGUAGE_NAMES } from "@worktable/ui/lib/code-language"
import { richCodeBlockOptions } from "@/components/editor/rich-code-block"

describe("code language names", () => {
  it("match the editor's language picker for every id and alias", () => {
    // Mermaid is a block of its own in the editor; Markdown still labels it.
    const expected: Record<string, string> = {
      mermaid: "Mermaid",
      mmd: "Mermaid",
    }
    for (const [id, { name, aliases }] of Object.entries(
      richCodeBlockOptions.supportedLanguages
    )) {
      expected[id] = name
      for (const alias of aliases ?? []) expected[alias] = name
    }
    expect(CODE_LANGUAGE_NAMES).toEqual(expected)
  })
})
