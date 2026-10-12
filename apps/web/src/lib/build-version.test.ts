import { beforeEach, describe, expect, it } from "bun:test"

// The build compiles its id in; stand in for it before the module loads.
;(globalThis as { __WORKTABLE_BUILD_ID__?: string }).__WORKTABLE_BUILD_ID__ =
  "build-a"

type BuildVersion = typeof import("./build-version")

// Session storage outlives a reload; the module's state does not.
const session = new Map<string, string>()
const storage = globalThis as { sessionStorage?: Partial<Storage> }

let pages = 0
/** The tab loads a page of build-a. */
const loadPage = () =>
  import(`./build-version.ts?page=${++pages}`) as Promise<BuildVersion>

const from = (build?: string) =>
  new Response(null, {
    headers: build ? { "X-Worktable-Build": build } : {},
  })

beforeEach(() => {
  session.clear()
  storage.sessionStorage = {
    getItem: (key) => session.get(key) ?? null,
    setItem: (key, value) => void session.set(key, value),
  }
})

describe("build version", () => {
  it("loads a different build once, at the next navigation", async () => {
    const page = await loadPage()
    page.noteServerBuild(from("build-a"))
    page.noteServerBuild(from())
    expect(page.claimServerBuildReload()).toBe(false)

    page.noteServerBuild(from("build-b"))
    expect(page.claimServerBuildReload()).toBe(true)

    // The reloaded page still runs build-a while the server names build-b,
    // as with a stale build-id.txt or a cached page.
    const reloaded = await loadPage()
    reloaded.noteServerBuildId("build-b")
    expect(reloaded.claimServerBuildReload()).toBe(false)
    reloaded.noteServerBuild(from("build-b"))
    expect(reloaded.claimServerBuildReload()).toBe(false)

    // A later update still loads.
    reloaded.noteServerBuild(from("build-c"))
    expect(reloaded.claimServerBuildReload()).toBe(true)
  })

  it("keeps running when it cannot remember a reload", async () => {
    storage.sessionStorage = {
      getItem: () => {
        throw new Error("storage is disabled")
      },
    }
    const page = await loadPage()
    page.noteServerBuild(from("build-b"))
    expect(page.claimServerBuildReload()).toBe(false)
  })
})
