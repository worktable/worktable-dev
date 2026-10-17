import { WorkspaceExportPathError } from "./workspace-package-path.ts"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { pipeline } from "node:stream/promises"
import * as yazl from "yazl"
import type { DocumentId } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import {
  BUILTIN_DOCUMENT_COMPANIONS,
  BUILTIN_DOCUMENT_FORMATS,
} from "./document-format-registry.ts"
import { writeDocumentGenerationV2 } from "./document-version-store-v2.ts"
import {
  cleanupAbandonedWorkspaceExportCaptures,
  importWorkspaceExportV2,
  inspectWorkspaceExportV2,
  isWorkspaceExportV2,
  setHistoryClassificationHookForTests,
  setWorkspaceExportArchiveLimitForTests,
  setWorkspaceExportBeforePublishHookForTests,
  setWorkspaceExportCaptureHookForTests,
  setWorkspaceExportCaptureRemovalHookForTests,
  setWorkspaceExportManifestLimitForTests,
  setWorkspaceExportPipelineStartHookForTests,
  setWorkspaceExportViewerGeneratedLimitForTests,
  validateWorkspaceExportV2Path,
  writeWorkspaceExportV2,
  WORKSPACE_EXPORT_V2_MAX_ARCHIVE_BYTES,
  WORKSPACE_EXPORT_V2_MAX_ARCHIVE_ENTRIES,
  WORKSPACE_EXPORT_V2_MAX_EXPANDED_BYTES,
  WORKSPACE_EXPORT_V2_MAX_FILE_BYTES,
  WORKSPACE_EXPORT_V2_MAX_MANIFEST_BYTES,
  WORKSPACE_EXPORT_V2_MAX_WORKSPACE_ENTRIES,
  WORKSPACE_EXPORT_V2_MAX_WORKSPACE_MANIFEST_BYTES,
} from "./workspace-transfer-v2.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

let root: string
let source: string
let appDir: string

async function replaceArchiveEntry(
  sourceArchive: string,
  destinationArchive: string,
  targetPath: string,
  replacement: Buffer
): Promise<void> {
  const listing = spawnSync("unzip", ["-Z1", sourceArchive], {
    encoding: "utf8",
  })
  if (listing.status !== 0) {
    throw new Error(`could not list test archive: ${listing.stderr}`)
  }
  const zip = new yazl.ZipFile()
  const writing = pipeline(
    zip.outputStream,
    createWriteStream(destinationArchive)
  )
  for (const path of listing.stdout.trim().split("\n")) {
    if (path.endsWith("/")) {
      zip.addEmptyDirectory(path.slice(0, -1))
      continue
    }
    const extracted = spawnSync("unzip", ["-p", sourceArchive, path], {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    })
    if (extracted.status !== 0) {
      throw new Error(`could not read test archive entry: ${path}`)
    }
    zip.addBuffer(path === targetPath ? replacement : extracted.stdout, path)
  }
  zip.end()
  await writing
}

