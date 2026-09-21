import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  beginPreparedWorkspaceReplacement,
  prepareWorkspaceReplacement,
  setWorkspaceReplacementCommitHookForTests,
} from "./workspace-replacement.ts"
import {
  calculateWorkspaceContentCheckpoint,
  writeWorkspaceExportV2,
} from "./workspace-transfer-v2.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

let root: string
let active: string
let source: string

async function seedDoc(workspace: string, body: string): Promise<void> {
  await mkdir(join(workspace, "spaces", "notes", "docs"), { recursive: true })
  await writeFile(join(workspace, "spaces", "notes", "docs", "note.md"), body)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-replacement-"))
  active = join(root, "active")
  source = join(root, "source")
  setAppDirOverride(join(root, "app"))

  setWorkspaceRootOverride(active)
  ensureWorkspaceManifest()
  await seedDoc(active, "# Destination\n")

  setWorkspaceRootOverride(source)
  ensureWorkspaceManifest()
  await seedDoc(source, "# Imported\n")

  setWorkspaceRootOverride(active)
})

afterEach(async () => {
  setWorkspaceReplacementCommitHookForTests(null)
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("workspace replacement transaction", () => {
  it("preserves destination identity while replacing all portable content", async () => {
    const destinationManifest = await readFile(
      join(active, "worktable.workspace.json")
    )
    const archive = await writeWorkspaceExportV2(join(root, "source-export"), {
      workspaceRoot: source,
    })
    const prepared = await prepareWorkspaceReplacement(archive.destination)
    const latestManifestValue = JSON.parse(
      destinationManifest.toString("utf8")
    ) as { name: string }
    latestManifestValue.name = "Renamed during review"
    const latestDestinationManifest = Buffer.from(
      `${JSON.stringify(latestManifestValue, null, 2)}\n`
    )
    await writeFile(
      join(active, "worktable.workspace.json"),
      latestDestinationManifest
    )
    expect(latestDestinationManifest).not.toEqual(destinationManifest)
    const transaction = await beginPreparedWorkspaceReplacement(
      prepared.stagingPath,
      undefined,
      prepared.contentCheckpoint,
      await calculateWorkspaceContentCheckpoint(active)
    )
    await transaction.commit()

    expect(await readFile(join(active, "worktable.workspace.json"))).toEqual(
      latestDestinationManifest
    )
    expect(
      await readFile(join(active, "spaces", "notes", "docs", "note.md"), "utf8")
    ).toBe("# Imported\n")
  })

  it("restores the original workspace when restart validation fails", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "source-export"), {
      workspaceRoot: source,
    })
    const prepared = await prepareWorkspaceReplacement(archive.destination)
    const transaction = await beginPreparedWorkspaceReplacement(
      prepared.stagingPath,
      undefined,
      prepared.contentCheckpoint,
      await calculateWorkspaceContentCheckpoint(active)
    )
    await transaction.rollback()

    expect(
      await readFile(join(active, "spaces", "notes", "docs", "note.md"), "utf8")
    ).toBe("# Destination\n")
  })

  it("replaces a read-only imported manifest with owner-only destination identity", async () => {
    await chmod(join(source, "worktable.workspace.json"), 0o400)
    const archive = await writeWorkspaceExportV2(join(root, "source-export"), {
      workspaceRoot: source,
    })
    const prepared = await prepareWorkspaceReplacement(archive.destination)
    const transaction = await beginPreparedWorkspaceReplacement(
      prepared.stagingPath,
      prepared.backupPath,
      prepared.contentCheckpoint,
      await calculateWorkspaceContentCheckpoint(active)
    )
    await transaction.commit()

    expect(
      (await stat(join(active, "worktable.workspace.json"))).mode & 0o777
    ).toBe(0o600)
  })

  it("preserves the active workspace root permissions", async () => {
    await chmod(active, 0o770)
    const archive = await writeWorkspaceExportV2(join(root, "source-export"), {
      workspaceRoot: source,
    })
    const prepared = await prepareWorkspaceReplacement(archive.destination)
    const transaction = await beginPreparedWorkspaceReplacement(
      prepared.stagingPath,
      prepared.backupPath,
      prepared.contentCheckpoint,
      await calculateWorkspaceContentCheckpoint(active)
    )
    await transaction.commit()

    expect((await stat(active)).mode & 0o777).toBe(0o770)
  })

  it("binds review to the portable content identity", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "source-export"), {
      workspaceRoot: source,
    })
    const prepared = await prepareWorkspaceReplacement(archive.destination)

    expect(prepared.contentCheckpoint).toBe(
      await calculateWorkspaceContentCheckpoint(prepared.stagingPath)
    )
  })

  it("refuses prepared content changed after the review checkpoint", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "source-export"), {
      workspaceRoot: source,
    })
    const prepared = await prepareWorkspaceReplacement(archive.destination)
    await writeFile(
      join(prepared.stagingPath, "spaces", "notes", "docs", "injected.md"),
      "not reviewed\n"
    )

    await expect(
      beginPreparedWorkspaceReplacement(
        prepared.stagingPath,
        prepared.backupPath,
        prepared.contentCheckpoint,
        await calculateWorkspaceContentCheckpoint(active)
      )
    ).rejects.toThrow(/changed after review/)
    expect(
      await readFile(join(active, "spaces", "notes", "docs", "note.md"), "utf8")
    ).toBe("# Destination\n")
  })

  it("does not invalidate reviewed content for a timestamp-only change", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "source-export"), {
      workspaceRoot: source,
    })
    const prepared = await prepareWorkspaceReplacement(archive.destination)
    const importedDoc = join(
      prepared.stagingPath,
      "spaces",
      "notes",
      "docs",
      "note.md"
    )
    const changed = new Date(Date.now() + 60_000)
    await utimes(importedDoc, changed, changed)

    const transaction = await beginPreparedWorkspaceReplacement(
      prepared.stagingPath,
      prepared.backupPath,
      prepared.contentCheckpoint,
      await calculateWorkspaceContentCheckpoint(active)
    )
    await transaction.rollback()

    expect(
      await readFile(join(active, "spaces", "notes", "docs", "note.md"), "utf8")
    ).toBe("# Destination\n")
  })

  it("refuses symlinks introduced into prepared content after review", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "source-export"), {
      workspaceRoot: source,
    })
    const prepared = await prepareWorkspaceReplacement(archive.destination)
    await symlink(
      join(root, "outside"),
      join(prepared.stagingPath, "spaces", "notes", "outside-link")
    )

    await expect(
      beginPreparedWorkspaceReplacement(
        prepared.stagingPath,
        prepared.backupPath,
        prepared.contentCheckpoint,
        await calculateWorkspaceContentCheckpoint(active)
      )
    ).rejects.toThrow(/refuses symlink/)
  })

  it("refuses to replace portable content changed after confirmation", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "source-export"), {
      workspaceRoot: source,
    })
    const prepared = await prepareWorkspaceReplacement(archive.destination)
    const confirmedDestinationCheckpoint =
      await calculateWorkspaceContentCheckpoint(active)
    await writeFile(
      join(active, "spaces", "notes", "docs", "external-edit.md"),
      "must not be lost\n"
    )

    await expect(
      beginPreparedWorkspaceReplacement(
        prepared.stagingPath,
        prepared.backupPath,
        prepared.contentCheckpoint,
        confirmedDestinationCheckpoint
      )
    ).rejects.toThrow(/changed after replacement confirmation/)
    expect(
      await readFile(
        join(active, "spaces", "notes", "docs", "external-edit.md"),
        "utf8"
      )
    ).toBe("must not be lost\n")
  })
})
