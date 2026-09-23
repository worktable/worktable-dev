import { expect, test } from "bun:test"
import { finalizeDesktopRelease } from "./finalize-release"

test("independent updater proof progresses while DMG waits, and publishing waits for both", async () => {
  const notarized = Promise.withResolvers<void>()
  const updaterVerified = Promise.withResolvers<void>()
  const calls: string[] = []
  let complete = false
  const finalizing = finalizeDesktopRelease(async (script) => {
    calls.push(script)
    if (script === "finalize-release-dmg.ts") await notarized.promise
    if (script === "verify-release-updater.ts") updaterVerified.resolve()
  }).then(() => {
    complete = true
  })
  await updaterVerified.promise
  expect(calls).not.toContain("verify-release-dmg.ts")
  expect(complete).toBe(false)
  notarized.resolve()
  await finalizing
  expect(calls).toContain("verify-release-dmg.ts")
  expect(complete).toBe(true)
})

test("one failed distributable rejects finalization after the other branch settles", async () => {
  const updater = Promise.withResolvers<void>()
  let updaterSettled = false
  const finalizing = finalizeDesktopRelease(async (script) => {
    if (script === "finalize-release-dmg.ts")
      throw new Error("Apple rejected DMG")
    if (script === "verify-release-updater.ts") {
      await updater.promise
      updaterSettled = true
    }
  })
  updater.resolve()
  await expect(finalizing).rejects.toThrow(
    "Desktop release finalization failed"
  )
  expect(updaterSettled).toBe(true)
})
