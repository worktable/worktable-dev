import { describe, expect, it } from "bun:test"

// The build compiles its id in; stand in for it before the module loads.
;(globalThis as { __WORKTABLE_BUILD_ID__?: string }).__WORKTABLE_BUILD_ID__ =
  "build-a"
const { noteServerBuild, serverBuildIsNewer } = await import("./build-version")

const from = (build?: string) =>
  new Response(null, {
    headers: build ? { "X-Worktable-Build": build } : {},
  })

describe("build version", () => {
  it("asks for a full load only once the server runs a different build", () => {
    noteServerBuild(from("build-a"))
    noteServerBuild(from())
    expect(serverBuildIsNewer()).toBe(false)

    noteServerBuild(from("build-b"))
    expect(serverBuildIsNewer()).toBe(true)
  })
})
