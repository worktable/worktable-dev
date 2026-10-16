import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { DocumentId } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import {
  markDocumentGenerationCheckpointV2,
  writeDocumentGenerationV2,
} from "./document-version-store-v2.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import {
  inspectWorkspaceSnapshot,
  writeWorkspaceSnapshot,
} from "./workspace-snapshot.ts"
import {
  beginPreparedWorkspaceReplacement,
  createWorkspaceReplacementPaths,
} from "./workspace-replacement.ts"
import {
  calculateWorkspaceContentCheckpoint,
  inspectPortableWorkspaceTree,
  portableWorkspaceCheckpoint,
  setWorkspaceExportCaptureHookForTests,
  setWorkspaceExportCaptureRemovalHookForTests,
} from "./workspace-transfer-v2.ts"

import { WorkspaceBackupNotifier } from "./workspace-backup-notifier.ts"

let root: string
let workspace: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-snapshot-"))
  workspace = join(root, "workspace")
  setAppDirOverride(join(root, "app"))
  setWorkspaceRootOverride(workspace)
  ensureWorkspaceManifest()
})
afterEach(async () => {
  setSystemTime()
  setWorkspaceExportCaptureHookForTests(null)
  setWorkspaceExportCaptureRemovalHookForTests(null)
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("portable workspace snapshots", () => {
  it("records inside the hold only what changed since the pre-copy", async () => {
    const write = async (path: string, content: string) => {
      await mkdir(dirname(join(workspace, path)), { recursive: true })
      await writeFile(join(workspace, path), content)
    }
    for (let index = 0; index < 100; index += 1)
      await write(`spaces/notes/docs/unchanged-${index}.md`, `Note ${index}`)
    await write("modified.md", "before")
    await write("same-size.md", "aaaa")
    await write("deleted.md", "deleted later")
    await write("removed/nested/file.md", "removed later")
    const documentId = "doc_VVVVVVVVVVVVVVVVVVVVVV" as DocumentId
    const versions: string[] = []
    for (let index = 1; index <= 3; index += 1) {
      const generationId = `2020-01-0${index}T00-00-00-000Z-000000-version${index}`
      await writeDocumentGenerationV2({
        workspaceRoot: workspace,
        spaceId: "notes",
        documentId,
        generationId,
        logicalPath: "history",
        format: { id: BUILTIN_DOCUMENT_FORMATS.markdown, sourceVersion: 1 },
        operation: "update",
        createdAt: `2020-01-0${index}T00:00:00.000Z`,
        createdBy: "test",
        source: "test",
        authoredSource: {
          kind: "file",
          entries: [{ path: "document.md", bytes: Buffer.from(`${index}`) }],
        },
      })
      versions.push(`versions/notes/documents/${documentId}/${generationId}`)
    }
    let held: string[] = []
    setWorkspaceExportCaptureHookForTests(async (entry) => {
      if (entry.held) held.push(entry.path)
    })
    const quiet = <R>(capture: () => Promise<R>) => capture()

    // Files written within the timestamp window could be rewritten in the
    // same tick without changing their metadata, so the hold reads them again.
    // Versions are never rewritten in place, so they are copied beforehand.
    await writeWorkspaceSnapshot(join(root, "recent"), {
      withCaptureBarrier: quiet,
    })
    expect(held).toContain("modified.md")
    expect(held).toHaveLength(105)

    setSystemTime(new Date(Date.now() + 60_000))
    held = []
    const saved = await writeWorkspaceSnapshot(join(root, "snapshot"), {
      withCaptureBarrier: async (capture) => {
        // Edits between the pre-copy and the hold.
        await write("modified.md", "after, and longer")
        const sameSize = join(workspace, "same-size.md")
        const before = await stat(sameSize)
        await writeFile(sameSize, "bbbb")
        await utimes(sameSize, before.atime, before.mtime)
        await rm(join(workspace, "deleted.md"))
        await rm(join(workspace, "removed"), { recursive: true })
        await write("added/new.md", "new")
        // Sealing a settled version renames a new manifest over its own.
        await markDocumentGenerationCheckpointV2({
          workspaceRoot: workspace,
          spaceId: "notes",
          documentId,
          generationId: versions[1]!.split("/").at(-1)!,
          checkpoint: { meaningful: true, kind: "source-transition" },
        })
        return capture()
      },
    })
    expect(held.sort()).toEqual([
      "added",
      "added/new.md",
      "modified.md",
      "same-size.md",
      `${versions[1]}/manifest.json`,
    ])
    // The same capture a full copy of the final tree makes.
    const tree = await inspectPortableWorkspaceTree(workspace)
    expect({ directories: saved.directories, files: saved.files }).toEqual(tree)
    expect(saved.sourceCheckpoint).toBe(portableWorkspaceCheckpoint(tree))
    await expect(
      inspectWorkspaceSnapshot(join(root, "snapshot"))
    ).resolves.toEqual(saved)
    expect(
      await readFile(
        join(root, "snapshot", "workspace", "same-size.md"),
        "utf8"
      )
    ).toBe("bbbb")

    // An unchanged tree keeps its checkpoints.
    held = []
    const again = await writeWorkspaceSnapshot(join(root, "again"), {
      withCaptureBarrier: quiet,
    })
    expect(held).toEqual([])
    expect(again.sourceCheckpoint).toBe(saved.sourceCheckpoint)
    expect(again.contentCheckpoint).toBe(saved.contentCheckpoint)
    expect(again.files).toEqual(saved.files)
  })

  it("stops a cancelled pre-copy before holding writers and removes its scratch", async () => {
    await writeFile(join(workspace, "settled.md"), "settled")
    setSystemTime(new Date(Date.now() + 60_000))
    const cancellation = new AbortController()
    setWorkspaceExportCaptureHookForTests(async (entry) => {
      if (!entry.held) cancellation.abort(new Error("capture cancelled"))
    })
    let held = false
    await expect(
      writeWorkspaceSnapshot(join(root, "cancelled"), {
        signal: cancellation.signal,
        withCaptureBarrier: async (capture) => {
          held = true
          return capture()
        },
      })
    ).rejects.toThrow("capture cancelled")
    expect(held).toBe(false)
    expect(
      await readdir(join(root, "app", "workspace-transfers", "captures"))
    ).toEqual([])
    expect((await readdir(root)).sort()).toEqual(["app", "workspace"])
  })

  it("drains cancelled copies before releasing writers and then cleans scratch outside the barrier", async () => {
    // Both were just written, so the hold copies them.
    await writeFile(join(workspace, "held.md"), "held copy")
    await writeFile(join(workspace, "failed.md"), "failed copy")
    const cancellation = new AbortController()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const enteredCopy = new Promise<void>((resolve) => {
      entered = resolve
    })
    let failed!: () => void
    const copyFailed = new Promise<void>((resolve) => {
      failed = resolve
    })
    setWorkspaceExportCaptureHookForTests(async (entry) => {
      if (entry.path === "held.md") {
        entered()
        await held
      }
      if (entry.path === "failed.md") {
        await enteredCopy
        failed()
        cancellation.abort(new Error("capture cancelled"))
      }
    })
    let barrier = false
    let cleanedOutsideBarrier = false
    setWorkspaceExportCaptureRemovalHookForTests(async () => {
      cleanedOutsideBarrier = !barrier
    })
    const snapshot = writeWorkspaceSnapshot(join(root, "failed-snapshot"), {
      signal: cancellation.signal,
      withCaptureBarrier: async (capture) => {
        barrier = true
        try {
          return await capture()
        } finally {
          barrier = false
        }
      },
    })
    // Observe the failure without allowing an unhandled rejection to race the assertion.
    const outcome = snapshot.then(
      () => null,
      (error) => error
    )
    try {
      await copyFailed
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(barrier).toBe(true)
    } finally {
      release()
    }
    expect((await outcome)?.message).toBe("capture cancelled")
    expect(cleanedOutsideBarrier).toBe(true)
    expect(barrier).toBe(false)
    expect(
      await readdir(join(root, "app", "workspace-transfers", "captures"))
    ).toEqual([])
  })
  it.each([1, 2] as const)(
    "captures layout %i with full history and restores it while preserving current identity",
    async (version) => {
      const manifestPath = join(workspace, "worktable.workspace.json")
      const identity = {
        ...JSON.parse(await readFile(manifestPath, "utf8")),
        version,
      }
      await writeFile(manifestPath, JSON.stringify(identity))
      await mkdir(join(workspace, "spaces", "empty"), { recursive: true })
      await mkdir(join(workspace, "versions", "notes"), { recursive: true })
      await writeFile(
        join(workspace, "versions", "notes", "old.json"),
        '{"content":"older"}'
      )
      await writeFile(join(workspace, "note.md"), "saved")
      let barrier = false
      const saved = await writeWorkspaceSnapshot(join(root, "snapshot"), {
        withCaptureBarrier: async (capture) => {
          barrier = true
          try {
            return await capture()
          } finally {
            barrier = false
            // Upload is allowed to overlap later editing; its bytes stay frozen.
            await writeFile(join(workspace, "note.md"), "newer")
          }
        },
      })
      expect(barrier).toBe(false)
      expect(saved.workspaceStorageVersion).toBe(version)
      expect(
        saved.files.some((file) => file.path === "versions/notes/old.json")
      ).toBe(true)
      expect(saved.directories.some((dir) => dir.path === "spaces/empty")).toBe(
        true
      )
      await expect(
        inspectWorkspaceSnapshot(join(root, "snapshot"), {
          workspaceId: identity.id,
        })
      ).resolves.toEqual(saved)
      // Cross-layout restore must not label a historical tree with today's layout.
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...identity,
          version: version === 1 ? 2 : 1,
          name: "Renamed today",
        })
      )
      const paths = createWorkspaceReplacementPaths()
      await cp(join(root, "snapshot", "workspace"), paths.stagingPath, {
        recursive: true,
      })
      const transaction = await beginPreparedWorkspaceReplacement(
        paths.stagingPath,
        paths.backupPath,
        saved.contentCheckpoint,
        await calculateWorkspaceContentCheckpoint(workspace),
        {
          manifest: "checkpoint",
          expectedSourceCheckpoint: saved.sourceCheckpoint,
        }
      )
      await transaction.commit()
      expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
        id: identity.id,
        name: "Renamed today",
        version,
      })
      expect(await readFile(join(workspace, "note.md"), "utf8")).toBe("saved")
    }
  )

  it("rejects changed bytes, another workspace, and unsupported layouts", async () => {
    const destination = join(root, "snapshot")
    const saved = await writeWorkspaceSnapshot(destination)
    await expect(
      inspectWorkspaceSnapshot(destination, { workspaceId: "ws_another" })
    ).rejects.toThrow("identity")
    await writeFile(
      join(destination, "workspace", "injected.md"),
      "not captured"
    )
    await expect(inspectWorkspaceSnapshot(destination)).rejects.toThrow(
      "integrity"
    )
    await rm(join(destination, "workspace", "injected.md"))
    const metadata = { ...saved, workspaceStorageVersion: 999 }
    await writeFile(
      join(destination, "snapshot.json"),
      JSON.stringify(metadata)
    )
    await expect(inspectWorkspaceSnapshot(destination)).rejects.toThrow()
  })

  it("refuses in-workspace destinations, overwrites, and linked content", async () => {
    await expect(
      writeWorkspaceSnapshot(join(workspace, "backup"))
    ).rejects.toThrow("outside")
    const destination = join(root, "snapshot")
    await writeWorkspaceSnapshot(destination)
    await expect(writeWorkspaceSnapshot(destination)).rejects.toThrow(
      "already exists"
    )
    await symlink(join(root, "app"), join(workspace, "linked"))
    await expect(writeWorkspaceSnapshot(join(root, "other"))).rejects.toThrow()
  })
})

