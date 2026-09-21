import { afterEach, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ensureIsolatedDevRoot,
  isolatedDevEnvironment,
  isolatedDevRoot,
  parseIsolatedDevArgs,
  resetIsolatedDevRoot,
} from "./dev-isolated"

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true })
})

function makeTemporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(root)
  return root
}

describe("isolated Desktop development launcher", () => {
  test("parses only the supported review controls", () => {
    expect(parseIsolatedDevArgs([])).toEqual({
      help: false,
      reset: false,
    })
    expect(parseIsolatedDevArgs(["--reset"])).toEqual({
      help: false,
      reset: true,
    })
    expect(() => parseIsolatedDevArgs(["--root", "/tmp/unsafe"])).toThrow(
      "Unknown isolated Desktop option"
    )
  })

  test("uses a stable repo-specific directory", () => {
    const base = makeTemporaryRoot("worktable-desktop-dev-base-")
    const repository = makeTemporaryRoot("worktable-desktop-dev-repo-")
    expect(isolatedDevRoot(repository, base)).toBe(
      isolatedDevRoot(repository, base)
    )
    expect(isolatedDevRoot(repository, base)).toStartWith(
      join(base, "worktable-desktop-dev")
    )
  })

  test("creates isolated paths and strips ambient Worktable overrides", () => {
    const base = makeTemporaryRoot("worktable-desktop-dev-root-")
    const repository = realpathSync(
      makeTemporaryRoot("worktable-desktop-dev-repository-")
    )
    const root = join(base, "owned")
    const paths = ensureIsolatedDevRoot(root, repository)
    const environment = isolatedDevEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/Users/developer",
        WORKTABLE_APP_DIR: "/real/app",
        WORKTABLE_DESKTOP_PORT: "7480",
        WORKTABLE_DESKTOP_WORKSPACE: "/real/workspace",
        WORKTABLE_WORKSPACE: "/real/workspace",
      },
      paths
    )

    expect(paths.home).toBe(join(root, "home"))
    expect(paths.appData).toBe(join(root, "app-data"))
    expect(paths.workspace).toBe(join(root, "home", "Worktable"))
    expect(environment.PATH).toBe("/usr/bin")
    expect(environment.HOME).toBe("/Users/developer")
    expect(environment.WORKTABLE_DESKTOP_APP_DIR).toBe(paths.appData)
    expect(environment.WORKTABLE_DESKTOP_LOCAL_APP_DIR).toBe(paths.localAppData)
    expect(environment.WORKTABLE_DESKTOP_DEFAULT_WORKSPACE).toBe(
      paths.workspace
    )
    expect(environment.WORKTABLE_APP_DIR).toBeUndefined()
    expect(environment.WORKTABLE_DESKTOP_PORT).toBeUndefined()
    expect(environment.WORKTABLE_DESKTOP_WORKSPACE).toBeUndefined()
    expect(environment.WORKTABLE_WORKSPACE).toBeUndefined()

    const manifest = JSON.parse(
      readFileSync(join(root, ".worktable-desktop-dev.json"), "utf8")
    )
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: "worktable.desktop-dev",
      repoRoot: repository,
    })
  })

  test("resets only a directory owned by this repo", () => {
    const base = makeTemporaryRoot("worktable-desktop-dev-reset-")
    const repository = realpathSync(
      makeTemporaryRoot("worktable-desktop-dev-reset-repository-")
    )
    const owned = join(base, "owned")
    ensureIsolatedDevRoot(owned, repository)
    expect(resetIsolatedDevRoot(owned, repository)).toBe(true)

    const foreign = join(base, "foreign")
    mkdirSync(foreign)
    writeFileSync(join(foreign, ".worktable-desktop-dev.json"), "{}")
    expect(() => resetIsolatedDevRoot(foreign, repository)).toThrow(
      "Refusing to reset unowned"
    )
  })
})
