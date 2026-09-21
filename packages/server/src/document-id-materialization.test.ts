import { describe, expect, it } from "bun:test"
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import {
  materializeDocumentIdsAt,
  planDocumentIdMaterialization,
  rehearseDocumentIdMaterialization,
  setBeforeDocumentIdMaterializationApplyHookForTests,
} from "./document-id-materialization.ts"
import {
  DOCUMENT_INVENTORY_MAX_BYTES,
  mintDocumentId,
} from "./document-inventory.ts"
import { stringifyCanonicalYaml } from "./yaml.ts"

const CREATED_AT = "2026-08-28T00:00:00.000Z"

async function writeWorkspaceManifest(root: string): Promise<void> {
  await writeFile(
    join(root, "worktable.workspace.json"),
    `${JSON.stringify({
      type: "worktable.workspace",
      version: 1,
      id: "workspace-materialization",
      name: "Materialization",
      createdAt: CREATED_AT,
      cloud: { status: "unlinked" },
    })}\n`
  )
}

async function writeSpace(
  root: string,
  id: string,
  order: string[] = []
): Promise<void> {
  await mkdir(join(root, "spaces", id, "docs"), { recursive: true })
  await mkdir(join(root, "spaces", id, "widgets"), { recursive: true })
  await writeFile(
    join(root, "spaces", id, "space.json"),
    `${JSON.stringify({
      type: "worktable.space",
      version: 1,
      id,
      name: id,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      createdBy: "test",
      settings: { docOrder: order, docSort: "custom" },
    })}\n`
  )
}

async function writeWidget(root: string, id: string): Promise<void> {
  const directory = join(root, "spaces", "meta", "widgets", ...id.split("/"))
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "widget.yaml"),
    stringifyCanonicalYaml({
      version: 1,
      kind: "worktable.widget",
      id,
      name: "Status",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      createdBy: "test",
      metadata: {},
      runtime: { type: "html", entry: "index.html" },
      permissions: {
        network: false,
        records: {},
        state: { read: true, write: true },
      },
    })
  )
  await writeFile(join(directory, "index.html"), "<h1>Status</h1>")
  await writeFile(join(directory, "state.yaml"), "tab: overview\n")
  await writeFile(join(directory, "data.json"), '{"retained":true}\n')
  await mkdir(join(directory, "assets"))
  await writeFile(join(directory, "assets", "index.html"), "<p>Companion</p>")
  await writeFile(join(directory, "assets", "widget.yaml"), "retained: true\n")
}

async function treeSnapshot(
  root: string,
  options: { omitInventories?: boolean } = {}
): Promise<
  Array<{ path: string; kind: "directory" | "file"; bytes?: string }>
> {
  const result: Array<{
    path: string
    kind: "directory" | "file"
    bytes?: string
  }> = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      const path = relative(root, absolutePath).split("\\").join("/")
      if (options.omitInventories && path.endsWith("/documents.meta.json")) {
        continue
      }
      if (entry.isDirectory()) {
        result.push({ path, kind: "directory" })
        await walk(absolutePath)
      } else {
        result.push({
          path,
          kind: "file",
          bytes: (await readFile(absolutePath)).toString("base64"),
        })
      }
    }
  }
  await walk(root)
  return result
}

