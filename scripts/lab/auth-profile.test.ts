import { describe, expect, test } from "bun:test"
import {
  assertReusableAuthAvailable,
  authStorageArgs,
  ensureLabAuthVolume,
  LAB_AUTH_LABEL,
  LAB_AUTH_VOLUME,
} from "./auth-profile.ts"
import type { SandboxSystem } from "./microsandbox.ts"

function fakeSystem(outputs: string[] = []) {
  const calls: string[][] = []
  const system: SandboxSystem = {
    owner: () => "tester",
    run(command, args) {
      calls.push([command, ...args])
      return outputs.shift() ?? ""
    },
  }
  return { system, calls }
}

describe("reusable lab authentication profile", () => {
  test("creates its named volume only when absent", () => {
    const missing = fakeSystem([""])
    ensureLabAuthVolume(missing.system)
    expect(missing.calls.at(-1)).toEqual([
      "msb",
      "volume",
      "create",
      "--quiet",
      LAB_AUTH_VOLUME,
    ])

    const present = fakeSystem([`${LAB_AUTH_VOLUME}\n`])
    ensureLabAuthVolume(present.system)
    expect(present.calls).toHaveLength(1)
  })

  test("keeps ready and clean storage contracts distinct", () => {
    expect(authStorageArgs("ready")).toContain(LAB_AUTH_LABEL)
    expect(authStorageArgs("ready")).toContain("--mount-named")
    expect(authStorageArgs("clean")).toContain("--tmpfs")
    expect(authStorageArgs("clean")).not.toContain(LAB_AUTH_VOLUME)
  })

  test("serializes access to refreshable credentials", () => {
    const available = fakeSystem([""])
    expect(() => assertReusableAuthAvailable(available.system)).not.toThrow()
    const occupied = fakeSystem(["worktable-local-running\n"])
    expect(() => assertReusableAuthAvailable(occupied.system)).toThrow(
      "already mounted"
    )
    expect(occupied.calls[0]).toContain(LAB_AUTH_LABEL)
  })
})
