import { describe, expect, test } from "bun:test"
import {
  clampViewerRead,
  viewerAssetPath,
  viewerFrameMessage,
} from "./viewer-frame-protocol"

describe("what a viewer frame may ask its page for", () => {
  test("bytes inside its own file, and nothing past the end", () => {
    expect(clampViewerRead(0, 100, 1000)).toEqual({ begin: 0, end: 100 })
    expect(clampViewerRead(900, 5000, 1000)).toEqual({ begin: 900, end: 1000 })
    for (const [begin, end] of [
      [-1, 10],
      [10, 10],
      [20, 10],
      [1000, 1010],
      [0.5, 10],
      ["0", 10],
      [0, Number.POSITIVE_INFINITY],
    ]) {
      expect(clampViewerRead(begin, end, 1000)).toBeNull()
    }
  })

  test("its own public files by plain name, never a path", () => {
    expect(
      viewerAssetPath({ kind: "cmaps", name: "Adobe-Japan1-0.bcmap" })
    ).toBe("cmaps/Adobe-Japan1-0.bcmap")
    for (const request of [
      { kind: "cmaps", name: "../secret" },
      { kind: "cmaps", name: "a/b" },
      { kind: "cmaps", name: ".env" },
      { kind: "cmaps", name: "a..b" },
      { kind: "../api", name: "file" },
      { kind: "", name: "file" },
      { kind: "cmaps", name: "" },
    ]) {
      expect(viewerAssetPath(request)).toBeNull()
    }
  })

  test("only messages of the protocol, with the frame's token", () => {
    expect(
      viewerFrameMessage({ type: "viewer.read", token: "t", begin: 0, end: 1 })
    ).not.toBeNull()
    for (const data of [
      null,
      "viewer.read",
      { type: "viewer.read" },
      { type: "viewer.read", token: "" },
      { type: "worktable.api.request", token: "t" },
      { type: "viewer.open", token: "t" },
    ]) {
      expect(viewerFrameMessage(data)).toBeNull()
    }
  })
})
