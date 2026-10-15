import { describe, expect, it } from "bun:test"
import {
  betaResidenceMs,
  betaTagsToPrune,
  desktopBuildDue,
  parseManifest,
  publishChannel,
  publishDesktop,
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

  it("prunes old betas but never one the channel or Desktop points at", () => {
    const tags = ["v0.1.23", "v0.1.24-dev.3", "v0.1.24-dev.10", "v0.1.24-dev.2"]
    expect(betaTagsToPrune(tags, 1, ["v0.1.24-dev.10"])).toEqual([
      "v0.1.24-dev.3",
      "v0.1.24-dev.2",
    ])
    expect(
      betaTagsToPrune(tags, 1, ["v0.1.24-dev.10", "v0.1.24-dev.3"])
    ).toEqual(["v0.1.24-dev.2"])
  })

  it("offers Desktop the newest beta with a Desktop build, across new betas", () => {
    const beta = (manifest: typeof stable, n: number, c: string) =>
      publishChannel(manifest, {
        channel: "beta",
        version: `0.1.24-dev.${n}+${c.repeat(7)}`,
        commit: commit(c),
        publishedAt: at,
      }).manifest
    const first = beta(stable, 130, "b")
    const built = publishDesktop(first, {
      version: "0.1.24-dev.130+bbbbbbb",
      commit: commit("b"),
      publishedAt: at,
    })
    expect(built.changed).toBe(true)
    // Beta moves on; Desktop keeps the build it has.
    const moved = beta(built.manifest, 131, "c")
    expect(moved.channels.beta).toMatchObject({
      version: "0.1.24-dev.131+ccccccc",
      desktop: { version: "0.1.24-dev.130+bbbbbbb", tag: "v0.1.24-dev.130" },
    })
    expect(JSON.parse(serializeManifest(moved)).channels.beta.desktop.tag).toBe(
      "v0.1.24-dev.130"
    )
    // Only forward, only betas that exist, only dev builds of their commit.
    expect(
      publishDesktop(moved, {
        version: "0.1.24-dev.129+ddddddd",
        commit: commit("d"),
        publishedAt: at,
      }).changed
    ).toBe(false)
    for (const input of [
      { version: "0.1.24-dev.132+eeeeeee", commit: commit("e") },
      { version: "0.1.24-dev.131+ccccccc", commit: commit("f") },
      { version: "0.1.24", commit: commit("c") },
    ]) {
      expect(() =>
        publishDesktop(moved, { ...input, publishedAt: at })
      ).toThrow()
    }
    expect(() =>
      publishDesktop(stable, {
        version: "0.1.24-dev.130+bbbbbbb",
        commit: commit("b"),
        publishedAt: at,
      })
    ).toThrow("no build")
  })

  it("builds Desktop for a new beta at most once per interval", () => {
    const hour = 3_600_000
    const now = 100 * hour
    const moved = publishChannel(
      publishDesktop(
        publishChannel(stable, {
          channel: "beta",
          version: "0.1.24-dev.130+bbbbbbb",
          commit: commit("b"),
          publishedAt: at,
        }).manifest,
        {
          version: "0.1.24-dev.130+bbbbbbb",
          commit: commit("b"),
          publishedAt: at,
        }
      ).manifest,
      {
        channel: "beta",
        version: "0.1.24-dev.131+ccccccc",
        commit: commit("c"),
        publishedAt: at,
      }
    ).manifest
    const due = (
      manifest: typeof stable,
      lastAttemptAt: number | null,
      force = false
    ) =>
      desktopBuildDue(manifest, {
        now,
        lastAttemptAt,
        minIntervalMs: 3 * hour,
        force,
      })
    expect(due(moved, now - 4 * hour)).toEqual({
      due: true,
      version: "0.1.24-dev.131+ccccccc",
      tag: "v0.1.24-dev.131",
      commit: commit("c"),
    })
    expect(due(moved, null).due).toBe(true)
    expect(due(moved, now - 2 * hour).due).toBe(false)
    expect(due(moved, now - 2 * hour, true).due).toBe(true)
    // Nothing to build: no beta, a held beta, or a beta that has its build.
    expect(due(stable, null).due).toBe(false)
    expect(due(setHeld(moved, "beta", true).manifest, null, true).due).toBe(
      false
    )
    const current = publishDesktop(moved, {
      version: "0.1.24-dev.131+ccccccc",
      commit: commit("c"),
      publishedAt: at,
    }).manifest
    expect(due(current, null, true)).toEqual({
      due: false,
      reason: "Beta 0.1.24-dev.131+ccccccc already has a Desktop build.",
    })
  })
})
