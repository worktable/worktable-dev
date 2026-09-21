import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import {
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DocumentId } from "@worktable/types"
import {
  inspectDocumentSource,
  mintDocumentId,
  readDocumentBundleManifest,
  readDocumentInventory,
  updateDocumentInventoryAt,
  updateDocumentInventory,
} from "./document-inventory.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

let root = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-document-inventory-"))
  setWorkspaceRootOverride(root)
  await mkdir(join(root, "spaces", "meta", "docs"), { recursive: true })
})

afterEach(async () => {
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("document inventory", () => {
  it("preserves unknown metadata only while its owning identity is unchanged", async () => {
    const id = mintDocumentId()
    const inventoryPath = join(root, "spaces", "meta", "documents.meta.json")
    await writeFile(
      inventoryPath,
      JSON.stringify({
        type: "worktable.document-inventory",
        version: 1,
        futureTop: { retained: true },
        documents: {
          [id]: {
            path: "old",
            futureEntry: ["kept"],
            format: {
              id: "future.canvas",
              sourceVersion: 7,
              futureFormat: "format-owned",
            },
            source: {
              kind: "file",
              relativePath: "docs/old.canvas",
              futureSource: "source-owned",
            },
          },
        },
      })
    )

    await updateDocumentInventory("meta", {
      upsert: [
        {
          documentId: id,
          path: "renamed",
          format: { id: "future.canvas", sourceVersion: 7 },
          source: { kind: "file", relativePath: "docs/old.canvas" },
        },
      ],
    })
    let raw = JSON.parse(await readFile(inventoryPath, "utf8"))
    expect(raw.futureTop).toEqual({ retained: true })
    expect(raw.documents[id]).toMatchObject({
      futureEntry: ["kept"],
      format: { futureFormat: "format-owned" },
      source: { futureSource: "source-owned" },
    })

    await updateDocumentInventory("meta", {
      upsert: [
        {
          documentId: id,
          path: "converted",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/converted.md" },
        },
      ],
    })
    raw = JSON.parse(await readFile(inventoryPath, "utf8"))
    expect(raw.documents[id].futureEntry).toEqual(["kept"])
    expect(raw.documents[id].format).toEqual({
      id: "worktable.markdown",
      sourceVersion: 1,
    })
    expect(raw.documents[id].source).toEqual({
      kind: "file",
      relativePath: "docs/converted.md",
    })
  })

  it("fails closed before invalid inventory state can escape a write", async () => {
    const corruptPath = join(root, "spaces", "meta", "documents.meta.json")
    await writeFile(corruptPath, "{not json", "utf8")
    await expect(
      updateDocumentInventory("meta", {
        upsert: [
          {
            documentId: mintDocumentId(),
            path: "notes/brief",
            format: { id: "worktable.markdown", sourceVersion: 1 },
            source: { kind: "file", relativePath: "docs/notes/brief.md" },
          },
        ],
      })
    ).rejects.toThrow("cannot update an invalid document inventory")
    expect(await readFile(corruptPath, "utf8")).toBe("{not json")

    await mkdir(join(root, "spaces", "linked", "docs"), { recursive: true })
    const outside = join(root, "outside-inventory.json")
    await writeFile(
      outside,
      JSON.stringify({
        type: "worktable.document-inventory",
        version: 1,
        documents: {},
      })
    )
    await symlink(
      outside,
      join(root, "spaces", "linked", "documents.meta.json")
    )
    const linked = await readDocumentInventory("linked")
    expect(linked.entries.size).toBe(0)
    expect(linked.diagnostics).toContainEqual(
      expect.objectContaining({ code: "inventory-not-file" })
    )
    const outsideBefore = await readFile(outside, "utf8")
    await expect(
      updateDocumentInventory("linked", {
        upsert: [
          {
            documentId: mintDocumentId(),
            path: "notes/linked",
            format: { id: "worktable.markdown", sourceVersion: 1 },
            source: { kind: "file", relativePath: "docs/linked.md" },
          },
        ],
      })
    ).rejects.toThrow("cannot update an invalid document inventory")
    expect(await readFile(outside, "utf8")).toBe(outsideBefore)

    const escapedInventory = join(root, "escaped", "documents.meta.json")
    await expect(readDocumentInventory("../escaped")).rejects.toThrow()
    await expect(updateDocumentInventory("../escaped", {})).rejects.toThrow()
    expect(existsSync(escapedInventory)).toBe(false)

    const outsideSpace = join(root, "outside-space")
    await mkdir(outsideSpace)
    await symlink(outsideSpace, join(root, "spaces", "linked-space"))
    await expect(updateDocumentInventory("linked-space", {})).rejects.toThrow()
    expect(existsSync(join(outsideSpace, "documents.meta.json"))).toBe(false)

    const copyRoot = join(root, "copy")
    const copySpaces = join(copyRoot, "spaces")
    const copySpace = join(copySpaces, "meta")
    const sourceSpaces = join(root, "source-spaces")
    const sourceSpace = join(sourceSpaces, "meta")
    await mkdir(join(copySpace, "docs"), { recursive: true })
    await mkdir(join(sourceSpace, "docs"), { recursive: true })
    const observedCopySpace = await lstat(copySpace)
    await rename(copySpaces, join(copyRoot, "retired-spaces"))
    await symlink(sourceSpaces, copySpaces, "dir")
    await expect(
      updateDocumentInventoryAt(
        copySpace,
        {},
        {
          expectedSpaceRootIdentity: {
            dev: observedCopySpace.dev,
            ino: observedCopySpace.ino,
          },
        }
      )
    ).rejects.toThrow("Space root changed")
    expect(existsSync(join(sourceSpace, "documents.meta.json"))).toBe(false)

    await mkdir(join(root, "spaces", "temp-link", "docs"), {
      recursive: true,
    })
    const tempLinkTarget = join(root, "outside-temp-target")
    await writeFile(tempLinkTarget, "must remain unchanged")
    await symlink(
      tempLinkTarget,
      join(root, "spaces", "temp-link", "documents.meta.json.tmp")
    )
    await updateDocumentInventory("temp-link", {})
    expect(await readFile(tempLinkTarget, "utf8")).toBe("must remain unchanged")

    await mkdir(join(root, "spaces", "invalid-utf8", "docs"), {
      recursive: true,
    })
    const invalidUtf8Path = join(
      root,
      "spaces",
      "invalid-utf8",
      "documents.meta.json"
    )
    const invalidUtf8 = Buffer.concat([
      Buffer.from(
        '{"type":"worktable.document-inventory","version":1,"documents":{},"future":"'
      ),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}'),
    ])
    await writeFile(invalidUtf8Path, invalidUtf8)
    const invalidUtf8Inventory = await readDocumentInventory("invalid-utf8")
    expect(invalidUtf8Inventory.diagnostics).toContainEqual(
      expect.objectContaining({ code: "inventory-invalid-json" })
    )
    await expect(updateDocumentInventory("invalid-utf8", {})).rejects.toThrow()
    expect(await readFile(invalidUtf8Path)).toEqual(invalidUtf8)

    await mkdir(join(root, "spaces", "large-number", "docs"), {
      recursive: true,
    })
    const largeNumberPath = join(
      root,
      "spaces",
      "large-number",
      "documents.meta.json"
    )
    const largeNumberInventory =
      '{"type":"worktable.document-inventory","version":1,"documents":{},"futureRevision":9007199254740993}'
    await writeFile(largeNumberPath, largeNumberInventory)
    const unsafeNumber = await readDocumentInventory("large-number")
    expect(unsafeNumber.diagnostics).toContainEqual(
      expect.objectContaining({ code: "inventory-lossy-number" })
    )
    await expect(updateDocumentInventory("large-number", {})).rejects.toThrow()
    expect(await readFile(largeNumberPath, "utf8")).toBe(largeNumberInventory)
  })

  it("enforces lexical and physical source safety while preserving legacy spelling", async () => {
    for (const relativePath of ["docs/%2e%2e/secret.md", "docs/x\ud800.md"]) {
      await expect(
        updateDocumentInventory("meta", {
          upsert: [
            {
              documentId: mintDocumentId(),
              path: "notes/brief",
              format: { id: "worktable.markdown", sourceVersion: 1 },
              source: { kind: "file", relativePath },
            },
          ],
        })
      ).rejects.toThrow("safe relative path")
    }

    const outside = join(root, "outside-source")
    await mkdir(outside)
    await writeFile(join(outside, "secret.md"), "outside")
    await symlink(outside, join(root, "spaces", "meta", "docs", "link"))
    await expect(
      inspectDocumentSource(join(root, "spaces", "meta"), {
        kind: "file",
        relativePath: "docs/link/secret.md",
      })
    ).resolves.toEqual({
      safe: false,
      message: "source locator traverses a symbolic link",
    })

    const id = mintDocumentId()
    const decomposedName = "cafe\u0301.md"
    await writeFile(
      join(root, "spaces", "meta", "documents.meta.json"),
      JSON.stringify({
        type: "worktable.document-inventory",
        version: 1,
        documents: {
          [id]: {
            path: "notes/café",
            format: { id: "worktable.markdown", sourceVersion: 1 },
            source: {
              kind: "file",
              relativePath: `docs/${decomposedName}`,
            },
          },
        },
      })
    )
    const inventory = await readDocumentInventory("meta")
    expect(inventory.diagnostics).toEqual([])
    expect(inventory.entries.get(id)?.source.relativePath).toBe(
      `docs/${decomposedName}`
    )
  })

  it("keeps one durable owner for each portable source", async () => {
    const first = mintDocumentId()
    const second = mintDocumentId()
    const inventoryPath = join(root, "spaces", "meta", "documents.meta.json")
    const entry = {
      path: "notes/brief",
      format: { id: "worktable.markdown", sourceVersion: 1 },
      source: {
        kind: "file" as const,
        relativePath: "docs/notes/Brief.md",
      },
    }
    await writeFile(
      inventoryPath,
      JSON.stringify({
        type: "worktable.document-inventory",
        version: 1,
        documents: {
          [first]: entry,
          [second]: {
            ...entry,
            path: "notes/copy",
            source: { ...entry.source, relativePath: "docs/notes/brief.md" },
          },
        },
      })
    )
    const inventory = await readDocumentInventory("meta")
    expect(inventory.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "entry-duplicate-source",
        documentId: second,
      })
    )
    await expect(updateDocumentInventory("meta", {})).rejects.toThrow(
      "cannot update an invalid document inventory"
    )

    await mkdir(join(root, "spaces", "fresh", "docs"), { recursive: true })
    await expect(
      updateDocumentInventory("fresh", {
        upsert: [
          { documentId: first, ...entry },
          {
            documentId: second,
            ...entry,
            path: "notes/copy",
            source: { ...entry.source, relativePath: "docs/notes/brief.md" },
          },
        ],
      })
    ).rejects.toThrow("cannot write an invalid document inventory")
    expect(
      existsSync(join(root, "spaces", "fresh", "documents.meta.json"))
    ).toBe(false)

    const upperId = `doc_${"A".repeat(22)}` as DocumentId
    const lowerId = `doc_${"a".repeat(22)}` as DocumentId
    await mkdir(join(root, "spaces", "portable-ids", "docs"), {
      recursive: true,
    })
    await expect(
      updateDocumentInventory("portable-ids", {
        upsert: [
          { documentId: upperId, ...entry },
          {
            documentId: lowerId,
            ...entry,
            path: "notes/other",
            source: { ...entry.source, relativePath: "docs/notes/other.md" },
          },
        ],
      })
    ).rejects.toThrow("cannot write an invalid document inventory")
  })

  it("preserves an unknown core bundle manifest without interpreting it", async () => {
    const id = mintDocumentId()
    const bundle = join(root, "spaces", "meta", "docs", "room.wtdoc")
    await mkdir(bundle)
    await writeFile(join(bundle, "..content"), "opaque")
    await writeFile(
      join(bundle, "manifest.json"),
      JSON.stringify({
        type: "worktable.document-bundle",
        version: 1,
        documentId: id,
        format: { id: "future.room", sourceVersion: 3 },
        content: "..content",
        future: { retained: true },
      })
    )

    const result = await readDocumentBundleManifest(bundle)
    expect(result.diagnostics).toEqual([])
    expect(result.manifest).toMatchObject({
      documentId: id,
      format: { id: "future.room", sourceVersion: 3 },
      content: "..content",
      raw: { future: { retained: true } },
    })
  })

  it("rejects escaped, missing, symlinked, and nonportable bundle content", async () => {
    const id = mintDocumentId()
    const docs = join(root, "spaces", "meta", "docs")
    const outside = join(root, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "scene.future"), "outside")

    const linkedBundle = join(docs, "linked.wtdoc")
    await mkdir(linkedBundle)
    await symlink(outside, join(linkedBundle, "assets"))
    const missingBundle = join(docs, "missing.wtdoc")
    await mkdir(missingBundle)
    const nonportableBundle = join(docs, "nonportable.wtdoc")
    await mkdir(nonportableBundle)
    await writeFile(join(nonportableBundle, "CON"), "reserved on Windows")
    for (const [bundle, content] of [
      [linkedBundle, "assets/scene.future"],
      [missingBundle, "missing.future"],
      [nonportableBundle, "CON"],
    ] as const) {
      await writeFile(
        join(bundle, "manifest.json"),
        JSON.stringify({
          type: "worktable.document-bundle",
          version: 1,
          documentId: id,
          format: { id: "future.room", sourceVersion: 1 },
          content,
        })
      )
    }
    const symlinkedBundle = join(docs, "escape.wtdoc")
    await symlink(outside, symlinkedBundle)

    expect(
      (await readDocumentBundleManifest(linkedBundle)).diagnostics
    ).toContainEqual(expect.objectContaining({ code: "bundle-content-unsafe" }))
    expect(
      (await readDocumentBundleManifest(missingBundle)).diagnostics
    ).toContainEqual(
      expect.objectContaining({ code: "bundle-content-missing" })
    )
    expect(
      (await readDocumentBundleManifest(nonportableBundle)).diagnostics
    ).toContainEqual(expect.objectContaining({ code: "bundle-content-unsafe" }))
    expect(
      (await readDocumentBundleManifest(symlinkedBundle)).diagnostics
    ).toContainEqual(expect.objectContaining({ code: "bundle-symlink" }))
  })

  it("keeps the bundle manifest locator inside its declared bundle", async () => {
    await expect(
      updateDocumentInventory("meta", {
        upsert: [
          {
            documentId: mintDocumentId(),
            path: "rooms/status",
            format: { id: "future.room", sourceVersion: 1 },
            source: {
              kind: "bundle",
              relativePath: "docs/status.wtdoc",
              manifestPath: "docs/other.wtdoc/manifest.json",
            },
          },
        ],
      })
    ).rejects.toThrow("bundle manifest locator")
  })
})
