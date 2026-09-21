import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { SpaceFile } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import {
  advanceDocumentCreateRecoveryV2,
  discoverDocumentCreateRecoveryV2,
  prepareDocumentCreateRecoveryV2,
  reconcileDocumentCreateRecoveryV2,
} from "./document-create-recovery-v2.ts"
import {
  mintDocumentId,
  readDocumentInventory,
  updateDocumentInventory,
} from "./document-inventory.ts"
import { writeDocumentGenerationV2 } from "./document-version-store-v2.ts"
import { writeSpace } from "./store.ts"
import { mintVersionId } from "./version-store.ts"
import { documentGenerationV2Directory } from "./workspace-storage-v2.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

let workspaceRoot = ""
let appRoot = ""
const spaceId = "create-recovery"

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "worktable-create-recovery-ws-"))
  appRoot = await mkdtemp(join(tmpdir(), "worktable-create-recovery-app-"))
  setWorkspaceRootOverride(workspaceRoot)
  setAppDirOverride(appRoot)
  await ensureWorkspaceManifest()
  const manifestPath = join(workspaceRoot, "worktable.workspace.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, version: 2 }, null, 2)}\n`
  )
  const now = new Date().toISOString()
  const space: SpaceFile = {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Create recovery",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
  await writeSpace(space)
})

afterEach(async () => {
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await Promise.all(
    [workspaceRoot, appRoot].map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe("document create recovery", () => {
  it("finishes a crash after source publication without exposing a partial document", async () => {
    const documentId = mintDocumentId()
    const createdAt = new Date().toISOString()
    const generationId = mintVersionId(createdAt)
    const path = "notes/interrupted"
    const source = {
      kind: "file" as const,
      relativePath: "docs/notes/interrupted.md",
    }
    const bytes = new TextEncoder().encode("# Interrupted\n")
    await prepareDocumentCreateRecoveryV2({
      spaceId,
      documentId,
      path,
      format: { id: "worktable.markdown", sourceVersion: 1 },
      source,
      generationId,
      generationEntry: "document.md",
      createdAt,
      createdBy: "test",
      operationSource: "test",
      sourceBytes: bytes,
    })
    await writeDocumentGenerationV2({
      workspaceRoot,
      spaceId,
      documentId,
      generationId,
      logicalPath: path,
      format: { id: "worktable.markdown", sourceVersion: 1 },
      operation: "create",
      createdAt,
      createdBy: "test",
      source: "test",
      authoredSource: {
        kind: "file",
        entries: [{ path: "document.md", bytes }],
      },
    })
    const sourcePath = join(
      workspaceRoot,
      "spaces",
      spaceId,
      source.relativePath
    )
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, bytes)

    const recovered = discoverDocumentCreateRecoveryV2()
    expect(recovered).toHaveLength(1)
    await reconcileDocumentCreateRecoveryV2(recovered)

    await access(sourcePath)
    await access(
      documentGenerationV2Directory(
        workspaceRoot,
        spaceId,
        documentId,
        generationId
      )
    )
    expect(
      (await readDocumentInventory(spaceId)).entries.get(documentId)
    ).toMatchObject({
      path,
      format: { id: "worktable.markdown", sourceVersion: 1 },
      source,
    })
    expect(discoverDocumentCreateRecoveryV2()).toEqual([])
  })

  it("preserves a competing source while rolling back an unowned create", async () => {
    const documentId = mintDocumentId()
    const createdAt = new Date().toISOString()
    const generationId = mintVersionId(createdAt)
    const path = "notes/competing"
    const source = {
      kind: "file" as const,
      relativePath: "docs/notes/competing.md",
    }
    const intendedBytes = new TextEncoder().encode("# Intended\n")
    const competingBytes = new TextEncoder().encode(
      "# Competing filesystem source\n"
    )
    const recovery = await prepareDocumentCreateRecoveryV2({
      spaceId,
      documentId,
      path,
      format: { id: "worktable.markdown", sourceVersion: 1 },
      source,
      generationId,
      generationEntry: "document.md",
      createdAt,
      createdBy: "test",
      operationSource: "test",
      sourceBytes: intendedBytes,
    })
    await writeDocumentGenerationV2({
      workspaceRoot,
      spaceId,
      documentId,
      generationId,
      logicalPath: path,
      format: { id: "worktable.markdown", sourceVersion: 1 },
      operation: "create",
      createdAt,
      createdBy: "test",
      source: "test",
      authoredSource: {
        kind: "file",
        entries: [{ path: "document.md", bytes: intendedBytes }],
      },
    })
    await advanceDocumentCreateRecoveryV2(recovery, "generation-written")
    const sourcePath = join(
      workspaceRoot,
      "spaces",
      spaceId,
      source.relativePath
    )
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, competingBytes)

    expect(await reconcileDocumentCreateRecoveryV2([recovery])).toEqual([
      "rolled-back",
    ])

    expect(await readFile(sourcePath)).toEqual(Buffer.from(competingBytes))
    await expect(
      access(
        documentGenerationV2Directory(
          workspaceRoot,
          spaceId,
          documentId,
          generationId
        )
      )
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect((await readDocumentInventory(spaceId)).entries.has(documentId)).toBe(
      false
    )
    expect(discoverDocumentCreateRecoveryV2()).toEqual([])
  })

  it("closes a committed create job without blocking a later filesystem edit", async () => {
    const documentId = mintDocumentId()
    const createdAt = new Date().toISOString()
    const generationId = mintVersionId(createdAt)
    const path = "notes/committed-then-edited"
    const source = {
      kind: "file" as const,
      relativePath: "docs/notes/committed-then-edited.md",
    }
    const createdBytes = new TextEncoder().encode("# Created\n")
    const laterBytes = new TextEncoder().encode("# Later filesystem edit\n")
    const recovery = await prepareDocumentCreateRecoveryV2({
      spaceId,
      documentId,
      path,
      format: { id: "worktable.markdown", sourceVersion: 1 },
      source,
      generationId,
      generationEntry: "document.md",
      createdAt,
      createdBy: "test",
      operationSource: "test",
      sourceBytes: createdBytes,
    })
    await writeDocumentGenerationV2({
      workspaceRoot,
      spaceId,
      documentId,
      generationId,
      logicalPath: path,
      format: { id: "worktable.markdown", sourceVersion: 1 },
      operation: "create",
      createdAt,
      createdBy: "test",
      source: "test",
      authoredSource: {
        kind: "file",
        entries: [{ path: "document.md", bytes: createdBytes }],
      },
    })
    const sourcePath = join(
      workspaceRoot,
      "spaces",
      spaceId,
      source.relativePath
    )
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, createdBytes)
    await updateDocumentInventory(spaceId, {
      upsert: [
        {
          documentId,
          path,
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source,
        },
      ],
    })
    await advanceDocumentCreateRecoveryV2(recovery, "committed")
    await writeFile(sourcePath, laterBytes)

    expect(await reconcileDocumentCreateRecoveryV2([recovery])).toEqual([
      "committed",
    ])
    expect(await readFile(sourcePath)).toEqual(Buffer.from(laterBytes))
    expect(discoverDocumentCreateRecoveryV2()).toEqual([])
  })
})
