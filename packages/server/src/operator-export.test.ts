import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  cleanupExpiredOperatorWorkspaceExports,
  disableAuthorizedOperatorRequestTimeout,
  initializeLocalOperatorToken,
  LOCAL_OPERATOR_EXPORT_PATH,
  LOCAL_OPERATOR_TOKEN_HEADER,
  resetLocalOperatorTokenForTests,
} from "./operator-export.ts"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-operator-timeout-"))
  setAppDirOverride(root)
})

afterEach(async () => {
  resetLocalOperatorTokenForTests()
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("live operator export timeout", () => {
  it("disables the idle timeout only for the authenticated local export", () => {
    const token = initializeLocalOperatorToken()
    const timeout = mock(() => {})
    const authorized = new Request(
      `http://127.0.0.1${LOCAL_OPERATOR_EXPORT_PATH}`,
      {
        method: "POST",
        headers: { [LOCAL_OPERATOR_TOKEN_HEADER]: token },
      }
    )
    const unauthorized = new Request(
      `http://127.0.0.1${LOCAL_OPERATOR_EXPORT_PATH}`,
      { method: "POST" }
    )

    expect(
      disableAuthorizedOperatorRequestTimeout(authorized, { timeout })
    ).toBe(true)
    expect(
      disableAuthorizedOperatorRequestTimeout(unauthorized, { timeout })
    ).toBe(false)
    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(authorized, 0)
  })

  it("sweeps expired artifacts but preserves the exact active worker", async () => {
    const directory = join(root, "operator-exports")
    await mkdir(directory)
    const operationId = "workspace-export-active"
    const artifact = join(directory, `${operationId}.wtb`)
    const started = `${artifact}.started`
    const processStat = await readFile(`/proc/${process.pid}/stat`, "utf8")
    const incarnation = processStat
      .slice(processStat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/)[19]!
    await writeFile(artifact, "package")
    await writeFile(started, `${process.pid}\n${incarnation}\n`)
    const old = new Date(Date.now() - 60_000)
    await Promise.all([utimes(artifact, old, old), utimes(started, old, old)])

    await expect(
      cleanupExpiredOperatorWorkspaceExports({ retentionMs: 0 })
    ).resolves.toBe(0)
    await expect(stat(artifact)).resolves.toBeDefined()

    await rm(started)
    await expect(
      cleanupExpiredOperatorWorkspaceExports({ retentionMs: 0 })
    ).resolves.toBe(1)
    await expect(stat(artifact)).rejects.toThrow()
  })
})
