import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { runSuiteSchedule } from "./schedule.ts"

const ids = [
  "bun-standard",
  "bun-server",
  "cli-boundary",
  "packaged-boundaries",
  "control-plane",
  "gateway-bun",
  "gateway-worker",
  "web-browser",
  "desktop-contracts",
  "unknown-future-lane",
]

describe("canonical suite scheduling", () => {
  test("executes every selected lane once with at most two active, isolating heavy and unknown lanes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.shuffledSubarray(ids), async (selected) => {
        const active = new Set<string>()
        const seen: string[] = []
        const exclusive = new Set([
          "web-browser",
          "desktop-contracts",
          "unknown-future-lane",
        ])
        expect(
          await runSuiteSchedule(
            selected.map((id) => ({ id })),
            async ({ id }) => {
              active.add(id)
              seen.push(id)
              expect(active.size).toBeLessThanOrEqual(2)
              if ([...active].some((name) => exclusive.has(name)))
                expect(active.size).toBe(1)
              await Promise.resolve()
              active.delete(id)
              return false
            }
          )
        ).toBe(false)
        expect(seen.toSorted()).toEqual(selected.toSorted())
      }),
      { numRuns: 50 }
    )
  })

  test.each([false, true])(
    "drains the free slot and stops pending work after failure (%s)",
    async (shouldFail) => {
      const server = Promise.withResolvers<void>()
      const companionDone = Promise.withResolvers<void>()
      const seen: string[] = []
      const run = runSuiteSchedule(
        [
          "bun-standard",
          "bun-server",
          "cli-boundary",
          "control-plane",
          "web-browser",
        ].map((id) => ({ id })),
        async ({ id }, signal) => {
          seen.push(id)
          if (id === "bun-server") {
            signal.addEventListener("abort", () => server.resolve(), {
              once: true,
            })
            await server.promise
            expect(signal.aborted).toBe(shouldFail)
          }
          if (id === "cli-boundary" && shouldFail) {
            companionDone.resolve()
            return true
          }
          if (id === "control-plane") companionDone.resolve()
          return false
        }
      )
      try {
        await companionDone.promise
        // The cloud lane can complete while the server remains blocked; a failed
        // companion must instead prevent that lane and the exclusive browser lane.
        expect(seen.includes("control-plane")).toBe(!shouldFail)
        expect(seen).not.toContain("web-browser")
      } finally {
        server.resolve()
      }
      expect(await run).toBe(shouldFail)
      expect(seen.includes("control-plane")).toBe(!shouldFail)
      expect(seen.includes("web-browser")).toBe(!shouldFail)
    }
  )
})


test("a known failure stops pending lanes before the failing lane finishes cleanup", async () => {
  const started = Promise.withResolvers<void>()
  const timedOut = Promise.withResolvers<void>()
  const companionDone = Promise.withResolvers<void>()
  const cleanup = Promise.withResolvers<void>()
  const seen: string[] = []
  const run = runSuiteSchedule(
    ["bun-server", "bun-standard", "cli-boundary"].map((id) => ({ id })),
    async ({ id }, signal, fail) => {
      seen.push(id)
      if (id === "bun-server") {
        await started.promise
        fail()
        timedOut.resolve()
        await cleanup.promise
        return true
      }
      started.resolve()
      await timedOut.promise
      expect(signal.aborted).toBe(true)
      companionDone.resolve()
      return false
    }
  )
  try {
    await companionDone.promise
    await Promise.resolve()
    expect(seen).toEqual(["bun-server", "bun-standard"])
  } finally {
    cleanup.resolve()
  }
  expect(await run).toBe(true)
  expect(seen).toEqual(["bun-server", "bun-standard"])
})
