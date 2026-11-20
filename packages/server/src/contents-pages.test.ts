import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OUTLINE_WINDOW, contentsPageFromStore } from "./contents-pages.ts"
import { DerivedStore, type DerivedKey } from "./derived-store.ts"

let dir: string
let store: DerivedStore
const key: DerivedKey = {
  spaceId: "pages",
  documentId: "doc_long",
  version: "v1",
  kind: "contents",
  variant: "",
  maker: "pdf",
  makerVersion: 1,
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "worktable-contents-pages-"))
  store = new DerivedStore(dir)
})

afterEach(async () => {
  store.close()
  await rm(dir, { recursive: true, force: true })
})

describe("a page of a parsed file", () => {
  it("carries the outline and gaps around it, not the whole file's", () => {
    const pages = 1_000
    store.putContents(key, {
      state: "ready",
      output: {
        parts: Array.from({ length: pages }, (_, index) => ({ label: `Page ${index + 1}`, text: `text ${index + 1}` })),
        facts: { pages },
        gaps: [
          { where: "Page 2", why: "picture" },
          { where: "Page 700", why: "picture" },
          { where: "Page 900", why: "picture" },
        ],
      },
    })
    const first = contentsPageFromStore(store, key, 1, 4)
    expect(first.outline).toHaveLength(OUTLINE_WINDOW)
    expect(first.outline![0]).toEqual({ label: "Page 1", line: 1 })
    expect(first.missing).toEqual([
      { where: "Page 2", why: "picture" },
      { why: "2 more parts leave something out. Reading them says what." },
    ])
    expect(first.state).toBe("partial")

    // Further on, the outline starts at the page the read starts in.
    const line = 2 * 699 + 1
    const later = contentsPageFromStore(store, key, line, 2)
    expect(later.outline![0]).toEqual({ label: "Page 700", line })
    expect(later.missing).toContainEqual({ where: "Page 700", why: "picture" })
    expect(later.missing).toHaveLength(2)
  })
})
