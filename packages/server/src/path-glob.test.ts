import { describe, expect, it } from "bun:test"
import { compilePathGlob } from "./path-glob.ts"

describe("document path globs", () => {
  it("keeps * and ? within a segment and lets ** span zero or more segments", () => {
    const cases: Array<[string, string, boolean]> = [
      ["plans/*", "plans/q1", true],
      ["plans/*", "plans/team/q1", false],
      ["plans/**", "plans", true],
      ["plans/**", "plans/team/q1", true],
      ["**/notes", "notes", true],
      ["a/**/b/**/c", "a/x/b/y/z/c", true],
      ["a/**/b/**/c", "a/x/c", false],
      ["2026-??", "2026-01", true],
      ["2026-??", "2026-1", false],
      ["*.md", "readme.md", true],
      ["*", "réunion", true],
      ["r?union", "réunion", true],
      ["Plans/*", "plans/q1", false],
      ["a+b(c)", "a+b(c)", true],
    ]
    for (const [pattern, path, expected] of cases) {
      expect([pattern, path, compilePathGlob(pattern)(path)]).toEqual([pattern, path, expected])
    }
  })

  it("matches adversarial patterns in bounded time", () => {
    const match = compilePathGlob(`${"*a".repeat(200)}b/${"**/".repeat(100)}x`)
    const started = performance.now()
    expect(match(`${"a".repeat(1000)}/${"y/".repeat(300)}z`)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it("rejects syntax it does not support", () => {
    for (const pattern of ["", "/plans", "plans/", "a//b", "a**", "{a,b}", "[ab]", "a\\*", "!drafts"]) {
      expect(() => compilePathGlob(pattern)).toThrow("Invalid glob")
    }
  })
})
