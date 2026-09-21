import { describe, expect, it } from "bun:test"
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  formatDocumentPreflightReport,
  preflightDocumentWorkspace,
} from "./document-preflight.ts"
import { mintDocumentId } from "./document-inventory.ts"
import { stringifyCanonicalYaml } from "./yaml.ts"

async function writeSpaceManifest(root: string, id: string): Promise<void> {
  await writeFile(
    join(root, "spaces", id, "space.json"),
    JSON.stringify({
      type: "worktable.space",
      version: 1,
      id,
      name: id,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      createdBy: "test",
      settings: {},
    })
  )
}

async function makeWorkspace(spaceId = "meta"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "worktable-document-preflight-"))
  await mkdir(join(root, "spaces", spaceId, "docs"), { recursive: true })
  await mkdir(join(root, "spaces", spaceId, "widgets"), { recursive: true })
  await writeSpaceManifest(root, spaceId)
  return root
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
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
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
}

async function listTree(root: string): Promise<string[]> {
  const paths: string[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      paths.push(path.slice(root.length + 1))
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path)
    }
  }
  await walk(root)
  return paths
}

describe("document workspace preflight", () => {
  it("returns deterministic source evidence without mutating a quiet workspace", async () => {
    const root = await makeWorkspace()
    try {
      await writeFile(
        join(root, "spaces", "meta", "docs", "brief.md"),
        "# Brief"
      )
      await writeWidget(root, "status")
      const aliasesPath = join(root, "spaces", "meta", "doc-aliases.json")
      const inventoryPath = join(root, "spaces", "meta", "documents.meta.json")
      await writeFile(
        aliasesPath,
        JSON.stringify({
          type: "worktable.doc-aliases",
          version: 1,
          exact: { old: "brief" },
          prefixes: {},
        })
      )
      await writeFile(
        inventoryPath,
        JSON.stringify({
          type: "worktable.document-inventory",
          version: 1,
          future: "first",
          documents: {},
        })
      )
      const before = await listTree(root)

      const first = await preflightDocumentWorkspace(root)
      const second = await preflightDocumentWorkspace(root)

      expect(first.clean).toBe(true)
      expect(first.documentCount).toBe(2)
      expect(first.documents.every((document) => document.sha256)).toBe(true)
      expect(first.checkpoint).toBe(second.checkpoint)
      expect(first.documents).toEqual(second.documents)
      expect(await listTree(root)).toEqual(before)
      expect(formatDocumentPreflightReport(first)).toContain(
        "Document preflight: clean"
      )

      await writeFile(
        aliasesPath,
        JSON.stringify({
          type: "worktable.doc-aliases",
          version: 1,
          exact: { old: "status" },
          prefixes: {},
        })
      )
      const rerouted = await preflightDocumentWorkspace(root)
      expect(rerouted.documents).toEqual(first.documents)
      expect(rerouted.checkpoint).not.toBe(first.checkpoint)

      await writeFile(
        inventoryPath,
        JSON.stringify({
          type: "worktable.document-inventory",
          version: 1,
          future: "second",
          documents: {},
        })
      )
      const metadataChanged = await preflightDocumentWorkspace(root)
      expect(metadataChanged.documents).toEqual(rerouted.documents)
      expect(metadataChanged.checkpoint).not.toBe(rerouted.checkpoint)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("classifies conflicts, portability, metadata, and orphaned sources in one report", async () => {
    const root = await makeWorkspace()
    try {
      const space = join(root, "spaces", "meta")
      const docs = join(space, "docs")
      const widgets = join(space, "widgets")
      await writeFile(join(docs, "same.md"), "markdown")
      await writeFile(join(docs, "same.json"), "[]")
      await writeFile(join(docs, "legacy..md"), "legacy")
      await writeFile(join(docs, "already.html"), "<h1>Raw</h1>")
      await symlink(join(root, "outside"), join(docs, "escape"))
      await mkdir(join(widgets, "content-only"))
      await writeFile(join(widgets, "content-only", "index.html"), "orphan")
      await mkdir(join(widgets, "metadata-only"))
      await writeFile(join(widgets, "metadata-only", "widget.yaml"), "orphan")
      await writeFile(join(space, "docs.meta.json"), "{bad")
      await writeWidget(root, "site")
      await mkdir(join(widgets, "site", "pages"))
      await writeFile(
        join(widgets, "site", "pages", "index.html"),
        "nested asset"
      )

      const report = await preflightDocumentWorkspace(root)
      const codes = report.diagnostics.map((diagnostic) => diagnostic.code)

      expect(report.clean).toBe(false)
      expect(report.conflictCount).toBe(1)
      expect(codes).toEqual(
        expect.arrayContaining([
          "logical-path-conflict",
          "document-warning",
          "filesystem-symlink",
          "orphan-widget-content",
          "orphan-widget-metadata",
          "metadata-invalid-json",
        ])
      )
      expect(
        report.diagnostics.filter(
          (diagnostic) => diagnostic.code === "orphan-widget-content"
        )
      ).toEqual([expect.objectContaining({ path: "widgets/content-only" })])
      expect(await readFile(join(docs, "same.md"), "utf8")).toBe("markdown")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("enumerates only published Spaces and isolates discovery failures", async () => {
    const root = await makeWorkspace()
    try {
      await writeFile(join(root, "spaces", "meta", "docs", "live.md"), "live")
      await mkdir(join(root, "spaces", "second", "docs"), { recursive: true })
      await mkdir(join(root, "spaces", "second", "widgets"))
      await writeSpaceManifest(root, "second")
      await writeFile(
        join(root, "spaces", "second", "docs", "second.md"),
        "second"
      )
      await mkdir(join(root, "spaces", ".trash", "deleted", "docs"), {
        recursive: true,
      })
      await writeFile(
        join(root, "spaces", ".trash", "deleted", "docs", "hidden.md"),
        "hidden"
      )
      await mkdir(join(root, "spaces", "prepared", "docs"), {
        recursive: true,
      })
      await writeFile(
        join(root, "spaces", "prepared", "docs", "hidden.md"),
        "hidden"
      )
      await mkdir(join(root, "spaces", "corrupt", "docs"), {
        recursive: true,
      })
      await mkdir(join(root, "spaces", "corrupt", "widgets"))
      await writeSpaceManifest(root, "corrupt")
      await writeFile(
        join(root, "spaces", "corrupt", "doc-aliases.json"),
        "{not json"
      )

      const report = await preflightDocumentWorkspace(root)

      expect(report.clean).toBe(false)
      expect(report.spaceIds).toEqual(["corrupt", "meta", "second"])
      expect(report.documents.map((document) => document.path)).toEqual([
        "live",
        "second",
      ])
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "document-discovery-failed",
          spaceId: "corrupt",
        })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("bounds workspace entries, source bytes, and portable metadata", async () => {
    const entryRoot = await makeWorkspace()
    const byteRoot = await makeWorkspace()
    const bundleRoot = await makeWorkspace()
    const metadataRoot = await makeWorkspace()
    const manifestRoot = await makeWorkspace()
    try {
      await writeFile(
        join(entryRoot, "spaces", "meta", "docs", "brief.md"),
        "brief"
      )
      const entryLimited = await preflightDocumentWorkspace(entryRoot, {
        maxEntries: 1,
      })
      expect(entryLimited.diagnostics).toContainEqual(
        expect.objectContaining({ code: "workspace-too-many-entries" })
      )

      await writeFile(
        join(byteRoot, "spaces", "meta", "docs", "brief.md"),
        "brief"
      )
      const byteLimited = await preflightDocumentWorkspace(byteRoot, {
        maxSourceBytes: 1,
      })
      expect(byteLimited.sourceBytes).toBe(0)
      expect(byteLimited.diagnostics).toContainEqual(
        expect.objectContaining({ code: "workspace-too-large" })
      )

      await writeWidget(bundleRoot, "status")
      const bundleLimited = await preflightDocumentWorkspace(bundleRoot, {
        maxSourceBytes: 20,
      })
      expect(bundleLimited.sourceBytes).toBe(0)
      expect(bundleLimited.documents).toEqual([
        expect.objectContaining({ path: "status", bytes: null, sha256: null }),
      ])
      expect(bundleLimited.diagnostics).toContainEqual(
        expect.objectContaining({ code: "workspace-too-large" })
      )

      const metadata = join(metadataRoot, "spaces", "meta", "docs.meta.json")
      await writeFile(metadata, "")
      await truncate(metadata, 8 * 1024 * 1024 + 1)
      const metadataLimited = await preflightDocumentWorkspace(metadataRoot)
      expect(metadataLimited.diagnostics).toContainEqual(
        expect.objectContaining({ code: "metadata-too-large" })
      )

      await writeFile(
        join(manifestRoot, "spaces", "meta", "space.json"),
        JSON.stringify({
          type: "worktable.space",
          version: 1,
          id: "meta",
          name: "meta",
          createdAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:00.000Z",
          createdBy: "test",
          settings: { padding: "x".repeat(1024 * 1024) },
        })
      )
      const manifestLimited = await preflightDocumentWorkspace(manifestRoot)
      expect(manifestLimited.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "filesystem-unreadable",
          path: "spaces/meta/space.json",
        })
      )
    } finally {
      await Promise.all(
        [entryRoot, byteRoot, bundleRoot, metadataRoot, manifestRoot].map(
          (root) => rm(root, { recursive: true, force: true })
        )
      )
    }
  })

  it("rejects symlinked workspace storage roots", async () => {
    const target = await makeWorkspace()
    const linkedParent = await mkdtemp(join(tmpdir(), "worktable-linked-root-"))
    const linkedWorkspace = join(linkedParent, "workspace")
    const linkedSpacesRoot = await mkdtemp(
      join(tmpdir(), "worktable-linked-spaces-")
    )
    const danglingRoot = await makeWorkspace()
    try {
      await symlink(target, linkedWorkspace)
      await symlink(join(target, "spaces"), join(linkedSpacesRoot, "spaces"))
      const docs = join(danglingRoot, "spaces", "meta", "docs")
      await rm(docs, { recursive: true })
      await symlink(join(danglingRoot, "missing-docs"), docs)

      const cases = [
        { root: linkedWorkspace, path: "." },
        { root: linkedSpacesRoot, path: "spaces" },
        { root: danglingRoot, path: "docs" },
      ]
      for (const entry of cases) {
        const report = await preflightDocumentWorkspace(entry.root)
        expect(report.clean).toBe(false)
        expect(report.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "filesystem-symlink",
            path: entry.path,
          })
        )
      }
    } finally {
      await Promise.all(
        [target, linkedParent, linkedSpacesRoot, danglingRoot].map((root) =>
          rm(root, { recursive: true, force: true })
        )
      )
    }
  })

  it("hashes opaque document sources and blocks nonportable bundles", async () => {
    const root = await makeWorkspace()
    try {
      await writeWidget(root, "status")
      const id = mintDocumentId()
      const bundle = join(root, "spaces", "meta", "widgets", "scene.wtdoc")
      await mkdir(bundle)
      await writeFile(join(bundle, "index.html"), "first")
      await writeFile(
        join(bundle, "manifest.json"),
        JSON.stringify({
          type: "worktable.document-bundle",
          version: 1,
          documentId: id,
          format: { id: "future.scene", sourceVersion: 1 },
          content: "index.html",
        })
      )
      await writeFile(
        join(root, "spaces", "meta", "documents.meta.json"),
        JSON.stringify({
          type: "worktable.document-inventory",
          version: 1,
          documents: {
            [id]: {
              path: "scenes/main",
              format: { id: "future.scene", sourceVersion: 1 },
              source: {
                kind: "bundle",
                relativePath: "widgets/scene.wtdoc",
                manifestPath: "widgets/scene.wtdoc/manifest.json",
              },
            },
          },
        })
      )

      const first = await preflightDocumentWorkspace(root)
      await writeFile(join(bundle, "index.html"), "second")
      const second = await preflightDocumentWorkspace(root)

      expect(first.clean).toBe(true)
      expect(first.documents.map((document) => document.path)).toEqual([
        "scenes/main",
        "status",
      ])
      expect(first.documents[0]?.sha256).not.toBe(second.documents[0]?.sha256)
      expect(first.checkpoint).not.toBe(second.checkpoint)

      const reservedPath = join(bundle, "CON")
      await writeFile(reservedPath, "reserved on Windows")
      const reserved = await preflightDocumentWorkspace(root)
      expect(reserved.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "source-capture-failed",
          path: "scenes/main",
        })
      )
      await rm(reservedPath)

      await mkdir(join(bundle, "Assets"))
      await mkdir(join(bundle, "assets"))
      const colliding = await preflightDocumentWorkspace(root)
      expect(colliding.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "source-capture-failed",
          path: "scenes/main",
        })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
