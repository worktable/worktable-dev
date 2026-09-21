import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { notifyWorkspaceChangeAndWaitOrThrow } from "./workspace-events.ts"
import { setWorkspaceRootOverride, workspaceCacheKey } from "./workspace.ts"

describe("workspace collaboration epoch", () => {
  let root: string
  let appDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worktable-collab-workspace-"))
    appDir = await mkdtemp(join(tmpdir(), "worktable-collab-app-"))
    setWorkspaceRootOverride(root)
    setAppDirOverride(appDir)
  })

  afterEach(async () => {
    setWorkspaceRootOverride(null)
    setAppDirOverride(null)
    await rm(root, { recursive: true, force: true })
    await rm(appDir, { recursive: true, force: true })
  })

  it("persists across ordinary starts and rotates through workspace reset", async () => {
    const first = await getWorkspaceCollaborationEpoch()
    expect(await getWorkspaceCollaborationEpoch()).toBe(first)

    await notifyWorkspaceChangeAndWaitOrThrow({ type: "workspaceReset" })

    const rotated = await getWorkspaceCollaborationEpoch()
    expect(rotated).not.toBe(first)
    const path = join(appDir, "yjs", workspaceCacheKey(), "epoch")
    expect((await readFile(path, "utf8")).trim()).toBe(rotated)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
