import { describe, expect, it } from "bun:test"
import { releaseTag } from "./release-info.ts"

// Cloud's connect command runs the connector published under this tag.
describe("releaseTag", () => {
  it("names the tag a release or beta build was published under", () => {
    expect(releaseTag("0.1.51")).toBe("v0.1.51")
    // Beta builds carry their commit, which the tag leaves out.
    expect(releaseTag("0.1.52-dev.529+d35f9ff")).toBe("v0.1.52-dev.529")
    for (const version of ["0.0.1", "0.0.0-rehearsal", "development", "0.1.52+../x"])
      expect(releaseTag(version)).toBeNull()
  })
})
