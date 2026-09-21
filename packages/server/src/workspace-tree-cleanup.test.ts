import { afterEach, describe, expect, it } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeWorkspaceTree } from "./workspace-tree-cleanup.ts"

let root: string | null = null

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

describe("workspace tree cleanup", () => {
  it("removes nested content whose portable directory modes are read-only", async () => {
    root = await mkdtemp(join(tmpdir(), "worktable-tree-cleanup-"))
    const nested = join(root, "read-only", "nested")
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, "content.md"), "# Portable\n")
    await chmod(nested, 0o500)
    await chmod(join(root, "read-only"), 0o500)
    await chmod(root, 0o500)

    await removeWorkspaceTree(root)

    await expect(stat(root)).rejects.toThrow()
    root = null
  })
})
