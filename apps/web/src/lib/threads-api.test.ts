import { describe, expect, test } from "bun:test"

import { threadScopeContains } from "./threads-api"

describe("threadScopeContains", () => {
  test("keeps every location in All and isolates Worktable and Space filters", () => {
    const worktable = { kind: "worktable" as const }
    const product = { kind: "space" as const, spaceId: "product" }
    const design = { kind: "space" as const, spaceId: "design" }

    expect(threadScopeContains({ kind: "all" }, worktable)).toBe(true)
    expect(threadScopeContains({ kind: "all" }, product)).toBe(true)
    expect(threadScopeContains(worktable, worktable)).toBe(true)
    expect(threadScopeContains(worktable, product)).toBe(false)
    expect(threadScopeContains(product, product)).toBe(true)
    expect(threadScopeContains(product, design)).toBe(false)
  })
})
