/**
 * Process-level storage isolation for server tests.
 *
 * This preload must run before test-setup.ts or any server module. Individual
 * tests can still use path overrides for their fixtures; clearing an override
 * returns to this disposable baseline instead of the developer's Worktable.
 */
import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const testRoot = mkdtempSync(join(tmpdir(), "worktable-server-test-"))

process.env["WORKTABLE_WORKSPACE"] = join(testRoot, "workspace")
process.env["WORKTABLE_APP_DIR"] = join(testRoot, "app")

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true })
})
