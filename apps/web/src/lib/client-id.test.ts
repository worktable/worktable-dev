import { describe, expect, test } from "bun:test"
import { createClientId } from "./client-id"

describe("createClientId", () => {
  test("creates opaque IDs using the browser crypto primitive available on LAN HTTP", () => {
    const first = createClientId("thread-post")
    const second = createClientId("thread-post")

    expect(first).toMatch(/^thread-post_[0-9a-f]{32}$/)
    expect(second).toMatch(/^thread-post_[0-9a-f]{32}$/)
    expect(second).not.toBe(first)
  })

  test("rejects prefixes that could make IDs ambiguous", () => {
    expect(() => createClientId("../thread")).toThrow()
  })
})
