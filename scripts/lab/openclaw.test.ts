import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { artifactFromPackOutput } from "./openclaw.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("OpenClaw lab artifacts", () => {
  test("uses the tarball reported by the current pack command", () => {
    const directory = mkdtempSync(join(tmpdir(), "worktable-openclaw-pack-"))
    temporaryDirectories.push(directory)
    const current = join(directory, "worktable-openclaw-1.2.3.tgz")
    const stale = join(directory, "worktable-openclaw-99.0.0.tgz")
    writeFileSync(current, "current")
    writeFileSync(stale, "stale")

    expect(
      artifactFromPackOutput(
        `Packed @worktable/openclaw@1.2.3\n${current}\n${current}.sha256\n`,
        directory
      )
    ).toBe(realpathSync(current))
  })
})