async function addVersion(
  createdAt: string,
  suffix: string,
  meaningful = false
): Promise<string> {
  const id = `${createdAt.replace(
    /[:.]/g,
    "-"
  )}-000000-${suffix.padEnd(8, "0").slice(0, 8)}`
  const path = join(
    source,
    "versions",
    "notes",
    "docs",
    "welcome",
    `${id}.json`
  )
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify({
      createdAt,
      checkpoint: { meaningful },
      content: `Version ${suffix}`,
    })}\n`
  )
  return `versions/notes/docs/welcome/${id}.json`
}

async function addV2Generation(
  createdAt: string,
  suffix: string,
  meaningful = false,
  documentId = "doc_VVVVVVVVVVVVVVVVVVVVVV" as DocumentId
): Promise<string> {
  const generationId = `${createdAt.replace(
    /[:.]/g,
    "-"
  )}-000000-${suffix.padEnd(8, "0").slice(0, 8)}`
  await writeDocumentGenerationV2({
    workspaceRoot: source,
    spaceId: "notes",
    documentId,
    generationId,
    logicalPath: "welcome-v2",
    format: { id: BUILTIN_DOCUMENT_FORMATS.markdown, sourceVersion: 1 },
    operation: meaningful ? "checkpoint" : "update",
    createdAt,
    createdBy: "test",
    source: "history-policy",
    ...(meaningful
      ? { checkpoint: { meaningful: true, kind: "manual" as const } }
      : {}),
    authoredSource: {
      kind: "file",
      entries: [{ path: "document.md", bytes: Buffer.from(suffix) }],
    },
  })
  return `versions/notes/documents/${documentId}/${generationId}`
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "worktable-transfer-v2-")))
  source = join(root, "source")
  appDir = join(root, "app")
  setWorkspaceRootOverride(source)
  setAppDirOverride(appDir)
  ensureWorkspaceManifest()
  await mkdir(join(source, "spaces", "notes", "docs"), { recursive: true })
  await mkdir(join(source, "spaces", "notes", "widgets", "clock"), {
    recursive: true,
  })
  await writeFile(
    join(source, "spaces", "notes", "docs", "welcome.md"),
    "# Welcome\n\nPortable content.\n"
  )
  await writeFile(
    join(source, "spaces", "notes", "widgets", "clock", "index.html"),
    '<meta http-equiv="refresh" content="0;url=https://example.test/leak"><h1>Offline HTML doc</h1><a href="https://example.test/click">leave</a><script>window.evil = true</script>'
  )
})

afterEach(async () => {
  setHistoryClassificationHookForTests(null)
  setWorkspaceExportCaptureHookForTests(null)
  setWorkspaceExportCaptureRemovalHookForTests(null)
  setWorkspaceExportBeforePublishHookForTests(null)
  setWorkspaceExportArchiveLimitForTests(null)
  setWorkspaceExportManifestLimitForTests(null)
  setWorkspaceExportPipelineStartHookForTests(null)
  setWorkspaceExportViewerGeneratedLimitForTests(null)
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("workspace export v2", () => {
  it("excludes incompatible history before portability validation and preserves source bytes", async () => {
    const bad = join(source, "versions/notes/docs/legacy-note ")
    await mkdir(bad, { recursive: true })
    await writeFile(join(bad, "snapshot.json"), '{"content":"keep me"}')
    const result = await writeWorkspaceExportV2(join(root, "no-history"), {
      history: { mode: "none" },
    })
    const inspected = await inspectWorkspaceExportV2(result.destination)
    expect(inspected.manifest.history).toMatchObject({
      includedFiles: 0,
      omittedFiles: 1,
      complete: false,
    })
    expect(await readFile(join(bad, "snapshot.json"), "utf8")).toBe(
      '{"content":"keep me"}'
    )
    expect(
      inspected.manifest.integrity.files.some((file) =>
        file.path.startsWith("versions/")
      )
    ).toBe(false)
  })

  it("requires reviewed history recovery, retains whole V2 generations, and rejects expanded consent", async () => {
    const unit = await addV2Generation("2026-01-01T00:00:00.000Z", "bad")
    await writeFile(join(source, unit, "trailing "), "legacy companion")
    await addVersion("2026-01-02T00:00:00.000Z", "good", true)
    let failure: WorkspaceExportPathError | undefined
    try {
      await writeWorkspaceExportV2(join(root, "strict"))
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceExportPathError)
      failure = error as WorkspaceExportPathError
    }
    expect(failure?.diagnostics.code).toBe("NON_PORTABLE_HISTORY")
    const fingerprint = failure!.diagnostics.recoveryFingerprint!
    const result = await writeWorkspaceExportV2(join(root, "recovered"), {
      recoveryFingerprint: fingerprint,
    })
    const inspected = await inspectWorkspaceExportV2(result.destination)
    expect(
      inspected.manifest.integrity.files.some((file) =>
        file.path.startsWith(unit)
      )
    ).toBe(false)
    expect(inspected.manifest.history.includedFiles).toBe(1)
    expect(inspected.manifest.history.recovery?.omittedFiles).toBe(3)
    expect(inspected.manifest.history.meaningfulCheckpoints).toBe(1)
    await importWorkspaceExportV2(result.destination, join(root, "restored"))
    await writeFile(join(source, unit, "second bad "), "new")
    await expect(
      writeWorkspaceExportV2(join(root, "changed"), {
        recoveryFingerprint: fingerprint,
      })
    ).rejects.toBeInstanceOf(WorkspaceExportPathError)
  })

  it("never offers recovery for current content and omits both sides of a history collision", async () => {
    await mkdir(join(source, "versions/notes/docs/Name"), { recursive: true })
    await mkdir(join(source, "versions/notes/docs/name"), { recursive: true })
    await writeFile(join(source, "versions/notes/docs/Name/one.json"), "{}")
    await writeFile(join(source, "versions/notes/docs/name/two.json"), "{}")
    const failed = await writeWorkspaceExportV2(join(root, "collision")).then(
      () => {
        throw new Error("expected export failure")
      },
      (error) => error as WorkspaceExportPathError
    )
    expect(failed.diagnostics.affectedFiles).toBe(2)
    const result = await writeWorkspaceExportV2(
      join(root, "without-collision"),
      { recoveryFingerprint: failed.diagnostics.recoveryFingerprint }
    )
    expect(result.manifest.history).toMatchObject({
      includedFiles: 0,
      omittedFiles: 2,
    })
    await writeFile(join(source, "spaces/notes/docs/bad "), "current")
    const blocked = await writeWorkspaceExportV2(join(root, "current-bad"), {
      history: { mode: "none" },
    }).then(
      () => {
        throw new Error("expected export failure")
      },
      (error) => error as WorkspaceExportPathError
    )
    expect(blocked.diagnostics.code).toBe("NON_PORTABLE_CONTENT")
    expect(blocked.diagnostics.recoveryFingerprint).toBeUndefined()
  })

  it("publishes the supported transfer envelope as one coherent contract", () => {
    expect(WORKSPACE_EXPORT_V2_MAX_ARCHIVE_BYTES).toBe(2 * 1024 ** 3)
    expect(WORKSPACE_EXPORT_V2_MAX_EXPANDED_BYTES).toBe(8 * 1024 ** 3)
    expect(WORKSPACE_EXPORT_V2_MAX_FILE_BYTES).toBe(2 * 1024 ** 3)
    expect(WORKSPACE_EXPORT_V2_MAX_WORKSPACE_ENTRIES).toBe(100_000)
    expect(WORKSPACE_EXPORT_V2_MAX_ARCHIVE_ENTRIES).toBe(200_000)
    expect(WORKSPACE_EXPORT_V2_MAX_MANIFEST_BYTES).toBe(32 * 1024 ** 2)
  })

  it("creates a standard, independently browsable ZIP and round-trips content", async () => {
    const sourceManifest = ensureWorkspaceManifest()
    const transactionArtifacts = [
      "spaces/notes/annotations/.store.lock",
      "spaces/notes/annotations/.store.lock.candidate-1-test",
      "spaces/notes/document-data/doc_0000000000000000000000/annotations.json.lock",
      "spaces/notes/document-data/doc_0000000000000000000000/state/.write-lock.stale-1-test",
      "spaces/notes/document-data/doc_0000000000000000000000/state/.worktable-write-1-0123456789abcdef0123456789abcdef.tmp",
      "spaces/notes/document-data/doc_0000000000000000000000/state/revisions/.pending-state/manifest.json",
      "versions/notes/documents/doc_0000000000000000000000/.write-lock.candidate-1-test",
      "versions/notes/documents/doc_0000000000000000000000/.pending-version/manifest.json",
    ]
    for (const path of transactionArtifacts) {
      const absolute = join(source, path)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, '{"pid":1}\n')
    }
    await writeFile(
      join(source, "spaces", "notes", "docs", ".pending-guide.md"),
      "# Authored pending guide\n"
    )
    await writeFile(
      join(source, "spaces", "notes", "docs", ".worktable-write-1-a.tmp"),
      "authored lookalike\n"
    )
    const result = await writeWorkspaceExportV2(join(root, "portable"))

    expect(result.destination).toBe(join(root, "portable.wtb"))
    expect(await isWorkspaceExportV2(result.destination)).toBe(true)
    expect((await stat(result.destination)).mode & 0o777).toBe(0o600)

    const listing = spawnSync("unzip", ["-Z1", result.destination], {
      encoding: "utf8",
    })
    expect(listing.status).toBe(0)
    expect(listing.stdout).toContain("/Open Worktable Export.html")
    expect(listing.stdout).toContain("/README.txt")
    expect(listing.stdout).toContain("/workspace/worktable.workspace.json")
    for (const path of transactionArtifacts) {
      expect(listing.stdout).not.toContain(path)
    }
    expect(listing.stdout).toContain("docs/.pending-guide.md")
    expect(listing.stdout).toContain("docs/.worktable-write-1-a.tmp")
    const previewPath = listing.stdout
      .split("\n")
      .find((path) => /\/browse\/content\/preview-\d+\.html$/.test(path))
    expect(previewPath).toBeDefined()
    const preview = spawnSync(
      "unzip",
      ["-p", result.destination, previewPath!],
      {
        encoding: "utf8",
      }
    )
    expect(preview.status).toBe(0)
    expect(
      preview.stdout.indexOf("Content-Security-Policy")
    ).toBeGreaterThanOrEqual(0)
    expect(preview.stdout.indexOf("Content-Security-Policy")).toBeLessThan(
      preview.stdout.indexOf("<h1>Offline HTML doc</h1>")
    )
    expect(preview.stdout).not.toContain("example.test")
    expect(preview.stdout).not.toContain("<script")
    const itemPaths = listing.stdout
      .split("\n")
      .filter((path) => /\/browse\/content\/item-\d+\.html$/.test(path))
    const htmlItem = itemPaths
      .map(
        (path) =>
          spawnSync("unzip", ["-p", result.destination, path], {
            encoding: "utf8",
          }).stdout
      )
      .find((contents) => contents.includes("Sandboxed preview"))
    expect(htmlItem).toContain("<iframe sandbox")
    expect(htmlItem).not.toContain("Open raw HTML")
    expect(htmlItem).not.toMatch(/href="[^"]*workspace\/[^"]*\/index\.html"/)

    const inspected = await inspectWorkspaceExportV2(result.destination)
    expect(inspected.manifest.source.workspaceId).toBe(sourceManifest.id)
    expect(inspected.manifest.viewer.status).toBe("complete")
    expect(inspected.archiveSha256).toBe(result.sha256)

    const destination = join(root, "restored")
    const imported = await importWorkspaceExportV2(
      result.destination,
      destination
    )
    expect(imported.id).not.toBe(sourceManifest.id)
    expect(imported.cloud.status).toBe("unlinked")
    expect(imported.provenance).toMatchObject({
      source: { workspaceId: sourceManifest.id },
      snapshotAt: result.manifest.exportedAt,
      oneWay: true,
    })
    expect(
      await readFile(
        join(destination, "spaces", "notes", "docs", "welcome.md"),
        "utf8"
      )
    ).toBe("# Welcome\n\nPortable content.\n")
    for (const path of transactionArtifacts) {
      await expect(stat(join(destination, path))).rejects.toThrow()
    }
    expect(
      await readFile(
        join(destination, "spaces", "notes", "docs", ".pending-guide.md"),
        "utf8"
      )
    ).toBe("# Authored pending guide\n")
  })

  it("uses one source-identity contract for writers and untrusted packages", async () => {
    const manifestPath = join(source, "worktable.workspace.json")
    const sourceManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name: string
    }
    sourceManifest.name = "   "
    await writeFile(manifestPath, `${JSON.stringify(sourceManifest)}\n`)
    await expect(
      writeWorkspaceExportV2(join(root, "invalid-source"))
    ).rejects.toThrow(/source identity/)

    sourceManifest.name = "Valid source"
    await writeFile(manifestPath, `${JSON.stringify(sourceManifest)}\n`)
    const valid = await writeWorkspaceExportV2(join(root, "valid-source"))
    const malformed = structuredClone(valid.manifest)
    malformed.source.workspaceName = "   "
    const archive = join(root, "invalid-source.wtb")
    const zip = new yazl.ZipFile()
    const writing = pipeline(zip.outputStream, createWriteStream(archive))
    zip.addBuffer(
      Buffer.from(`${JSON.stringify(malformed)}\n`),
      `${malformed.archive.root}/worktable-export.json`
    )
    zip.end()
    await writing

    await expect(inspectWorkspaceExportV2(archive)).rejects.toThrow(
      /source identity/
    )
  })

  it("bounds viewer titles before adding them to the offline index", async () => {
    const oversizedTitle = "x".repeat(100_000)
    await writeFile(
      join(source, "spaces", "notes", "docs", "welcome.md"),
      `# ${oversizedTitle}\n`
    )

    const result = await writeWorkspaceExportV2(join(root, "bounded-title"))
    const index = spawnSync(
      "unzip",
      [
        "-p",
        result.destination,
        `${result.manifest.archive.root}/Open Worktable Export.html`,
      ],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }
    )

    expect(index.status).toBe(0)
    expect(index.stdout).toContain(`${"x".repeat(100)}x`)
    expect(index.stdout).not.toContain("x".repeat(1_000))
  })

  it("counts the final index and README against the viewer budget", async () => {
    setWorkspaceExportViewerGeneratedLimitForTests(64 * 1024)
    await rm(join(source, "spaces", "notes", "widgets"), {
      recursive: true,
      force: true,
    })
    await writeFile(
      join(source, "spaces", "notes", "docs", "welcome.md"),
      `# Near limit\n\n${"a".repeat(61 * 1024)}\n`
    )

    const result = await writeWorkspaceExportV2(join(root, "bounded-viewer"))
    const listing = spawnSync("unzip", ["-Z1", result.destination], {
      encoding: "utf8",
    })

    expect(listing.status).toBe(0)
    expect(listing.stdout).not.toMatch(/\/browse\/content\/item-\d+\.html/)
    expect(result.manifest.viewer.status).toBe("partial")
    expect(result.manifest.viewer.warnings).toContain(
      "Additional current files are available in workspace/ but omitted from the offline index"
    )
    expect(result.manifest.viewer.warnings).not.toContainEqual(
      expect.stringContaining("Could not render")
    )
  })

  it("does not link raw HTML when the offline preview cannot be generated", async () => {
    setWorkspaceExportViewerGeneratedLimitForTests(16 * 1024)
    await writeFile(
      join(source, "spaces", "notes", "widgets", "clock", "index.html"),
      `<h1>${"x".repeat(20 * 1024)}</h1>`
    )

    const result = await writeWorkspaceExportV2(join(root, "html-fallback"))
    const index = spawnSync(
      "unzip",
      [
        "-p",
        result.destination,
        `${result.manifest.archive.root}/Open Worktable Export.html`,
      ],
      { encoding: "utf8" }
    )

    expect(index.status).toBe(0)
    expect(index.stdout).toContain("extract and inspect as text")
    expect(index.stdout).not.toMatch(
      /href="[^"]*workspace\/[^"]*\/index\.html"/
    )
  })

  it("stops ZIP generation at the archive ceiling and removes partial output", async () => {
    setWorkspaceExportArchiveLimitForTests(1_024)

    await expect(
      writeWorkspaceExportV2(join(root, "bounded-archive"))
    ).rejects.toThrow(/archive limit/)
    await expect(stat(join(root, "bounded-archive.wtb"))).rejects.toThrow()
    expect(
      (await readdir(root)).some((name) => name.includes("bounded-archive"))
    ).toBe(false)
  })

  it("removes partial output even when immutable-capture cleanup fails", async () => {
    setWorkspaceExportBeforePublishHookForTests(async () => {
      throw new Error("injected publication failure")
    })
    setWorkspaceExportCaptureRemovalHookForTests(async () => {
      throw new Error("injected capture cleanup failure")
    })

    await expect(
      writeWorkspaceExportV2(join(root, "cleanup-failure"))
    ).rejects.toThrow(/capture cleanup failure/)
    expect(
      (await readdir(root)).some((name) => name.includes("cleanup-failure"))
    ).toBe(false)
  })

  it("rejects an oversized manifest before opening the ZIP pipeline", async () => {
    setWorkspaceExportManifestLimitForTests(1)
    let pipelineStarts = 0
    setWorkspaceExportPipelineStartHookForTests(() => {
      pipelineStarts += 1
    })

    await expect(
      writeWorkspaceExportV2(join(root, "bounded-manifest"))
    ).rejects.toThrow(/manifest exceeds/)
    expect(pipelineStarts).toBe(0)
    await expect(stat(join(root, "bounded-manifest.wtb"))).rejects.toThrow()
    expect(
      (await readdir(root)).some((name) => name.includes("bounded-manifest"))
    ).toBe(false)
  })

  it("supports all, none, age, and per-item history policies", async () => {
    const oldMeaningful = await addVersion(
      "2020-01-01T00:00:00.000Z",
      "old",
      true
    )
    await addVersion("2020-01-02T00:00:00.000Z", "old2")
    const recent = await addVersion(new Date().toISOString(), "new")
    const oldMeaningfulV2 = await addV2Generation(
      "2020-01-01T00:00:00.000Z",
      "old-v2",
      true
    )
    await addV2Generation("2020-01-02T00:00:00.000Z", "old2-v2")
    const recentV2 = await addV2Generation(new Date().toISOString(), "new-v2")
    const retiredDocumentId = "doc_RRRRRRRRRRRRRRRRRRRRRR" as DocumentId
    const oldMeaningfulRetired = await addV2Generation(
      "2020-01-01T00:00:00.000Z",
      "old-retired",
      true,
      retiredDocumentId
    )
    await addV2Generation(
      "2020-01-02T00:00:00.000Z",
      "old2-retired",
      false,
      retiredDocumentId
    )
    const recentRetired = await addV2Generation(
      new Date().toISOString(),
      "new-retired",
      false,
      retiredDocumentId
    )
    const retirementId = "dsv2_delete-retired-history"
    const activeRetiredRoot = join(
      source,
      "versions",
      "notes",
      "documents",
      retiredDocumentId
    )
    const retiredRoot = join(
      source,
      "versions",
      "notes",
      ".retired",
      "documents",
      retiredDocumentId,
      retirementId
    )
    await mkdir(dirname(retiredRoot), { recursive: true })
    await rename(activeRetiredRoot, retiredRoot)
    const retiredPath = (path: string) =>
      path.replace(
        `versions/notes/documents/${retiredDocumentId}`,
        `versions/notes/.retired/documents/${retiredDocumentId}/${retirementId}`
      )

    const all = await writeWorkspaceExportV2(join(root, "all"), {
      history: { mode: "all" },
    })
    expect(all.manifest.history).toMatchObject({
      complete: true,
      includedFiles: 15,
      omittedFiles: 0,
      meaningfulCheckpoints: 3,
    })

    const none = await writeWorkspaceExportV2(join(root, "none"), {
      history: { mode: "none" },
    })
    expect(none.manifest.history).toMatchObject({
      complete: false,
      includedFiles: 0,
      omittedFiles: 15,
    })

    const age = await writeWorkspaceExportV2(join(root, "age"), {
      history: { mode: "age", maxAgeDays: 30 },
    })
    const agePaths = age.manifest.integrity.files.map((file) => file.path)
    expect(agePaths).toContain(oldMeaningful)
    expect(agePaths).toContain(recent)
    expect(
      agePaths.filter((path) => path.startsWith(oldMeaningfulV2))
    ).toHaveLength(2)
    expect(agePaths.filter((path) => path.startsWith(recentV2))).toHaveLength(2)
    expect(
      agePaths.filter((path) =>
        path.startsWith(retiredPath(oldMeaningfulRetired))
      )
    ).toHaveLength(2)
    expect(
      agePaths.filter((path) => path.startsWith(retiredPath(recentRetired)))
    ).toHaveLength(2)
    expect(age.manifest.history.includedFiles).toBe(10)

    const count = await writeWorkspaceExportV2(join(root, "count"), {
      history: { mode: "count", maxPerItem: 1 },
    })
    const countPaths = count.manifest.integrity.files.map((file) => file.path)
    expect(countPaths).toContain(oldMeaningful)
    expect(countPaths).toContain(recent)
    expect(
      countPaths.filter((path) => path.startsWith(oldMeaningfulV2))
    ).toHaveLength(2)
    expect(countPaths.filter((path) => path.startsWith(recentV2))).toHaveLength(
      2
    )
    expect(
      countPaths.filter((path) =>
        path.startsWith(retiredPath(oldMeaningfulRetired))
      )
    ).toHaveLength(2)
    expect(
      countPaths.filter((path) => path.startsWith(retiredPath(recentRetired)))
    ).toHaveLength(2)
    expect(count.manifest.history.includedFiles).toBe(10)
  }, 15_000)

  it("preserves unreadable generations without spending the per-item history limit", async () => {
    const previousV2 = await addV2Generation(
      "2020-01-02T00:00:00.000Z",
      "old2-v2"
    )
    const recentV2 = await addV2Generation(new Date().toISOString(), "new-v2")
    const documentId = "doc_VVVVVVVVVVVVVVVVVVVVVV" as DocumentId
    const invalidOwnershipId = "2030-01-01T00-00-00-000Z-invalid-owner"
    const invalidOwnershipV2 = `versions/notes/documents/${documentId}/${invalidOwnershipId}`
    await writeDocumentGenerationV2({
      workspaceRoot: source,
      spaceId: "notes",
      documentId,
      generationId: invalidOwnershipId,
      logicalPath: "welcome-v2",
      format: { id: BUILTIN_DOCUMENT_FORMATS.html, sourceVersion: 1 },
      operation: "update",
      createdAt: "2030-01-01T00:00:00.000Z",
      createdBy: "test",
      source: "history-policy",
      authoredSource: {
        kind: "file",
        entries: [{ path: "index.html", bytes: Buffer.from("<p>invalid</p>") }],
      },
      companions: [
        {
          key: BUILTIN_DOCUMENT_COMPANIONS.htmlPermissions,
          entries: [{ path: "permissions.json", bytes: Buffer.from("{}") }],
        },
      ],
    })
    const invalidManifestPath = join(
      source,
      invalidOwnershipV2,
      "manifest.json"
    )
    const invalidManifest = JSON.parse(
      await readFile(invalidManifestPath, "utf8")
    )
    invalidManifest.format.id = BUILTIN_DOCUMENT_FORMATS.markdown
    await writeFile(invalidManifestPath, `${JSON.stringify(invalidManifest)}\n`)
    await writeFile(join(source, recentV2, "source", "document.md"), "corrupt")
    const countWithUnreadableNewest = await writeWorkspaceExportV2(
      join(root, "count-unreadable-newest"),
      { history: { mode: "count", maxPerItem: 1 } }
    )
    const unreadablePaths =
      countWithUnreadableNewest.manifest.integrity.files.map(
        (file) => file.path
      )
    expect(
      unreadablePaths.filter((path) => path.startsWith(invalidOwnershipV2))
    ).toHaveLength(3)
    expect(
      unreadablePaths.filter((path) => path.startsWith(recentV2))
    ).toHaveLength(2)
    expect(
      unreadablePaths.filter((path) => path.startsWith(previousV2))
    ).toHaveLength(2)
    expect(countWithUnreadableNewest.manifest.history.warnings).toContainEqual(
      expect.stringContaining(invalidOwnershipV2)
    )
    expect(countWithUnreadableNewest.manifest.history.warnings).toContainEqual(
      expect.stringContaining(recentV2)
    )
  })

  it("handles history beyond the old 256 MiB boundary through an explicit policy", async () => {
    const oversizedVersion = join(
      source,
      "versions",
      "notes",
      "docs",
      "welcome",
      "2020-01-01T00-00-00-000Z-000000-oversize.json"
    )
    await mkdir(join(oversizedVersion, ".."), { recursive: true })
    const handle = await open(oversizedVersion, "w")
    try {
      await handle.truncate(257 * 1024 * 1024)
    } finally {
      await handle.close()
    }

    const result = await writeWorkspaceExportV2(join(root, "large-history"), {
      history: { mode: "none" },
    })
    const inspected = await inspectWorkspaceExportV2(result.destination)

    expect(inspected.manifest.history.includedFiles).toBe(0)
    expect(inspected.manifest.history.omittedFiles).toBe(1)
    expect(inspected.manifest.history.omittedBytes).toBeGreaterThan(
      256 * 1024 * 1024
    )
  })

  it("conservatively keeps an oversized unclassifiable version for bounded history", async () => {
    const oversizedVersion = join(
      source,
      "versions",
      "notes",
      "docs",
      "welcome",
      "2020-01-01T00-00-00-000Z-000000-oversize.json"
    )
    await mkdir(join(oversizedVersion, ".."), { recursive: true })
    const handle = await open(oversizedVersion, "w")
    try {
      await handle.truncate(17 * 1024 * 1024)
    } finally {
      await handle.close()
    }

    const result = await writeWorkspaceExportV2(
      join(root, "large-classification"),
      {
        history: { mode: "count", maxPerItem: 1 },
      }
    )

    expect(result.manifest.integrity.files.map((file) => file.path)).toContain(
      "versions/notes/docs/welcome/2020-01-01T00-00-00-000Z-000000-oversize.json"
    )
    expect(result.manifest.history.warnings).toContainEqual(
      expect.stringContaining("Included unclassifiable")
    )
  })

  it("bounds concurrent history classification work", async () => {
    for (let index = 0; index < 20; index += 1) {
      await addVersion(
        `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        String(index)
      )
    }
    let active = 0
    let maximum = 0
    let release!: () => void
    let saturated!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const reachedLimit = new Promise<void>((resolve) => {
      saturated = resolve
    })
    setHistoryClassificationHookForTests(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      if (active === 8) saturated()
      await gate
      active -= 1
    })

    const exporting = writeWorkspaceExportV2(join(root, "bounded-history"), {
      history: { mode: "count", maxPerItem: 1 },
    })
    await reachedLimit
    release()
    await exporting

    expect(maximum).toBe(8)
  })

  it("refuses unsafe sources and destinations", async () => {
    await symlink(
      join(source, "worktable.workspace.json"),
      join(source, "spaces", "manifest-link")
    )
    await expect(writeWorkspaceExportV2(join(root, "unsafe"))).rejects.toThrow(
      /refuses symlink/
    )
    await rm(join(source, "spaces", "manifest-link"))

    const existing = join(root, "existing.wtb")
    await writeFile(existing, "unchanged")
    await expect(writeWorkspaceExportV2(existing)).rejects.toThrow(
      /already exists/
    )
    expect(await readFile(existing, "utf8")).toBe("unchanged")

    await chmod(existing, 0o644)
    await writeWorkspaceExportV2(existing, { force: true })
    expect((await stat(existing)).mode & 0o777).toBe(0o600)

    const nested = join(source, "must-not-be-created", "inside")
    await expect(writeWorkspaceExportV2(nested)).rejects.toThrow(
      /outside the workspace/
    )
    await expect(stat(join(source, "must-not-be-created"))).rejects.toThrow()
  })

  it("fails a mixed capture clearly and succeeds when the user retries", async () => {
    const content = join(source, "spaces", "notes", "docs", "a.md")
    const metadata = join(source, "spaces", "notes", "docs", "z.meta.json")
    await writeFile(content, "old content\n")
    await writeFile(metadata, '{"content":"old"}\n')
    let mutated = false
    setWorkspaceExportCaptureHookForTests(async (entry) => {
      if (!mutated && entry.path === "spaces/notes/docs/a.md") {
        mutated = true
        await writeFile(content, "new content\n")
        await writeFile(metadata, '{"content":"new"}\n')
      }
    })

    await expect(
      writeWorkspaceExportV2(join(root, "inconsistent"))
    ).rejects.toThrow(/changed during export/)
    await expect(stat(join(root, "inconsistent.wtb"))).rejects.toThrow()

    const result = await writeWorkspaceExportV2(join(root, "consistent"))
    const restored = join(root, "consistent-restored")
    await importWorkspaceExportV2(result.destination, restored)

    expect(mutated).toBe(true)
    expect(
      await readFile(join(restored, "spaces", "notes", "docs", "a.md"), "utf8")
    ).toBe("new content\n")
    expect(
      await readFile(
        join(restored, "spaces", "notes", "docs", "z.meta.json"),
        "utf8"
      )
    ).toBe('{"content":"new"}\n')
  })

  it("cleans private capture files when snapshot construction fails", async () => {
    setWorkspaceExportCaptureHookForTests(async (entry) => {
      if (entry.path.endsWith("welcome.md")) {
        throw new Error("injected capture failure")
      }
    })

    await expect(
      writeWorkspaceExportV2(join(root, "capture-failure"))
    ).rejects.toThrow(/injected capture failure/)
    expect(
      await readdir(join(appDir, "workspace-transfers", "captures"))
    ).toEqual([])
  })

  it("reclaims abandoned private captures, including read-only trees", async () => {
    const capture = join(
      appDir,
      "workspace-transfers",
      "captures",
      "export-abandoned"
    )
    const nested = join(capture, "read-only")
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, "partial"), "interrupted export")
    await chmod(nested, 0o500)
    await chmod(capture, 0o500)

    await expect(cleanupAbandonedWorkspaceExportCaptures()).resolves.toBe(1)
    await expect(stat(capture)).rejects.toThrow()
  })

  it("never reclaims a capture while an export still owns it", async () => {
    let captureEntered!: () => void
    let releaseCapture!: () => void
    const entered = new Promise<void>((resolve) => {
      captureEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseCapture = resolve
    })
    let blocked = false
    setWorkspaceExportCaptureHookForTests(async () => {
      if (blocked) return
      blocked = true
      captureEntered()
      await gate
    })

    const exporting = writeWorkspaceExportV2(join(root, "active-capture"))
    await entered
    expect(
      await readdir(join(appDir, "workspace-transfers", "captures"))
    ).toHaveLength(1)
    await expect(cleanupAbandonedWorkspaceExportCaptures()).resolves.toBe(0)
    releaseCapture()
    await expect(exporting).resolves.toMatchObject({
      destination: join(root, "active-capture.wtb"),
    })
    expect(
      await readdir(join(appDir, "workspace-transfers", "captures"))
    ).toEqual([])
  })

  it("rejects selected content beyond the importer expanded-size limit", async () => {
    for (let index = 0; index < 8; index += 1) {
      const handle = await open(join(source, `sparse-${index}.bin`), "w")
      try {
        await handle.truncate(WORKSPACE_EXPORT_V2_MAX_FILE_BYTES)
      } finally {
        await handle.close()
      }
    }

    await expect(
      writeWorkspaceExportV2(join(root, "too-expanded"))
    ).rejects.toThrow(/expanded-size limit/)
  })

  it("revalidates the destination inode immediately before publication", async () => {
    const destination = join(root, "replace-me.wtb")
    await writeFile(destination, "original")
    setWorkspaceExportBeforePublishHookForTests(async () => {
      const moved = join(root, "replace-me.original")
      await rename(destination, moved)
      await writeFile(destination, "concurrent replacement")
    })

    await expect(
      writeWorkspaceExportV2(destination, { force: true })
    ).rejects.toThrow(/destination changed/)
    expect(await readFile(destination, "utf8")).toBe("concurrent replacement")
  })

  it("rejects an ancestor swapped to a symlink during capture", async () => {
    const notes = join(source, "spaces", "notes")
    const original = join(source, "spaces", "notes-original")
    const outside = join(root, "outside-notes")
    await mkdir(join(outside, "docs"), { recursive: true })
    await writeFile(
      join(outside, "docs", "welcome.md"),
      "outside content must not be exported"
    )
    let swapped = false
    setWorkspaceExportCaptureHookForTests(async (entry) => {
      if (!swapped && entry.path === "spaces/notes") {
        swapped = true
        await rename(notes, original)
        await symlink(outside, notes)
      }
    })

    await expect(
      writeWorkspaceExportV2(join(root, "ancestor-swap"))
    ).rejects.toThrow(/changed during export|refuses symlink/)
    expect(swapped).toBe(true)
  })

  it("round-trips read-only directory modes without blocking extraction", async () => {
    const docs = join(source, "spaces", "notes", "docs")
    await chmod(docs, 0o555)
    const result = await writeWorkspaceExportV2(join(root, "read-only"))
    const restored = join(root, "read-only-restored")
    await importWorkspaceExportV2(result.destination, restored)

    expect(
      (await stat(join(restored, "spaces", "notes", "docs"))).mode & 0o777
    ).toBe(0o555)
    expect(
      await readFile(
        join(restored, "spaces", "notes", "docs", "welcome.md"),
        "utf8"
      )
    ).toContain("Portable content")
    await chmod(docs, 0o755)
    await chmod(join(restored, "spaces", "notes", "docs"), 0o755)
  })

  it("imports a read-only source manifest through an owner-only atomic replacement", async () => {
    const sourceManifest = join(source, "worktable.workspace.json")
    await chmod(sourceManifest, 0o400)
    const result = await writeWorkspaceExportV2(
      join(root, "read-only-manifest")
    )
    const restored = join(root, "read-only-manifest-restored")

    await importWorkspaceExportV2(result.destination, restored)

    expect(
      (await stat(join(restored, "worktable.workspace.json"))).mode & 0o777
    ).toBe(0o600)
  })

  it("truncates archive roots on Unicode code-point boundaries", async () => {
    const manifestPath = join(source, "worktable.workspace.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name: string
    }
    manifest.name = `${"😀".repeat(60)}tail`
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = await writeWorkspaceExportV2(join(root, "unicode"))
    expect(result.manifest.archive.root).toContain("😀")
    expect(result.manifest.archive.root).not.toContain("\uFFFD")
    expect(Buffer.byteLength(result.manifest.archive.root)).toBeLessThanOrEqual(
      255
    )
    await expect(
      inspectWorkspaceExportV2(result.destination)
    ).resolves.toBeDefined()
  })

  it("orders portable checkpoint paths by UTF-8 bytes instead of host locale", async () => {
    const docs = join(source, "spaces", "notes", "docs")
    await writeFile(join(docs, "z-last-in-many-locales.md"), "# Z\n")
    await writeFile(join(docs, "ä-first-in-many-locales.md"), "# Umlaut\n")

    const result = await writeWorkspaceExportV2(join(root, "stable-order"))
    const paths = result.manifest.integrity.files.map((file) => file.path)
    const ascii = paths.indexOf("spaces/notes/docs/z-last-in-many-locales.md")
    const umlaut = paths.indexOf("spaces/notes/docs/ä-first-in-many-locales.md")

    expect(ascii).toBeGreaterThanOrEqual(0)
    expect(umlaut).toBeGreaterThan(ascii)
    await expect(
      inspectWorkspaceExportV2(result.destination)
    ).resolves.toBeDefined()
  })

  it("rejects generated ZIP paths beyond the importer path limit", async () => {
    const segments = Array.from({ length: 5 }, () => "a".repeat(195))
    const directory = join(source, ...segments)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "doc.md"), "# Deep\n")
    const relative = [...segments, "doc.md"].join("/")
    expect(validateWorkspaceExportV2Path(relative)).toBe(relative)

    await expect(
      writeWorkspaceExportV2(join(root, "overlong-generated-path"))
    ).rejects.toThrow(/invalid path/)
    await expect(
      stat(join(root, "overlong-generated-path.wtb"))
    ).rejects.toThrow()
  })

  it("rejects nested app storage before creating it in the workspace", async () => {
    const nestedAppDir = join(source, "machine-local", "app")
    setAppDirOverride(nestedAppDir)

    await expect(
      writeWorkspaceExportV2(join(root, "nested-app-dir"))
    ).rejects.toThrow(/app storage must be outside/)
    await expect(stat(join(source, "machine-local"))).rejects.toThrow()
  })

  it("keeps filesystem timestamps out of portable content identity", async () => {
    const first = await writeWorkspaceExportV2(join(root, "first-mtime"))
    const file = join(source, "spaces", "notes", "docs", "welcome.md")
    const changed = new Date(Date.now() + 60_000)
    await utimes(file, changed, changed)
    const second = await writeWorkspaceExportV2(join(root, "second-mtime"))

    expect(second.manifest.integrity.contentCheckpoint).toBe(
      first.manifest.integrity.contentCheckpoint
    )
    expect(second.manifest.integrity.sourceCheckpoint).toBe(
      first.manifest.integrity.sourceCheckpoint
    )
    expect(
      second.manifest.integrity.files.find(
        (entry) => entry.path === "spaces/notes/docs/welcome.md"
      )?.mtime
    ).not.toBe(
      first.manifest.integrity.files.find(
        (entry) => entry.path === "spaces/notes/docs/welcome.md"
      )?.mtime
    )
  })

  it("rejects unsupported history modes from an untrusted package", async () => {
    const valid = await writeWorkspaceExportV2(join(root, "valid-history"))
    const malformed = structuredClone(valid.manifest) as unknown as {
      archive: { root: string }
      history: { requested: { mode: string } }
    }
    malformed.history.requested.mode = "future-policy"
    const archive = join(root, "unsupported-history.wtb")
    const zip = new yazl.ZipFile()
    const writing = pipeline(zip.outputStream, createWriteStream(archive))
    zip.addBuffer(
      Buffer.from(`${JSON.stringify(malformed)}\n`),
      `${malformed.archive.root}/worktable-export.json`
    )
    zip.end()
    await writing

    await expect(inspectWorkspaceExportV2(archive)).rejects.toThrow(
      /unsupported history mode/
    )
  })

  it("rejects owner-inaccessible modes from an untrusted package", async () => {
    const valid = await writeWorkspaceExportV2(join(root, "valid-modes"))
    const cases = [
      {
        label: "directory",
        mutate(manifest: typeof valid.manifest) {
          manifest.integrity.directories.find(
            (directory) => directory.path === "spaces/notes/docs"
          )!.mode = 0
        },
      },
      {
        label: "file",
        mutate(manifest: typeof valid.manifest) {
          manifest.integrity.files.find(
            (file) => file.path === "spaces/notes/docs/welcome.md"
          )!.mode = 0
        },
      },
    ]

    for (const testCase of cases) {
      const malformed = structuredClone(valid.manifest)
      testCase.mutate(malformed)
      const archive = join(root, `inaccessible-${testCase.label}.wtb`)
      const zip = new yazl.ZipFile()
      const writing = pipeline(zip.outputStream, createWriteStream(archive))
      zip.addBuffer(
        Buffer.from(`${JSON.stringify(malformed)}\n`),
        `${malformed.archive.root}/worktable-export.json`
      )
      zip.end()
      await writing

      await expect(inspectWorkspaceExportV2(archive)).rejects.toThrow(
        new RegExp(`invalid workspace package ${testCase.label}`)
      )
    }
  })

  it("rejects case-colliding source paths before writing an artifact", async () => {
    await mkdir(join(source, "spaces", "Notes", "docs"), { recursive: true })
    await writeFile(
      join(source, "spaces", "Notes", "docs", "other.md"),
      "# Collision\n"
    )

    await expect(
      writeWorkspaceExportV2(join(root, "case-collision"))
    ).rejects.toThrow(/case-colliding/)
  })

  it("rejects paths that cannot round-trip onto Windows filesystems", () => {
    for (const path of [
      "spaces/CON.md",
      "spaces/COM¹.txt",
      "spaces/LPT²",
      "spaces/notes/a:b.md",
      "spaces/notes/trailing.",
      "spaces/notes/trailing ",
      "spaces/notes/question?.md",
    ]) {
      expect(() => validateWorkspaceExportV2Path(path)).toThrow(/unsafe path/)
    }
  })

  it("bounds the portable workspace manifest independently of other files", async () => {
    const valid = await writeWorkspaceExportV2(join(root, "valid-manifest"))
    const malformed = structuredClone(valid.manifest)
    const workspaceManifest = malformed.integrity.files.find(
      (file) => file.path === "worktable.workspace.json"
    )!
    workspaceManifest.size =
      WORKSPACE_EXPORT_V2_MAX_WORKSPACE_MANIFEST_BYTES + 1
    const archive = join(root, "oversized-workspace-manifest.wtb")
    const zip = new yazl.ZipFile()
    const writing = pipeline(zip.outputStream, createWriteStream(archive))
    zip.addBuffer(
      Buffer.from(`${JSON.stringify(malformed)}\n`),
      `${malformed.archive.root}/worktable-export.json`
    )
    zip.end()
    await writing

    await expect(inspectWorkspaceExportV2(archive)).rejects.toThrow(
      /workspace manifest exceeds/
    )
  })

  it("requires every nested manifest path to declare its parent directories", async () => {
    const valid = await writeWorkspaceExportV2(join(root, "valid"))
    const malformed = structuredClone(valid.manifest)
    malformed.integrity.directories = malformed.integrity.directories.filter(
      (directory) => directory.path !== "spaces/notes/docs"
    )
    const archive = join(root, "missing-parent.wtb")
    const zip = new yazl.ZipFile()
    const writing = pipeline(zip.outputStream, createWriteStream(archive))
    zip.addBuffer(
      Buffer.from(`${JSON.stringify(malformed)}\n`),
      `${malformed.archive.root}/worktable-export.json`
    )
    zip.end()
    await writing

    await expect(inspectWorkspaceExportV2(archive)).rejects.toThrow(
      /undeclared parent directory/
    )
  })

  it("rejects entries outside the declared workspace and viewer layout", async () => {
    const valid = await writeWorkspaceExportV2(join(root, "valid-layout"))
    const archive = join(root, "extra-entry.wtb")
    const zip = new yazl.ZipFile()
    const writing = pipeline(zip.outputStream, createWriteStream(archive))
    zip.addBuffer(
      Buffer.from(`${JSON.stringify(valid.manifest)}\n`),
      `${valid.manifest.archive.root}/worktable-export.json`
    )
    zip.addBuffer(
      Buffer.from("not part of the format"),
      `${valid.manifest.archive.root}/unexpected.bin`
    )
    zip.end()
    await writing

    await expect(inspectWorkspaceExportV2(archive)).rejects.toThrow(
      /undeclared archive entry/
    )
  })

  it("rejects offline viewer HTML that was altered after export", async () => {
    const valid = await writeWorkspaceExportV2(join(root, "valid-viewer"))
    const listing = spawnSync("unzip", ["-Z1", valid.destination], {
      encoding: "utf8",
    })
    const item = listing.stdout
      .split("\n")
      .find((path) => /\/browse\/content\/item-\d+\.html$/u.test(path))
    expect(item).toBeDefined()

    for (const [label, path] of [
      ["index", `${valid.manifest.archive.root}/Open Worktable Export.html`],
      ["item", item!],
    ] as const) {
      const archive = join(root, `altered-viewer-${label}.wtb`)
      await replaceArchiveEntry(
        valid.destination,
        archive,
        path,
        Buffer.from("<script>location='https://example.test'</script>")
      )
      await expect(inspectWorkspaceExportV2(archive)).rejects.toThrow(
        /offline viewer file is invalid/
      )
    }
  })

  it("rejects traversal paths from an untrusted ZIP before extraction", async () => {
    const ordinary = join(root, "ordinary.zip")
    const zip = new yazl.ZipFile()
    const writing = pipeline(zip.outputStream, createWriteStream(ordinary))
    zip.addBuffer(
      Buffer.from("must not escape"),
      "Root/workspace/aa/escape.txt"
    )
    zip.end()
    await writing

    const bytes = await readFile(ordinary)
    const safeName = Buffer.from("Root/workspace/aa/escape.txt")
    const unsafeName = Buffer.from("Root/workspace/../escape.txt")
    let replacements = 0
    for (
      let offset = bytes.indexOf(safeName);
      offset >= 0;
      offset = bytes.indexOf(safeName, offset + unsafeName.byteLength)
    ) {
      unsafeName.copy(bytes, offset)
      replacements += 1
    }
    expect(replacements).toBeGreaterThanOrEqual(2)
    const malicious = join(root, "malicious.wtb")
    await writeFile(malicious, bytes)

    await expect(inspectWorkspaceExportV2(malicious)).rejects.toThrow(
      /(?:unsafe|relative) path/
    )
  })
})
