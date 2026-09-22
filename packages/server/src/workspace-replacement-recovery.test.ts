import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  beginPreparedWorkspaceReplacement,
  prepareWorkspaceReplacement,
} from "./workspace-replacement.ts"
import {
  acknowledgeWorkspaceReplacementResets,
  recoverInterruptedWorkspaceReplacements,
} from "./workspace-replacement-recovery.ts"
import {
  calculateWorkspaceContentCheckpoint,
  writeWorkspaceExportV2,
} from "./workspace-transfer-v2.ts"
import { removeWorkspaceTree } from "./workspace-tree-cleanup.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

let root: string
let appDir: string
let active: string
let source: string

async function seed(workspace: string, body: string): Promise<void> {
  await mkdir(join(workspace, "spaces", "notes", "docs"), { recursive: true })
  await writeFile(join(workspace, "spaces", "notes", "docs", "note.md"), body)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-replacement-recovery-"))
  appDir = join(root, "app")
  active = join(root, "active")
  source = join(root, "source")
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(active)
  ensureWorkspaceManifest()
  await seed(active, "# Original\n")
  setWorkspaceRootOverride(source)
  ensureWorkspaceManifest()
  await seed(source, "# Replacement\n")
  setWorkspaceRootOverride(active)
})

afterEach(async () => {
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await removeWorkspaceTree(root)
})

