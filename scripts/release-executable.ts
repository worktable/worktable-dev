import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ReleaseTarget } from "./release-targets.ts"

/**
 * Runs an executable the build just produced and fails unless `--version`
 * prints the build's version. A compile can succeed and still leave an
 * executable that exits 0 and prints nothing, and no other build step runs
 * what it made. An executable for another platform or architecture can't run
 * here: that is said, and false is returned.
 */
export function assertReportsVersion(options: {
  executable: string
  target: Pick<ReleaseTarget, "artifact" | "platform" | "arch">
  version: string
  host?: { platform: string; arch: string }
}): boolean {
  const { executable, target, version } = options
  const host = options.host ?? {
    platform: process.platform,
    arch: process.arch,
  }
  if (target.platform !== host.platform || target.arch !== host.arch) {
    console.log(
      `[release] not run: ${target.artifact} is built for ${target.platform}-${target.arch} and this host is ${host.platform}-${host.arch}`
    )
    return false
  }
  // Nothing of this machine's Worktable reaches the run: WORKTABLE_VERSION
  // would answer for the executable, and its home stays untouched.
  const home = mkdtempSync(join(tmpdir(), "worktable-release-check-"))
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync([executable, "--version"], {
      env: { PATH: process.env["PATH"] ?? "", HOME: home },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  const printed = result.stdout?.toString().trim() ?? ""
  if (result.exitCode !== 0 || printed !== version) {
    const errors = result.stderr?.toString().trim().slice(0, 2_000)
    throw new Error(
      `${target.artifact}: \`${executable} --version\` should print ${version}. ` +
        `It exited ${result.exitCode ?? `on ${result.signalCode ?? "a timeout"}`} and printed ${
          printed ? JSON.stringify(printed.slice(0, 200)) : "nothing"
        }.${errors ? `\n${errors}` : ""}`
    )
  }
  console.log(`[release] ${target.artifact} reports version ${printed}`)
  return true
}
