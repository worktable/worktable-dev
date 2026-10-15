import { describe, expect, it } from "bun:test"
import {
  betaResidenceMs,
  betaTagsToPrune,
  parseManifest,
  publishChannel,
  serializeManifest,
  setHeld,
} from "./release-channels.ts"

const commit = (c: string) => c.repeat(40)
const at = "2026-10-15T00:00:00.000Z"

describe("release channel manifest", () => {
  const stable = publishChannel(parseManifest(null), {
    channel: "stable",
    version: "0.1.23",
    commit: commit("a"),
    publishedAt: at,
  }).manifest

  it("moves beta forward only and keeps a hold across new builds", () => {
    const first = publishChannel(stable, {
      channel: "beta",
      version: "0.1.24-dev.130+bbbbbbb",
      commit: commit("b"),
      publishedAt: at,
    }).manifest
    expect(first.channels.beta).toMatchObject({
      version: "0.1.24-dev.130+bbbbbbb",
      tag: "v0.1.24-dev.130",
      held: false,
    })
    // An older build finishing late changes nothing.
    expect(
      publishChannel(first, {
        channel: "beta",
        version: "0.1.24-dev.129+ccccccc",
        commit: commit("c"),
        publishedAt: at,
      }).changed
    ).toBe(false)
    const held = setHeld(first, "beta", true).manifest
    const next = publishChannel(held, {
      channel: "beta",
      version: "0.1.24-dev.131+ddddddd",
      commit: commit("d"),
      publishedAt: at,
    }).manifest
    expect(next.channels.beta).toMatchObject({
      version: "0.1.24-dev.131+ddddddd",
      held: true,
    })
  })

  it("ends a stable hold when a release is published", () => {
    const held = setHeld(stable, "stable", true).manifest
    expect(JSON.parse(serializeManifest(held)).channels.stable.held).toBe(true)
    const promoted = publishChannel(held, {
      channel: "stable",
      version: "0.1.24",
      commit: commit("e"),
      publishedAt: at,
    }).manifest
    expect(promoted.channels.stable).toMatchObject({
      version: "0.1.24",
      held: false,
    })
  })

  it("never points stable at a beta build", () => {
    expect(() =>
      publishChannel(stable, {
        channel: "stable",
        version: "0.1.24-dev.130+bbbbbbb",
        commit: commit("b"),
        publishedAt: at,
      })
    ).toThrow("release version")
  })

  it("refuses to write a manifest updaters would reject", () => {
    expect(() =>
      serializeManifest(
        publishChannel(parseManifest(null), {
          channel: "beta",
          version: "0.1.24-dev.1+fffffff",
          commit: commit("f"),
          publishedAt: at,
        }).manifest
      )
    ).toThrow("stable is required")
  })

  it("soaks a beta only while installs run it", () => {
    const hour = 3_600_000
    const point = (at: number, c: string, held = false) => ({
      at: at * hour,
      manifest: setHeld(
        publishChannel(stable, {
          channel: "beta",
          version: `0.1.24-dev.${at + 1}+${c.repeat(7)}`,
          commit: commit(c),
          publishedAt: String(at),
        }).manifest,
        "beta",
        held
      ).manifest,
    })
    const history = [
      point(0, "a"),
      point(10, "a", true),
      point(12, "a"),
      point(30, "b"),
    ]
    // Ten hours, a two-hour hold that doesn't count, then 18 more hours
    // until a newer beta replaced it.
    expect(betaResidenceMs(history, commit("a"), 40 * hour)).toBe(28 * hour)
    expect(betaResidenceMs(history, commit("b"), 40 * hour)).toBe(10 * hour)
    expect(betaResidenceMs(history, commit("c"), 40 * hour)).toBe(0)
  })

  it("prunes old betas but never the one the channel points at", () => {
    const tags = ["v0.1.23", "v0.1.24-dev.3", "v0.1.24-dev.10", "v0.1.24-dev.2"]
    expect(betaTagsToPrune(tags, 1, "v0.1.24-dev.10")).toEqual([
      "v0.1.24-dev.3",
      "v0.1.24-dev.2",
    ])
    expect(betaTagsToPrune(tags, 1, "v0.1.24-dev.3")).toEqual(["v0.1.24-dev.2"])
  })
})
