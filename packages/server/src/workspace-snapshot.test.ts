import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { atomicWriteText } from "./atomic-file.ts"
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
  setWorkspaceCaptureClockForTests,
  setWorkspaceExportCaptureHookForTests,
  setWorkspaceExportCaptureRemovalHookForTests,
  setWorkspaceSourceListingHookForTests,
  type PortableContentHashCache,
  type WorkspaceCaptureReport,
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
  setWorkspaceCaptureClockForTests(null)
  setWorkspaceSourceListingHookForTests(null)
  setWorkspaceExportCaptureHookForTests(null)
  setWorkspaceExportCaptureRemovalHookForTests(null)
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("portable workspace snapshots", () => {
  it("drains cancelled copies before releasing writers and then cleans scratch outside the barrier", async () => {
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
      const attachment = randomBytes(3 * 1024 * 1024 + 17)
      await writeFile(join(workspace, "attachment.bin"), attachment)
      let barrier = false
      let report: WorkspaceCaptureReport | undefined
      const saved = await writeWorkspaceSnapshot(join(root, "snapshot"), {
        onCaptureReport: (captured) => {
          report = captured
        },
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
      // A reflink where the filesystem supports one, otherwise a copy.
      expect(report?.method).toMatch(/^(reflink|copy)$/)
      expect(report?.files).toBe(saved.files.length)
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
      expect(
        (await readFile(join(workspace, "attachment.bin"))).equals(attachment)
      ).toBe(true)
    }
  )

  it("stages before the barrier, recaptures what changed before it, and reads no unchanged bytes inside it", async () => {
    // Treat files as settled, as they are in a workspace edited minutes ago.
    setWorkspaceCaptureClockForTests(() => Date.now() + 60_000)
    const large = join(workspace, "large.bin")
    const handle = await open(large, "w")
    try {
      await handle.truncate(32 * 1024 * 1024)
    } finally {
      await handle.close()
    }
    await writeFile(join(workspace, "replaced.md"), "staged")
    await writeFile(join(workspace, "edited.md"), "staged")
    const readBytes = () =>
      Number(/^rchar: (\d+)$/m.exec(readFileSync("/proc/self/io", "utf8"))![1])
    const countsReads = existsSync("/proc/self/io")
    let barrierRead = 0
    let report: WorkspaceCaptureReport | undefined
    const saved = await writeWorkspaceSnapshot(join(root, "snapshot"), {
      onCaptureReport: (captured) => {
        report = captured
      },
      withCaptureBarrier: async (capture) => {
        // Writes that land after staging but before the barrier: one through
        // Worktable, which replaces the file, and one in place.
        await atomicWriteText(join(workspace, "replaced.md"), "replaced")
        await writeFile(join(workspace, "edited.md"), "edited in place")
        const before = countsReads ? readBytes() : 0
        try {
          return await capture()
        } finally {
          if (countsReads) barrierRead = readBytes() - before
          await atomicWriteText(join(workspace, "replaced.md"), "too late")
        }
      },
    })
    const captured = join(root, "snapshot", "workspace")
    expect(await readFile(join(captured, "replaced.md"), "utf8")).toBe(
      "replaced"
    )
    expect(await readFile(join(captured, "edited.md"), "utf8")).toBe(
      "edited in place"
    )
    expect((await stat(join(captured, "large.bin"))).size).toBe(
      32 * 1024 * 1024
    )
    await expect(
      inspectWorkspaceSnapshot(join(root, "snapshot"))
    ).resolves.toEqual(saved)
    // The barrier stats the large file but never reads it.
    if (countsReads) expect(barrierRead).toBeLessThan(4 * 1024 * 1024)
    expect(report?.barrierFiles).toBe(2)
  })

  it("survives a write finishing and a document being deleted while staging lists the workspace", async () => {
    const docs = join(workspace, "spaces", "notes", "docs")
    await mkdir(docs, { recursive: true })
    await writeFile(join(docs, "kept.md"), "kept")
    await writeFile(join(docs, "deleted.md"), "deleted")
    // An atomic write in flight: its temporary file is renamed into place.
    const temporary = join(
      docs,
      `.worktable-write-${process.pid}-${"0".repeat(32)}.tmp`
    )
    await writeFile(temporary, "written")
    let raced = false
    // The first listing is staging's, which runs while writers continue.
    setWorkspaceSourceListingHookForTests(async (directory, names) => {
      if (raced || directory !== "spaces/notes/docs") return
      expect(names).toContain(basename(temporary))
      raced = true
      await rename(temporary, join(docs, "written.md"))
      await rm(join(docs, "deleted.md"))
    })
    const saved = await writeWorkspaceSnapshot(join(root, "snapshot"))
    expect(raced).toBe(true)
    const paths = saved.files.map((file) => file.path)
    expect(paths).toContain("spaces/notes/docs/kept.md")
    expect(paths).toContain("spaces/notes/docs/written.md")
    expect(paths).not.toContain("spaces/notes/docs/deleted.md")
    await expect(
      inspectWorkspaceSnapshot(join(root, "snapshot"))
    ).resolves.toEqual(saved)
  })

  it("hashes only files whose identity changed since the last capture", async () => {
    // Treat files as settled, as they are in a workspace edited minutes ago.
    setWorkspaceCaptureClockForTests(() => Date.now() + 60_000)
    // A whole second, so putting the mtime back restores it exactly.
    const earlier = new Date(Math.floor(Date.now() / 1000) * 1000 - 600_000)
    for (const name of ["kept", "edited", "restored", "replaced"]) {
      await writeFile(join(workspace, `${name}.md`), `${name} one`)
      await utimes(join(workspace, `${name}.md`), earlier, earlier)
    }
    const hashCache: PortableContentHashCache = new Map()
    let report: WorkspaceCaptureReport | undefined
    const capture = (name: string) =>
      writeWorkspaceSnapshot(join(root, name), {
        hashCache,
        onCaptureReport: (captured) => {
          report = captured
        },
      })
    const first = await capture("first")
    expect(report?.hashedFiles).toBe(first.files.length)
    const second = await capture("second")
    expect(report?.hashedFiles).toBe(0)
    expect(report?.hashedBytes).toBe(0)
    expect(second.sourceCheckpoint).toBe(first.sourceCheckpoint)

    // Same sizes throughout. One edit is ordinary; two put the old mtime
    // back, one in place (new ctime) and one by rename (new inode).
    await writeFile(join(workspace, "edited.md"), "edited two")
    const restored = join(workspace, "restored.md")
    await writeFile(restored, "restored two")
    await utimes(restored, earlier, earlier)
    const replaced = join(workspace, "replaced.md")
    await writeFile(`${replaced}.new`, "replaced two")
    await utimes(`${replaced}.new`, earlier, earlier)
    await rename(`${replaced}.new`, replaced)

    const third = await capture("third")
    expect(report?.hashedFiles).toBe(3)
    const digest = (text: string) =>
      createHash("sha256").update(text).digest("hex")
    const hashes = new Map(third.files.map((file) => [file.path, file.sha256]))
    expect(hashes.get("kept.md")).toBe(digest("kept one"))
    expect(hashes.get("edited.md")).toBe(digest("edited two"))
    expect(hashes.get("restored.md")).toBe(digest("restored two"))
    expect(hashes.get("replaced.md")).toBe(digest("replaced two"))
    // Every byte of the capture matches what the manifest says.
    await expect(
      inspectWorkspaceSnapshot(join(root, "third"))
    ).resolves.toEqual(third)
  })

  it("inspects a fresh capture by its own record, and reads every byte otherwise", async () => {
    const earlier = new Date(Math.floor(Date.now() / 1000) * 1000 - 600_000)
    await writeFile(join(workspace, "note.md"), "captured")
    await utimes(join(workspace, "note.md"), earlier, earlier)
    const destination = join(root, "snapshot")
    const saved = await writeWorkspaceSnapshot(destination)
    const inspect = async (byCaptureIdentity: boolean) => {
      const report = { hashedFiles: 0, hashedBytes: 0 }
      const manifest = await inspectWorkspaceSnapshot(destination, undefined, {
        byCaptureIdentity,
        report,
      })
      return { manifest, report }
    }
    // Restores take this path: it hashes every file.
    expect((await inspect(false)).report.hashedFiles).toBe(saved.files.length)
    expect(await inspect(true)).toEqual({
      manifest: saved,
      report: { hashedFiles: 0, hashedBytes: 0 },
    })
    // Changed after capture, same size, mtime put back: caught either way.
    const note = join(destination, "workspace", "note.md")
    await writeFile(note, "CAPTURED")
    await utimes(note, earlier, earlier)
    await expect(inspect(true)).rejects.toThrow("integrity")
    await expect(inspect(false)).rejects.toThrow("integrity")
  })

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

  it("captures hidden items whole, and refuses in-workspace destinations, overwrites, and linked content", async () => {
    await expect(
      writeWorkspaceSnapshot(join(workspace, "backup"))
    ).rejects.toThrow("outside")
    // Hidden items aren't shown, but a backup holds them like anything else.
    const docs = join(workspace, "spaces", "notes", "docs")
    await mkdir(join(docs, ".notes"), { recursive: true })
    await writeFile(join(docs, ".notes", "plan.md"), "# Hidden plan\n")
    await writeFile(join(docs, ".env"), "TOKEN=1\n")
    const destination = join(root, "snapshot")
    await writeWorkspaceSnapshot(destination)
    const captured = join(destination, "workspace", "spaces", "notes", "docs")
    expect(await readFile(join(captured, ".notes", "plan.md"), "utf8")).toBe(
      "# Hidden plan\n"
    )
    expect(await readFile(join(captured, ".env"), "utf8")).toBe("TOKEN=1\n")
    await expect(writeWorkspaceSnapshot(destination)).rejects.toThrow(
      "already exists"
    )
    // A link fails a backup, in a Space or anywhere else: only a person's
    // export leaves one out.
    await symlink(join(docs, ".env"), join(docs, "linked.md"))
    await expect(writeWorkspaceSnapshot(join(root, "other"))).rejects.toThrow(
      /refuses symlink/
    )
    await rm(join(docs, "linked.md"))
    await symlink(join(root, "app"), join(workspace, "linked"))
    await expect(writeWorkspaceSnapshot(join(root, "third"))).rejects.toThrow(
      /refuses symlink/
    )
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
