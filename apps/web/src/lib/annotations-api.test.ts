import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createAnnotation } from "./annotations-api"
import { getCurrentUser, setCurrentUser } from "./profile"

const originalFetch = globalThis.fetch
const originalLocalStorage = globalThis.localStorage
const requests: Array<{ url: string; init?: RequestInit }> = []
const store = new Map<string, string>()

beforeEach(() => {
  requests.length = 0
  store.clear()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }
  setCurrentUser({ id: "ptc_stale", name: "Previous Worktable" })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (url === "/api/profile") {
      return Response.json({ id: "ptc_current", name: "Current Owner" })
    }
    return Response.json({
      ok: true,
      annotationId: "ann_1",
      annotation: {},
      created: true,
    })
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  ;(globalThis as Record<string, unknown>).localStorage = originalLocalStorage
})

describe("annotation authorship", () => {
  test("loads the canonical participant before writing an annotation", async () => {
    await createAnnotation("space-1", {
      target: { type: "doc", docPath: "notes/brief.md" },
      category: "comment",
      body: "Use the current participant.",
    })

    expect(requests.map((request) => request.url)).toEqual([
      "/api/profile",
      "/api/spaces/space-1/annotations",
    ])
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      author: {
        type: "user",
        id: "ptc_current",
        name: "Current Owner",
      },
    })
    expect(getCurrentUser()).toEqual({
      id: "ptc_current",
      name: "Current Owner",
    })
  })
})
