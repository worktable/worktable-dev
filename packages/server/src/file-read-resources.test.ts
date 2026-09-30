import { expect, it } from "bun:test"
import { mkdir, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { readBoundedRegularFile } from "./bounded-file.ts"
import { preflightDocumentWorkspace } from "./document-preflight.ts"
import {
  calculateLocalWorkspaceContentCheckpoints,
  writeWorkspaceExportV2,
} from "./workspace-transfer-v2.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

it.skipIf(process.platform !== "linux")(
  "releases source descriptors after bounded reads, census, checkpoints and export",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "worktable-read-resources-"))
    const workspace = join(root, "workspace")
    const note = join(workspace, "spaces", "notes", "docs", "note.md")
    const assertReleased = async () => {
      const targets = await Promise.all(
        (await readdir("/proc/self/fd")).map((fd) =>
          readlink(`/proc/self/fd/${fd}`).catch(() => "")
        )
      )
      expect(targets.filter((target) => target.startsWith(`${root}/`))).toEqual([])
    }
    try {
      setWorkspaceRootOverride(workspace)
      setAppDirOverride(join(root, "app"))
      ensureWorkspaceManifest()
      await mkdir(join(workspace, "spaces", "notes", "docs"), { recursive: true })
      await writeFile(note, "# Preserved content\n")
      await writeFile(
        join(workspace, "spaces", "notes", "space.json"),
        JSON.stringify({
          type: "worktable.space",
          version: 1,
          id: "notes",
          name: "Notes",
          createdAt: "2026-09-30T00:00:00.000Z",
          updatedAt: "2026-09-30T00:00:00.000Z",
          createdBy: "test",
          settings: {},
        })
      )
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await readBoundedRegularFile(note, 1024)).toBe("# Preserved content\n")
        await assertReleased()
        expect((await preflightDocumentWorkspace(workspace)).clean).toBe(true)
        await assertReleased()
        expect((await calculateLocalWorkspaceContentCheckpoints(workspace)).files).toBe(3)
        await assertReleased()
        await writeWorkspaceExportV2(join(root, `export-${attempt}`))
        await assertReleased()
      }
    } finally {
      setWorkspaceRootOverride(null)
      setAppDirOverride(null)
      await rm(root, { recursive: true, force: true })
    }
  }
)