describe("durable backup change reports", () => {
  async function until(predicate: () => Promise<boolean>) {
    // A monotonic clock, so a test that sets the system time still times out.
    const deadline = performance.now() + 3000
    while (!(await predicate())) {
      if (performance.now() >= deadline)
        throw new Error("backup report did not settle")
      // test-policy: external-readiness-backoff (persisted outbox and HTTP delivery)
      await Bun.sleep(10)
    }
  }
  it("retries a persisted unacknowledged report after restart and audits external edits", async () => {
    const ledger = join(root, "outbox.json")
    let attempted = false
    const first = new WorkspaceBackupNotifier(
      ledger,
      workspace,
      async (_, signal) => {
        attempted = true
        await new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        )
      }
    )
    await first.initialize()
    await first.audit()
    await until(async () => attempted)
    await first.stop()
    const pending = JSON.parse(await readFile(ledger, "utf8"))
    expect(pending.generation).toBeGreaterThan(pending.reported)
    const reports: { epoch: string; generation: number }[] = []
    const second = new WorkspaceBackupNotifier(
      ledger,
      workspace,
      async (value) => {
        reports.push(value)
      }
    )
    try {
      await second.initialize()
      await until(async () => {
        const state = JSON.parse(await readFile(ledger, "utf8"))
        return state.reported === pending.generation
      })
      expect(reports[0]).toEqual({
        epoch: pending.epoch,
        generation: pending.generation,
      })
      await second.audit()
      await writeFile(join(workspace, "outside-editor.md"), "External content")
      await second.audit()
      await until(async () =>
        reports.some((report) => report.generation > pending.generation)
      )
    } finally {
      await second.stop()
    }
  })
  it("notices a same-size edit to a file whose hash an earlier audit remembered", async () => {
    const file = join(workspace, "settled.md")
    await writeFile(file, "Settled content")
    const past = new Date(Date.now() - 60_000)
    await utimes(file, past, past)
    const reports: number[] = []
    const notifier = new WorkspaceBackupNotifier(
      join(root, "outbox.json"),
      workspace,
      async (value) => {
        reports.push(value.generation)
      }
    )
    try {
      await notifier.initialize()
      // Audit once every file has settled, so the audit remembers its hash.
      setSystemTime(new Date(Date.now() + 60_000))
      await notifier.audit()
      await until(async () => reports.length === 1)
      await writeFile(file, "Changed content")
      await notifier.audit()
      await until(async () => reports.length === 2)
    } finally {
      setSystemTime()
      await notifier.stop()
    }
  })
  it("persists edits arriving during a report without acknowledging them with the older request", async () => {
    const ledger = join(root, "outbox.json")
    let release!: () => void
    let firstGeneration = 0
    let calls = 0
    const notifier = new WorkspaceBackupNotifier(
      ledger,
      workspace,
      async (value) => {
        calls += 1
        if (calls === 1) {
          firstGeneration = value.generation
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
      }
    )
    try {
      await notifier.initialize()
      await notifier.audit()
      await until(async () => calls === 1)
      notifier.changed()
      release()
      await until(async () => {
        const state = JSON.parse(await readFile(ledger, "utf8"))
        return state.reported > firstGeneration
      })
      expect(calls).toBeGreaterThan(1)
    } finally {
      release?.()
      await notifier.stop()
    }
  })
})