describe("document ID materialization", () => {
  it("materializes every active format in a verified copy while preserving the source and dependent state", async () => {
    const container = await mkdtemp(join(tmpdir(), "worktable-document-ids-"))
    const root = join(container, "source-workspace")
    const copyRoot = join(container, "copied-workspace")
    const appDir = join(container, "app-data")
    const runtimeCacheKey = "0123456789abcdef"
    const durableId = mintDocumentId()
    try {
      await mkdir(root)
      await writeWorkspaceManifest(root)
      await writeSpace(root, "meta", ["brief", "rich", "plans/status"])
      await writeSpace(root, "other", ["second"])
      await writeFile(
        join(root, "spaces", "meta", "docs", "brief.md"),
        "# Brief\n"
      )
      await writeFile(join(root, "spaces", "meta", "docs", "rich.json"), "[]\n")
      await writeFile(
        join(root, "spaces", "meta", "docs", "future.canvas"),
        "opaque future source\n"
      )
      await writeFile(
        join(root, "spaces", "meta", "docs", "inactive.html"),
        "<h1>Not active yet</h1>\n"
      )
      await writeWidget(root, "plans/status")
      await writeFile(
        join(root, "spaces", "meta", "widgets.meta.json"),
        `${JSON.stringify({
          version: 1,
          widgets: {
            "plans/status": {
              provenance: {
                updatedAt: CREATED_AT,
                updatedBy: "test",
                source: "test",
                versionId: "v1",
                contentHash: "retained",
              },
            },
          },
        })}\n`
      )
      const recordsRoot = join(root, "spaces", "meta", "records", "research")
      await mkdir(recordsRoot, { recursive: true })
      await writeFile(
        join(recordsRoot, "schema.yaml"),
        stringifyCanonicalYaml({
          version: 2,
          kind: "worktable.recordSchema",
          id: "research",
          name: "Research",
          fields: { source: { type: "document" } },
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          createdBy: "test",
          metadata: {},
        })
      )
      await writeFile(
        join(recordsRoot, "brief.yaml"),
        stringifyCanonicalYaml({
          version: 1,
          kind: "worktable.record",
          id: "brief",
          collectionId: "research",
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          createdBy: "test",
          metadata: {},
          data: { source: "brief" },
        })
      )
      await writeFile(
        join(root, "spaces", "other", "docs", "second.md"),
        "# Second Space\n"
      )
      await mkdir(join(root, "spaces", "meta", "annotations", "docs"), {
        recursive: true,
      })
      await writeFile(
        join(
          root,
          "spaces",
          "meta",
          "annotations",
          "docs",
          "brief.annotations.json"
        ),
        '{"annotations":[]}\n'
      )
      await writeFile(
        join(root, "spaces", "meta", "docs.meta.json"),
        `${JSON.stringify({
          version: 1,
          docs: {
            brief: {
              collaborationCacheEpoch: "epoch-before-materialization",
            },
          },
        })}\n`
      )
      await writeFile(
        join(root, "spaces", "meta", "doc-aliases.json"),
        '{"type":"worktable.doc-aliases","version":1,"exact":{},"prefixes":{}}\n'
      )
      // Existing local workspaces may contain legacy names that are not valid
      // portable export paths. Identity materialization must preserve them.
      await mkdir(join(root, "versions", "meta", "docs", " v9E2Qy6M  "), {
        recursive: true,
      })
      await writeFile(
        join(root, "versions", "meta", "docs", " v9E2Qy6M  ", "v1.json"),
        '{"retained":true}\n'
      )
      await mkdir(join(root, "spaces", "meta", "docs", "empty-folder"))
      await mkdir(join(appDir, "yjs", runtimeCacheKey, "meta"), {
        recursive: true,
      })
      await writeFile(
        join(appDir, "yjs", runtimeCacheKey, "meta", "brief.bin"),
        "runtime"
      )
      await writeFile(
        join(appDir, "document-shares.json"),
        '{"type":"worktable.document-shares","version":1,"shares":[]}\n'
      )
      await writeFile(
        join(root, "spaces", "meta", "documents.meta.json"),
        `${JSON.stringify({
          type: "worktable.document-inventory",
          version: 1,
          futureTop: { retained: true },
          documents: {
            [durableId]: {
              path: "future/canvas",
              futureEntry: ["retained"],
              format: {
                id: "future.canvas",
                sourceVersion: 1,
                futureFormat: true,
              },
              source: {
                kind: "file",
                relativePath: "docs/future.canvas",
                futureSource: true,
              },
            },
          },
        })}\n`
      )

      await cp(root, copyRoot, { recursive: true })
      const beforeSourceTree = await treeSnapshot(root)
      const beforePortableTree = await treeSnapshot(root, {
        omitInventories: true,
      })
      const beforeAppTree = await treeSnapshot(appDir)
      const plan = await planDocumentIdMaterialization(root, {
        appDir,
        runtimeCacheKey,
      })
      expect(plan).toMatchObject({
        clean: true,
        documentCount: 6,
        durableCount: 1,
        materializeCount: 5,
      })
      expect(plan.census.dependencies).toEqual(
        expect.arrayContaining(
          [
            "annotations",
            "doc-metadata",
            "history",
            "runtime-state",
            "shares",
            "aliases",
            "ordering",
            "empty-folder",
            "raw-html",
            "html-state",
            "html-metadata",
            "html-companion",
          ].map((kind) => expect.objectContaining({ kind }))
        )
      )
      expect(plan.census.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "record-document-reference",
            path: "spaces/meta/records/research/schema.yaml",
          }),
          expect.objectContaining({
            kind: "record-document-reference",
            path: "spaces/meta/records/research/brief.yaml",
          }),
          expect.objectContaining({
            kind: "html-companion",
            path: "spaces/meta/widgets/plans/status/assets/index.html",
          }),
          expect.objectContaining({
            kind: "html-companion",
            path: "spaces/meta/widgets/plans/status/assets/widget.yaml",
          }),
        ])
      )

      const result = await rehearseDocumentIdMaterialization({
        sourceWorkspace: root,
        copyWorkspace: copyRoot,
        expectedWorkspaceId: plan.workspaceId,
        expectedSourceWorkspaceContentCheckpoint:
          plan.workspaceContentCheckpoint,
        expectedCopyWorkspaceContentCheckpoint: plan.workspaceContentCheckpoint,
        appDir,
        runtimeCacheKey,
      })
      expect(result).toMatchObject({
        documentCount: 6,
        durableCount: 6,
        materializedCount: 5,
        sourceCheckpoint: plan.sourceCheckpoint,
      })
      expect(await treeSnapshot(root)).toEqual(beforeSourceTree)
      expect(await treeSnapshot(copyRoot, { omitInventories: true })).toEqual(
        beforePortableTree
      )
      expect(await treeSnapshot(appDir)).toEqual(beforeAppTree)

      const inventories = await Promise.all(
        ["meta", "other"].map(async (spaceId) =>
          JSON.parse(
            await readFile(
              join(copyRoot, "spaces", spaceId, "documents.meta.json"),
              "utf8"
            )
          )
        )
      )
      const materializedIds = inventories.flatMap((inventory) =>
        Object.keys(inventory.documents as Record<string, unknown>)
      )
      expect(materializedIds).toHaveLength(6)
      expect(new Set(materializedIds).size).toBe(6)
      const inventory = inventories[0]
      expect(inventory).toMatchObject({
        futureTop: { retained: true },
        documents: {
          [durableId]: {
            futureEntry: ["retained"],
          },
        },
      })
    } finally {
      await rm(container, { recursive: true, force: true })
    }
  }, 30_000)

  if (sep === "/") {
    it("keeps distinct POSIX dependency paths distinct in the census", async () => {
      const root = await mkdtemp(
        join(tmpdir(), "worktable-document-ids-portable-paths-")
      )
      try {
        await writeWorkspaceManifest(root)
        await writeSpace(root, "alpha")
        const annotations = join(root, "spaces", "alpha", "annotations")
        await mkdir(join(annotations, "a"), { recursive: true })
        await writeFile(
          join(annotations, "a\\b.annotations.json"),
          '{"annotations":[]}\n'
        )
        await writeFile(
          join(annotations, "a", "b.annotations.json"),
          '{"annotations":[]}\n'
        )

        const plan = await planDocumentIdMaterialization(root)
        const paths = plan.census.dependencies
          .filter((dependency) => dependency.kind === "annotations")
          .map((dependency) => dependency.path)
        expect(paths).toContain(
          "spaces/alpha/annotations/a\\b.annotations.json"
        )
        expect(paths).toContain("spaces/alpha/annotations/a/b.annotations.json")
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  it("leaves a fully materialized copy unchanged when the operator reruns it", async () => {
    const container = await mkdtemp(
      join(tmpdir(), "worktable-document-ids-rerun-")
    )
    const root = join(container, "source")
    const copyRoot = join(container, "copy")
    try {
      await mkdir(root)
      await writeWorkspaceManifest(root)
      await writeSpace(root, "alpha")
      await writeFile(join(root, "spaces", "alpha", "docs", "a.md"), "# A\n")
      const plan = await planDocumentIdMaterialization(root)
      await cp(root, copyRoot, { recursive: true })

      // The first-run rehearsal and source isolation are covered above. Set up
      // its durable output through the writer before exercising the rerun.
      const first = await materializeDocumentIdsAt(copyRoot, {
        workspaceId: plan.workspaceId,
        workspaceContentCheckpoint: plan.workspaceContentCheckpoint,
      })
      const beforeRerun = await treeSnapshot(copyRoot)
      const rerun = await rehearseDocumentIdMaterialization({
        sourceWorkspace: root,
        copyWorkspace: copyRoot,
        expectedWorkspaceId: plan.workspaceId,
        expectedSourceWorkspaceContentCheckpoint:
          plan.workspaceContentCheckpoint,
        expectedCopyWorkspaceContentCheckpoint:
          first.afterWorkspaceContentCheckpoint,
      })

      expect(rerun).toMatchObject({
        documentCount: 1,
        durableCount: 1,
        materializedCount: 0,
        beforeWorkspaceContentCheckpoint: first.afterWorkspaceContentCheckpoint,
        afterWorkspaceContentCheckpoint: first.afterWorkspaceContentCheckpoint,
      })
      expect(await treeSnapshot(copyRoot)).toEqual(beforeRerun)
    } finally {
      await rm(container, { recursive: true, force: true })
    }
  })

  it("refuses an alias of the source workspace as the migration target", async () => {
    const container = await mkdtemp(
      join(tmpdir(), "worktable-document-ids-alias-")
    )
    const actualParent = join(container, "actual")
    const root = join(actualParent, "workspace")
    const aliasParent = join(container, "alias-parent")
    const alias = join(aliasParent, "workspace")
    try {
      await mkdir(root, { recursive: true })
      await writeWorkspaceManifest(root)
      await writeSpace(root, "alpha")
      await writeFile(join(root, "spaces", "alpha", "docs", "a.md"), "# A\n")
      await symlink(actualParent, aliasParent, "dir")
      const plan = await planDocumentIdMaterialization(root)
      const before = await treeSnapshot(root)
      await expect(
        rehearseDocumentIdMaterialization({
          sourceWorkspace: root,
          copyWorkspace: alias,
          expectedWorkspaceId: plan.workspaceId,
          expectedSourceWorkspaceContentCheckpoint:
            plan.workspaceContentCheckpoint,
          expectedCopyWorkspaceContentCheckpoint:
            plan.workspaceContentCheckpoint,
        })
      ).rejects.toThrow("target must be a separate copy")
      expect(await treeSnapshot(root)).toEqual(before)
    } finally {
      await rm(container, { recursive: true, force: true })
    }
  })

  it("does not report a missing app-data root as inspected", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "worktable-document-ids-app-data-")
    )
    try {
      await writeWorkspaceManifest(root)
      await writeSpace(root, "alpha")
      await expect(
        planDocumentIdMaterialization(root, {
          appDir: join(root, "missing-app-data"),
          runtimeCacheKey: "0123456789abcdef",
        })
      ).rejects.toThrow("app data root must be an existing directory")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("never redirects materialization into the source after copy validation", async () => {
    const container = await mkdtemp(
      join(tmpdir(), "worktable-document-ids-copy-swap-")
    )
    const root = join(container, "source")
    const copyRoot = join(container, "copy")
    const retiredCopy = join(container, "retired-copy")
    try {
      await mkdir(root)
      await writeWorkspaceManifest(root)
      await writeSpace(root, "alpha")
      await writeFile(join(root, "spaces", "alpha", "docs", "a.md"), "# A\n")
      const plan = await planDocumentIdMaterialization(root)
      await cp(root, copyRoot, { recursive: true })
      const beforeSource = await treeSnapshot(root)
      setBeforeDocumentIdMaterializationApplyHookForTests(async () => {
        await rename(copyRoot, retiredCopy)
        await symlink(root, copyRoot, "dir")
      })

      await expect(
        rehearseDocumentIdMaterialization({
          sourceWorkspace: root,
          copyWorkspace: copyRoot,
          expectedWorkspaceId: plan.workspaceId,
          expectedSourceWorkspaceContentCheckpoint:
            plan.workspaceContentCheckpoint,
          expectedCopyWorkspaceContentCheckpoint:
            plan.workspaceContentCheckpoint,
        })
      ).rejects.toThrow("workspace root must be a real directory")
      expect(await treeSnapshot(root)).toEqual(beforeSource)
    } finally {
      setBeforeDocumentIdMaterializationApplyHookForTests(null)
      await rm(container, { recursive: true, force: true })
    }
  })

  it("fails before writing when the copied workspace no longer matches the census", async () => {
    const container = await mkdtemp(
      join(tmpdir(), "worktable-document-ids-stale-")
    )
    const root = join(container, "source")
    const copyRoot = join(container, "copy")
    try {
      await mkdir(root)
      await writeWorkspaceManifest(root)
      await writeSpace(root, "alpha")
      await writeFile(join(root, "spaces", "alpha", "docs", "a.md"), "# A\n")
      const valid = await planDocumentIdMaterialization(root)
      await cp(root, copyRoot, { recursive: true })
      await writeFile(
        join(copyRoot, "spaces", "alpha", "docs", "a.md"),
        "# Changed after census\n"
      )
      const beforeSource = await treeSnapshot(root)
      const beforeCopy = await treeSnapshot(copyRoot)
      await expect(
        rehearseDocumentIdMaterialization({
          sourceWorkspace: root,
          copyWorkspace: copyRoot,
          expectedWorkspaceId: valid.workspaceId,
          expectedSourceWorkspaceContentCheckpoint:
            valid.workspaceContentCheckpoint,
          expectedCopyWorkspaceContentCheckpoint:
            valid.workspaceContentCheckpoint,
        })
      ).rejects.toThrow("content does not match the census checkpoint")
      expect(await treeSnapshot(root)).toEqual(beforeSource)
      expect(await treeSnapshot(copyRoot)).toEqual(beforeCopy)
    } finally {
      await rm(container, { recursive: true, force: true })
    }
  })

  it("rejects a freshly censused copy that diverges outside identity metadata", async () => {
    const container = await mkdtemp(
      join(tmpdir(), "worktable-document-ids-diverged-")
    )
    const root = join(container, "source")
    const copyRoot = join(container, "copy")
    try {
      await mkdir(root)
      await writeWorkspaceManifest(root)
      await writeSpace(root, "alpha")
      await writeFile(join(root, "spaces", "alpha", "docs", "a.md"), "# A\n")
      const sourcePlan = await planDocumentIdMaterialization(root)
      await cp(root, copyRoot, { recursive: true })
      await writeFile(
        join(copyRoot, "spaces", "alpha", "docs", "a.md"),
        "# Different copy\n"
      )
      const copyPlan = await planDocumentIdMaterialization(copyRoot)
      const beforeSource = await treeSnapshot(root)
      const beforeCopy = await treeSnapshot(copyRoot)
      await expect(
        rehearseDocumentIdMaterialization({
          sourceWorkspace: root,
          copyWorkspace: copyRoot,
          expectedWorkspaceId: sourcePlan.workspaceId,
          expectedSourceWorkspaceContentCheckpoint:
            sourcePlan.workspaceContentCheckpoint,
          expectedCopyWorkspaceContentCheckpoint:
            copyPlan.workspaceContentCheckpoint,
        })
      ).rejects.toThrow(
        "does not match the source outside document identity metadata"
      )
      expect(await treeSnapshot(root)).toEqual(beforeSource)
      expect(await treeSnapshot(copyRoot)).toEqual(beforeCopy)
    } finally {
      await rm(container, { recursive: true, force: true })
    }
  })

  it("rejects a rerun that lost source-owned inventory metadata", async () => {
    const container = await mkdtemp(
      join(tmpdir(), "worktable-document-ids-lineage-")
    )
    const root = join(container, "source")
    const copyRoot = join(container, "copy")
    const documentId = mintDocumentId()
    try {
      await mkdir(root)
      await writeWorkspaceManifest(root)
      await writeSpace(root, "alpha")
      await writeFile(join(root, "spaces", "alpha", "docs", "a.md"), "# A\n")
      const inventory = {
        type: "worktable.document-inventory",
        version: 1,
        sourceOwned: { retained: true },
        documents: {
          [documentId]: {
            path: "a",
            format: { id: "worktable.markdown", sourceVersion: 1 },
            source: { kind: "file", relativePath: "docs/a.md" },
          },
        },
      }
      await writeFile(
        join(root, "spaces", "alpha", "documents.meta.json"),
        `${JSON.stringify(inventory)}\n`
      )
      const sourcePlan = await planDocumentIdMaterialization(root)
      await cp(root, copyRoot, { recursive: true })
      const copyInventory: Record<string, unknown> = structuredClone(inventory)
      delete copyInventory["sourceOwned"]
      await writeFile(
        join(copyRoot, "spaces", "alpha", "documents.meta.json"),
        `${JSON.stringify(copyInventory)}\n`
      )
      const copyPlan = await planDocumentIdMaterialization(copyRoot)
      const beforeSource = await treeSnapshot(root)
      const beforeCopy = await treeSnapshot(copyRoot)
      await expect(
        rehearseDocumentIdMaterialization({
          sourceWorkspace: root,
          copyWorkspace: copyRoot,
          expectedWorkspaceId: sourcePlan.workspaceId,
          expectedSourceWorkspaceContentCheckpoint:
            sourcePlan.workspaceContentCheckpoint,
          expectedCopyWorkspaceContentCheckpoint:
            copyPlan.workspaceContentCheckpoint,
        })
      ).rejects.toThrow("changed source-owned document identity metadata")
      expect(await treeSnapshot(root)).toEqual(beforeSource)
      expect(await treeSnapshot(copyRoot)).toEqual(beforeCopy)
    } finally {
      await rm(container, { recursive: true, force: true })
    }
  })

  it("blocks every Space before an expanded inventory exceeds its bound", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "worktable-document-ids-capacity-")
    )
    try {
      await writeWorkspaceManifest(root)
      await writeSpace(root, "alpha")
      await writeSpace(root, "beta")
      await writeFile(join(root, "spaces", "alpha", "docs", "a.md"), "# A\n")
      await writeFile(join(root, "spaces", "beta", "docs", "b.md"), "# B\n")
      const betaInventoryPath = join(
        root,
        "spaces",
        "beta",
        "documents.meta.json"
      )
      const betaInventory = `${JSON.stringify({
        type: "worktable.document-inventory",
        version: 1,
        futurePadding: "x".repeat(DOCUMENT_INVENTORY_MAX_BYTES - 256),
        documents: {},
      })}\n`
      expect(Buffer.byteLength(betaInventory)).toBeLessThan(
        DOCUMENT_INVENTORY_MAX_BYTES
      )
      await writeFile(betaInventoryPath, betaInventory)

      const plan = await planDocumentIdMaterialization(root)
      expect(plan.clean).toBe(false)
      expect(plan.diagnostics).toContainEqual(
        expect.objectContaining({
          path: "spaces/beta/documents.meta.json",
          message: "document inventory exceeds its size limit",
        })
      )
      await expect(
        materializeDocumentIdsAt(root, {
          workspaceId: plan.workspaceId,
          workspaceContentCheckpoint: plan.workspaceContentCheckpoint,
        })
      ).rejects.toThrow("materialization census failed")
      expect(await readdir(join(root, "spaces", "alpha"))).not.toContain(
        "documents.meta.json"
      )
      expect(await readFile(betaInventoryPath, "utf8")).toBe(betaInventory)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it("fails before writing when durable IDs collide across Spaces", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "worktable-document-ids-blocked-")
    )
    try {
      await writeWorkspaceManifest(root)
      await writeSpace(root, "alpha")
      await writeSpace(root, "beta")
      await writeFile(join(root, "spaces", "alpha", "docs", "a.md"), "# A\n")
      await writeFile(join(root, "spaces", "beta", "docs", "b.md"), "# B\n")
      const duplicateId = mintDocumentId()
      for (const [spaceId, name] of [
        ["alpha", "a"],
        ["beta", "b"],
      ] as const) {
        await writeFile(
          join(root, "spaces", spaceId, "documents.meta.json"),
          `${JSON.stringify({
            type: "worktable.document-inventory",
            version: 1,
            documents: {
              [duplicateId]: {
                path: name,
                format: { id: "worktable.markdown", sourceVersion: 1 },
                source: { kind: "file", relativePath: `docs/${name}.md` },
              },
            },
          })}\n`
        )
      }
      const duplicate = await planDocumentIdMaterialization(root)
      expect(duplicate.clean).toBe(false)
      expect(duplicate.diagnostics).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("durable document ID is also used"),
        })
      )
      const beforeDuplicate = await treeSnapshot(root)
      await expect(
        materializeDocumentIdsAt(root, {
          workspaceId: duplicate.workspaceId,
          workspaceContentCheckpoint: duplicate.workspaceContentCheckpoint,
        })
      ).rejects.toThrow("materialization census failed")
      expect(await treeSnapshot(root)).toEqual(beforeDuplicate)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
