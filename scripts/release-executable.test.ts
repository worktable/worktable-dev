import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertReportsVersion } from "./release-executable.ts"

let directory: string
let previousVersion: string | undefined
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "release-executable-test-"))
  previousVersion = process.env["WORKTABLE_VERSION"]
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  if (previousVersion === undefined) delete process.env["WORKTABLE_VERSION"]
  else process.env["WORKTABLE_VERSION"] = previousVersion
})

function executable(script: string): string {
  const path = join(directory, "worktable")
  writeFileSync(path, `#!/bin/sh\n${script}\n`)
  chmodSync(path, 0o755)
  return path
}

const host = { platform: "linux", arch: "x64" } as const
const target = { artifact: "worktable-linux-x64.tar.gz", ...host }
const check = (script: string, version = "1.2.3-dev.4+abc1234") =>
  assertReportsVersion({
    executable: executable(script),
    target,
    version,
    host,
  })

test("a built executable must print the build's version", () => {
  expect(check('[ "$1" = --version ] && echo 1.2.3-dev.4+abc1234')).toBe(true)
  // Exits 0 and prints nothing: what a build once produced unnoticed.
  expect(() => check("exit 0")).toThrow(/printed nothing/)
  expect(() => check("echo 1.2.2")).toThrow(
    /should print 1\.2\.3-dev\.4\+abc1234/
  )
  expect(() => check("echo 1.2.3-dev.4+abc1234; exit 3")).toThrow(/exited 3/)
  // The version has to come from the executable, not this machine's settings.
  process.env["WORKTABLE_VERSION"] = "1.2.3-dev.4+abc1234"
  expect(() => check('echo "$WORKTABLE_VERSION"')).toThrow(/printed nothing/)
})

test("an executable for another platform or architecture is not run", () => {
  for (const other of [
    { platform: "linux", arch: "arm64" },
    { platform: "darwin", arch: "x64" },
  ] as const)
    expect(
      assertReportsVersion({
        executable: executable("exit 1"),
        target: { artifact: "worktable-other.tar.gz", ...other },
        version: "1.2.3",
        host,
      })
    ).toBe(false)
})
