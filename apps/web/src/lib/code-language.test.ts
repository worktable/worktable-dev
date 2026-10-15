import { describe, expect, it } from "bun:test"
import { codeBlockOptions } from "@blocknote/code-block"
import { CODE_LANGUAGE_NAMES } from "@worktable/ui/lib/code-language"

describe("code language names", () => {
  it("match the editor's language picker for every id and alias", () => {
    const expected: Record<string, string> = {}
    for (const [id, { name, aliases }] of Object.entries(
      codeBlockOptions.supportedLanguages as Record<
        string,
        { name: string; aliases?: string[] }
      >
    )) {
      expected[id] = name
      for (const alias of aliases ?? []) expected[alias] = name
    }
    expect(CODE_LANGUAGE_NAMES).toEqual(expected)
  })
})