describe("interrupted replacement recovery", () => {
  it("allows first-run startup when the configured workspace parent is missing", () => {
    const missing = join(root, "new-user", "nested", "Worktable")
    setWorkspaceRootOverride(missing)

    expect(recoverInterruptedWorkspaceReplacements()).toEqual([])

    setWorkspaceRootOverride(active)
  })

  it("never removes an unowned similarly named committed directory", async () => {
    const personal = join(root, ".active.worktable-backup-personal.committed")
    await mkdir(personal, { recursive: true })
    await writeFile(join(personal, "keep.txt"), "personal\n")

    expect(recoverInterruptedWorkspaceReplacements()).toEqual([])
    expect(await readFile(join(personal, "keep.txt"), "utf8")).toBe(
      "personal\n"
    )
  })

  it.each([
    ["import", false],
    ["import", true],
    ["clear", false],
    ["clear", true],
  ] as const)(
    "%s preserves original content before commit (swapped=%s)",
    async (kind, swapped) => {
      const archive = await writeWorkspaceExportV2(join(root, "incoming"), {
        workspaceRoot: source,
      })
      const prepared = await prepareWorkspaceReplacement(archive.destination)
      const id = "wtx_12345678901234567890"
      const jobDirectory = join(appDir, "workspace-transfers", "jobs", id)
      await mkdir(jobDirectory, { recursive: true })
      await writeFile(
        join(jobDirectory, "job.json"),
        `${JSON.stringify({
          version: 1,
          id,
          kind,
          state: "replacing",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          fileName: "incoming.wtb",
          expectedBytes: archive.bytes,
          receivedBytes: archive.bytes,
          prepared,
        })}\n`
      )

      // Recovery must distinguish confirmation alone from a changed active tree.
      if (swapped) {
        await rename(active, prepared.backupPath)
        await rename(prepared.stagingPath, active)
      }
      expect(
        await readFile(
          join(active, "spaces", "notes", "docs", "note.md"),
          "utf8"
        )
      ).toBe(swapped ? "# Replacement\n" : "# Original\n")

      expect(
        recoverInterruptedWorkspaceReplacements({ details: true })
      ).toEqual([{ id, kind, state: "failed", resetRequired: swapped }])
      // Cleanup must not lose a pending reset if startup dies before applying it.
      setWorkspaceRootOverride(source)
      expect(recoverInterruptedWorkspaceReplacements()).toEqual([])
      setWorkspaceRootOverride(active)
      expect(recoverInterruptedWorkspaceReplacements()).toEqual(swapped ? [id] : [])
      if (swapped) acknowledgeWorkspaceReplacementResets([id])
      expect(recoverInterruptedWorkspaceReplacements()).toEqual([])
      expect(
        await readFile(
          join(active, "spaces", "notes", "docs", "note.md"),
          "utf8"
        )
      ).toBe("# Original\n")
      const recoveredJob = JSON.parse(
        await readFile(join(jobDirectory, "job.json"), "utf8")
      ) as { state: string; error: string; expiresAt: string }
      expect(recoveredJob).toMatchObject({
        state: "failed",
        error: expect.stringContaining(swapped
          ? "recovered the original workspace"
          : "interrupted before the atomic swap"),
      })
      expect(Date.parse(recoveredJob.expiresAt)).toBeGreaterThan(Date.now())
    }
  )

  it.each(["import", "clear"])(
    "never restores a partially deleted %s backup after the commit point",
    async (kind) => {
      const archive = await writeWorkspaceExportV2(join(root, "committed"), {
        workspaceRoot: source,
      })
      const prepared = await prepareWorkspaceReplacement(archive.destination)
      const id = "wtx_12345678901234567891"
      const jobDirectory = join(appDir, "workspace-transfers", "jobs", id)
      await mkdir(jobDirectory, { recursive: true })
      await writeFile(
        join(jobDirectory, "job.json"),
        `${JSON.stringify({
          version: 1,
          id,
          kind,
          state: "replacing",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          fileName: "committed.wtb",
          expectedBytes: archive.bytes,
          receivedBytes: archive.bytes,
          prepared,
        })}\n`
      )

      await rename(active, prepared.backupPath)
      await rename(prepared.stagingPath, active)
      const committedBackup = `${prepared.backupPath}.committed`
      await rename(prepared.backupPath, committedBackup)
      await rm(join(committedBackup, "spaces", "notes", "docs", "note.md"))

      expect(recoverInterruptedWorkspaceReplacements()).toEqual([id])
      expect(
        await readFile(
          join(active, "spaces", "notes", "docs", "note.md"),
          "utf8"
        )
      ).toBe("# Replacement\n")
      expect(
        JSON.parse(await readFile(join(jobDirectory, "job.json"), "utf8"))
      ).toMatchObject({ state: "complete" })
    }
  )

  it("retains the rollback path when a storage migration committed before reporting", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "migration"), {
      workspaceRoot: source,
    })
    const prepared = await prepareWorkspaceReplacement(archive.destination)
    const id = "wsm_12345678901234567890"
    const jobDirectory = join(appDir, "workspace-transfers", "jobs", id)
    await mkdir(jobDirectory, { recursive: true })
    await writeFile(
      join(jobDirectory, "job.json"),
      `${JSON.stringify({
        id,
        kind: "document-storage-v2",
        state: "replacing",
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        prepared,
      })}\n`
    )
    const transaction = await beginPreparedWorkspaceReplacement(
      prepared.stagingPath,
      prepared.backupPath,
      prepared.contentCheckpoint,
      await calculateWorkspaceContentCheckpoint(active)
    )
    await transaction.commit()
    const backupPath = `${prepared.backupPath}.committed`

    expect(
      recoverInterruptedWorkspaceReplacements({ details: true })
    ).toContainEqual({
      id,
      kind: "document-storage-v2",
      state: "complete",
      backupPath,
      resetRequired: true,
    })
    expect(recoverInterruptedWorkspaceReplacements()).toEqual([id])
    acknowledgeWorkspaceReplacementResets([id])
    expect(
      recoverInterruptedWorkspaceReplacements({ details: true })
    ).toContainEqual({
      id,
      kind: "document-storage-v2",
      state: "complete",
      backupPath,
      resetRequired: false,
    })
    expect(
      JSON.parse(await readFile(join(jobDirectory, "job.json"), "utf8"))
    ).toMatchObject({
      state: "complete",
      recovery: { state: "complete", backupPath },
    })
  })

  it("reports a completed rollback as failed instead of committed", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "rolled-back"), {
      workspaceRoot: source,
    })
    const prepared = await prepareWorkspaceReplacement(archive.destination)
    const id = "wtx_12345678901234567892"
    const jobDirectory = join(appDir, "workspace-transfers", "jobs", id)
    await mkdir(jobDirectory, { recursive: true })
    await writeFile(
      join(jobDirectory, "job.json"),
      `${JSON.stringify({
        version: 1,
        id,
        kind: "import",
        state: "replacing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        fileName: "rolled-back.wtb",
        expectedBytes: archive.bytes,
        receivedBytes: archive.bytes,
        prepared,
      })}\n`
    )
    const transaction = await beginPreparedWorkspaceReplacement(
      prepared.stagingPath,
      prepared.backupPath,
      prepared.contentCheckpoint,
      await calculateWorkspaceContentCheckpoint(active)
    )
    await transaction.rollback()

    expect(recoverInterruptedWorkspaceReplacements()).toEqual([id])
    expect(
      await readFile(join(active, "spaces", "notes", "docs", "note.md"), "utf8")
    ).toBe("# Original\n")
    expect(
      JSON.parse(await readFile(join(jobDirectory, "job.json"), "utf8"))
    ).toMatchObject({
      state: "failed",
      error: expect.stringContaining("rollback"),
    })
  })

  it("finishes startup rollback cleanup for a read-only imported tree", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "read-only"), {
      workspaceRoot: source,
    })
    const prepared = await prepareWorkspaceReplacement(archive.destination)
    const id = "wtx_12345678901234567893"
    const jobDirectory = join(appDir, "workspace-transfers", "jobs", id)
    await mkdir(jobDirectory, { recursive: true })
    await writeFile(
      join(jobDirectory, "job.json"),
      `${JSON.stringify({
        version: 1,
        id,
        kind: "import",
        state: "replacing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        fileName: "read-only.wtb",
        expectedBytes: archive.bytes,
        receivedBytes: archive.bytes,
        prepared,
      })}\n`
    )

    await beginPreparedWorkspaceReplacement(
      prepared.stagingPath,
      prepared.backupPath,
      prepared.contentCheckpoint,
      await calculateWorkspaceContentCheckpoint(active)
    )
    await writeFile(`${prepared.backupPath}.rollback`, "rollback\n", {
      mode: 0o600,
      flag: "wx",
    })
    await chmod(join(active, "spaces", "notes", "docs"), 0o500)
    await chmod(join(active, "spaces", "notes"), 0o500)
    await chmod(join(active, "spaces"), 0o500)
    await chmod(active, 0o500)

    expect(recoverInterruptedWorkspaceReplacements()).toEqual([id])
    expect(
      await readFile(join(active, "spaces", "notes", "docs", "note.md"), "utf8")
    ).toBe("# Original\n")
    expect(
      JSON.parse(await readFile(join(jobDirectory, "job.json"), "utf8"))
    ).toMatchObject({
      state: "failed",
      error: expect.stringContaining("interrupted rollback"),
    })
  })
})
