import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  readDocumentAnnotationsV2,
  readDocumentPortableStateV2,
} from "./document-data-v2.ts"
import {
  migrateDocumentStorageV2,
  planDocumentStorageV2Migration,
  rehearseDocumentStorageV2Migration,
} from "./document-storage-migration-v2.ts"
import { preflightDocumentWorkspace } from "./document-preflight.ts"
import { setWorkspaceReplacementRenameHookForTests } from "./workspace-replacement.ts"
import { recoverInterruptedWorkspaceReplacements } from "./workspace-replacement-recovery.ts"
import { readWorkspaceStorageLayoutAt } from "./workspace-storage-v2.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import {
  readWidget,
  readWidgetHtml,
  setWidgetArchived,
} from "./widget-store.ts"
import { readWidgetState, writeWidgetState } from "./record-store.ts"
import { getWidgetVersion, listWidgetVersions } from "./widget-version-store.ts"
import {
  HTML_DOCUMENT_LEGACY_COMPANION_PREFIX,
  HTML_DOCUMENT_RUNTIME_STATE_ENTRY,
} from "./html-document-storage-v2.ts"
import { readDocumentPage } from "./document-page-service.ts"
import { createHtmlDocument } from "./html-document-create.ts"
import { moveHtmlDocument } from "./html-document-move.ts"
import { deleteHtmlDocument } from "./html-document-delete.ts"
import { listAnnotations } from "./annotation-store.ts"
import { retireDocAlias } from "./doc-aliases.ts"

const workspaceId = "ws_document_storage_v2_test"
const stableDocumentId = "doc_AAAAAAAAAAAAAAAAAAAAAA"
const legacyHtmlVersionId = "2026-08-29T00-00-00-000Z-000000-legacy01"
let root: string
let source: string

function annotationFile(): string {
  const updatedAt = "2026-08-30T00:00:00.000Z"
  const base = {
    type: "worktable.annotations",
    version: 1,
    spaceId: "notes",
    updatedAt,
    annotations: [
      {
        id: "annotation-1",
        spaceId: "notes",
        target: { type: "doc", docPath: "kept" },
        category: "comment",
        status: "open",
        body: "Keep this annotation",
        author: { type: "user", id: "owner" },
        labels: [],
        thread: [],
        createdAt: updatedAt,
        updatedAt,
        metadata: {},
      },
    ],
  }
  const revision = createHash("sha256")
    .update(JSON.stringify(base))
    .digest("hex")
  return `${JSON.stringify({ ...base, revision }, null, 2)}\n`
}

function htmlAnnotationFile(): string {
  const updatedAt = "2026-08-30T00:00:00.000Z"
  const base = {
    type: "worktable.annotations",
    version: 1,
    spaceId: "notes",
    updatedAt,
    annotations: [
      {
        id: "annotation-html-1",
        spaceId: "notes",
        target: { type: "widget", widgetId: "dashboard" },
        category: "instruction",
        status: "open",
        body: "Keep the HTML annotation",
        author: { type: "user", id: "owner" },
        labels: [],
        thread: [],
        createdAt: updatedAt,
        updatedAt,
        metadata: {},
      },
    ],
  }
  const revision = createHash("sha256")
    .update(JSON.stringify(base))
    .digest("hex")
  return `${JSON.stringify({ ...base, revision }, null, 2)}\n`
}

async function seedWorkspace(workspace: string): Promise<void> {
  const now = "2026-08-30T00:00:00.000Z"
  const legacyHtml =
    "<!doctype html><title>Dashboard</title><main>Previous metrics</main>\n"
  const legacyWidget = {
    name: "Team Dashboard",
    description: "Current operating metrics",
    permissions: {
      network: true,
      records: { metrics: { read: true } },
      state: { read: true, write: true },
    },
    metadata: { owner: "operations" },
    runtime: { type: "html", entry: "index.html" },
  }
  const legacyContentHash = createHash("sha256")
    .update(JSON.stringify({ html: legacyHtml, widget: legacyWidget }))
    .digest("hex")
  await mkdir(join(workspace, "spaces", "notes", "docs", "empty"), {
    recursive: true,
  })
  await mkdir(join(workspace, "spaces", "notes", "annotations", "docs"), {
    recursive: true,
  })
  await mkdir(join(workspace, "spaces", "notes", "annotations", "widgets"), {
    recursive: true,
  })
  await mkdir(join(workspace, "spaces", "notes", "docs", "Team Board"), {
    recursive: true,
  })
  await mkdir(join(workspace, "versions", "notes", "docs", "kept"), {
    recursive: true,
  })
  await mkdir(join(workspace, "versions", "notes", "widgets", "dashboard"), {
    recursive: true,
  })
  await mkdir(join(workspace, "spaces", "notes", "widgets", "dashboard"), {
    recursive: true,
  })
  await writeFile(
    join(workspace, "worktable.workspace.json"),
    `${JSON.stringify(
      {
        type: "worktable.workspace",
        version: 1,
        id: workspaceId,
        name: "Storage V2 test",
        createdAt: now,
        cloud: { status: "unlinked" },
      },
      null,
      2
    )}\n`
  )
  await writeFile(
    join(workspace, "spaces", "notes", "space.json"),
    `${JSON.stringify({
      type: "worktable.space",
      version: 1,
      id: "notes",
      name: "Notes",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: {},
    })}\n`
  )
  await writeFile(
    join(workspace, "spaces", "notes", "docs", "kept.md"),
    "# Kept\n\nStable source bytes.\n"
  )
  await writeFile(
    join(workspace, "spaces", "notes", "docs", "materialize.md"),
    "# Materialize\n\nAssign this source a durable ID.\n"
  )
  await writeFile(
    join(workspace, "spaces", "notes", "docs", "Team Board", "state.html"),
    "<!doctype html><title>Direct</title><p>Added on disk</p>\n"
  )
  await writeFile(
    join(workspace, "spaces", "notes", "widgets", "dashboard", "index.html"),
    "<!doctype html><title>Dashboard</title><main>Current metrics</main>\n"
  )
  await writeFile(
    join(workspace, "spaces", "notes", "widgets", "dashboard", "widget.yaml"),
    `version: 1
kind: worktable.widget
id: dashboard
name: Team Dashboard
description: Current operating metrics
createdAt: ${now}
updatedAt: ${now}
createdBy: owner
updatedBy: owner
metadata:
  owner: operations
runtime:
  type: html
  entry: index.html
permissions:
  network: true
  records:
    metrics:
      read: true
  state:
    read: true
    write: true
`
  )
  await writeFile(
    join(workspace, "spaces", "notes", "widgets", "dashboard", "state.yaml"),
    "period: quarter\nexpanded: true\n"
  )
  await writeFile(
    join(workspace, "spaces", "notes", "widgets", "dashboard", "source.txt"),
    "preserve this companion exactly\n"
  )
  await writeFile(
    join(workspace, "spaces", "notes", "widgets.meta.json"),
    `${JSON.stringify(
      {
        version: 1,
        widgets: {
          dashboard: {
            provenance: {
              updatedAt: "2026-08-29T00:00:00.000Z",
              updatedBy: "owner",
              source: "app",
              versionId: legacyHtmlVersionId,
              contentHash: legacyContentHash,
            },
          },
        },
      },
      null,
      2
    )}\n`
  )
  await writeFile(
    join(
      workspace,
      "versions",
      "notes",
      "widgets",
      "dashboard",
      `${legacyHtmlVersionId}.json`
    ),
    `${JSON.stringify(
      {
        type: "worktable.widget-version",
        version: 1,
        id: legacyHtmlVersionId,
        spaceId: "notes",
        widgetId: "dashboard",
        operation: "update",
        createdAt: "2026-08-29T00:00:00.000Z",
        createdBy: "owner",
        source: "app",
        before: null,
        after: {
          format: "html",
          storedAs: "html",
          contentHash: legacyContentHash,
          content: { html: legacyHtml, widget: legacyWidget },
        },
      },
      null,
      2
    )}\n`
  )
  await writeFile(
    join(workspace, "spaces", "notes", "documents.meta.json"),
    `${JSON.stringify(
      {
        type: "worktable.document-inventory",
        version: 1,
        documents: {
          [stableDocumentId]: {
            path: "kept",
            format: { id: "worktable.markdown", sourceVersion: 1 },
            source: { kind: "file", relativePath: "docs/kept.md" },
          },
        },
      },
      null,
      2
    )}\n`
  )
  await writeFile(
    join(
      workspace,
      "spaces",
      "notes",
      "annotations",
      "docs",
      "kept.annotations.json"
    ),
    annotationFile()
  )
  await writeFile(
    join(
      workspace,
      "spaces",
      "notes",
      "annotations",
      "widgets",
      "dashboard.annotations.json"
    ),
    htmlAnnotationFile()
  )
  await writeFile(
    join(workspace, "versions", "notes", "docs", "kept", "sentinel.json"),
    '{"history":"preserved"}\n'
  )
  await mkdir(join(workspace, "versions", "notes", "docs", "orphan "), {
    recursive: true,
  })
  await writeFile(
    join(workspace, "versions", "notes", "docs", "orphan ", "sentinel.json"),
    '{"legacy":"preserved exactly"}\n'
  )
  await writeFile(
    join(workspace, "spaces", "notes", "order.yaml"),
    "docs:\n  - kept\n  - materialize\n"
  )
}

async function freshCopy(name: string): Promise<string> {
  const copy = join(root, name)
  await cp(source, copy, { recursive: true, preserveTimestamps: true })
  return copy
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-storage-v2-migration-"))
  source = join(root, "source")
  await seedWorkspace(source)
  setAppDirOverride(join(root, "app"))
})

afterEach(async () => {
  setWorkspaceReplacementRenameHookForTests(null)
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("document storage V2 migration", () => {
  it("refuses to strand annotations without a document owner", async () => {
    const copiedWorkspace = await freshCopy("orphan-annotation-copy")
    await writeFile(
      join(
        copiedWorkspace,
        "spaces",
        "notes",
        "annotations",
        "docs",
        "missing.annotations.json"
      ),
      annotationFile()
    )
    await mkdir(join(copiedWorkspace, "spaces", "Team Notes"), {
      recursive: true,
    })
    await writeFile(
      join(copiedWorkspace, "spaces", "Team Notes", "space.json"),
      `${JSON.stringify({
        type: "worktable.space",
        version: 1,
        id: "Team Notes",
        name: "Team Notes",
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
        createdBy: "test",
        settings: {},
      })}\n`
    )

    const plan = await planDocumentStorageV2Migration(copiedWorkspace)

    expect(plan.clean).toBe(false)
    expect(plan.diagnostics).toContainEqual({
      path: "spaces/notes/annotations/docs/missing.annotations.json",
      message: "legacy annotation has no inventoried document owner",
    })
    expect(plan.diagnostics).toContainEqual({
      path: "spaces/Team Notes",
      message: "legacy Space ID cannot be represented by Storage V2",
    })
  })

  it("atomically migrates a verified copy and retains an exact V1 rollback tree", async () => {
    // A current reviewed V1 snapshot must retain its identity and checkpoint.
    const historyRoot = join(source, "versions", "notes", "widgets", "dashboard")
    const previous = JSON.parse(await readFile(join(historyRoot, `${legacyHtmlVersionId}.json`), "utf8"))
    const reviewedId = "2026-08-30T00-00-00-000Z-000000-reviewed"
    const currentHtml = await readFile(join(source, "spaces", "notes", "widgets", "dashboard", "index.html"), "utf8")
    const reviewed = { ...previous, id: reviewedId, createdAt: "2026-08-30T00:00:00.000Z", operation: "checkpoint", checkpoint: { meaningful: true, kind: "review", label: "Approved metrics", sourceCategory: "human" }, after: { ...previous.after, content: { ...previous.after.content, html: currentHtml } } }
    reviewed.after.contentHash = createHash("sha256").update(JSON.stringify(reviewed.after.content)).digest("hex")
    await writeFile(join(historyRoot, `${reviewedId}.json`), JSON.stringify(reviewed))
    const metaPath = join(source, "spaces", "notes", "widgets.meta.json")
    const meta = JSON.parse(await readFile(metaPath, "utf8"))
    Object.assign(meta.widgets.dashboard.provenance, { versionId: reviewedId, updatedAt: reviewed.createdAt, contentHash: reviewed.after.contentHash })
    await writeFile(metaPath, JSON.stringify(meta))
    const copiedWorkspace = await freshCopy("copy")
    setWorkspaceRootOverride(copiedWorkspace)
    const [sourcePlan, copyPlan] = await Promise.all([
      planDocumentStorageV2Migration(source),
      planDocumentStorageV2Migration(copiedWorkspace),
    ])

    const result = await rehearseDocumentStorageV2Migration({
      offlineConfirmed: true,
      sourceWorkspace: source,
      copiedWorkspace,
      expectedWorkspaceId: workspaceId,
      expectedSourceWorkspaceContentCheckpoint:
        sourcePlan.workspaceContentCheckpoint,
      expectedCopyWorkspaceContentCheckpoint:
        copyPlan.workspaceContentCheckpoint,
    })

    expect(await readWorkspaceStorageLayoutAt(source)).toMatchObject({
      kind: "v1",
    })
    expect(await readWorkspaceStorageLayoutAt(copiedWorkspace)).toMatchObject({
      kind: "v2",
    })
    expect(await readWorkspaceStorageLayoutAt(result.backupPath)).toMatchObject(
      { kind: "v1" }
    )
    expect(result.materializedCount).toBe(3)
    expect(result.htmlDocumentsMigrated).toBe(1)
    expect(result.annotationFilesMigrated).toBe(2)
    expect(result.annotationsMigrated).toBe(2)
    expect(result.backupWorkspaceContentCheckpoint).toBe(
      copyPlan.workspaceContentCheckpoint
    )
    expect(result.sourceAfterWorkspaceContentCheckpoint).toBe(
      sourcePlan.workspaceContentCheckpoint
    )
    expect(result.rollbackProcedure).toHaveLength(4)
    expect(recoverInterruptedWorkspaceReplacements({ details: true })).toEqual([
      {
        id: expect.stringMatching(/^wsm_/),
        kind: "document-storage-v2",
        state: "complete",
        backupPath: result.backupPath,
        resetRequired: false,
      },
    ])

    const migrated = await preflightDocumentWorkspace(copiedWorkspace)
    expect(migrated.clean).toBe(true)
    expect(migrated.documents).toHaveLength(4)
    expect(
      migrated.documents.every((document) => document.identity === "durable")
    ).toBe(true)
    expect(
      migrated.documents.find((document) => document.path === "kept")
        ?.documentId
    ).toBe(stableDocumentId)
    expect(
      await readFile(
        join(copiedWorkspace, "spaces", "notes", "docs", "kept.md"),
        "utf8"
      )
    ).toBe("# Kept\n\nStable source bytes.\n")
    const migratedHtml = migrated.documents.find(
      (document) => document.path === "dashboard"
    )
    expect(migratedHtml).toMatchObject({
      identity: "durable",
      format: { id: "worktable.html", sourceVersion: 1 },
      source: { kind: "file", relativePath: "docs/dashboard.html" },
    })
    expect(
      await readFile(
        join(copiedWorkspace, "spaces", "notes", "docs", "dashboard.html"),
        "utf8"
      )
    ).toBe(
      "<!doctype html><title>Dashboard</title><main>Current metrics</main>\n"
    )
    await expect(
      stat(join(copiedWorkspace, "spaces", "notes", "widgets", "dashboard"))
    ).rejects.toThrow()
    expect(await readWidget("notes", "dashboard")).toMatchObject({
      data: {
        id: "dashboard",
        name: "Team Dashboard",
        permissions: {
          network: true,
          records: { metrics: { read: true } },
        },
      },
      error: null,
    })
    expect(await readWidget("notes", "Team Board/state")).toMatchObject({
      data: {
        id: "Team Board/state",
        name: "State",
        permissions: {
          network: false,
          records: {},
        },
      },
      error: null,
    })
    expect(
      await readDocumentPage({
        spaceId: "notes",
        path: "Team Board/state",
        includeArchived: true,
        rawSourceAuthorized: true,
        annotationsAuthorized: true,
        sharingAuthorized: false,
      })
    ).toMatchObject({
      kind: "document",
      document: {
        path: "Team Board/state",
        format: { id: "worktable.html", sourceVersion: 1 },
      },
      renderer: { key: "html", disposition: "opaque-sandbox" },
    })
    expect(
      await listAnnotations("notes", {
        target: { widgetId: "dashboard" },
        includeResolved: true,
      })
    ).toMatchObject({
      total: 1,
      annotations: [
        {
          id: "annotation-html-1",
          target: { type: "widget", widgetId: "dashboard" },
          body: "Keep the HTML annotation",
        },
      ],
    })
    const created = await createHtmlDocument({
      spaceId: "notes",
      explicitId: "generated/status",
      name: "Generated Status",
      html: "<!doctype html><title>Status</title><p>Generated</p>",
      permissions: {
        network: false,
        records: { metrics: { read: true } },
        state: { read: true, write: true },
      },
      versionSource: "test",
      versionUpdatedBy: "owner",
    })
    expect(created.error).toBeUndefined()
    expect(
      await readFile(
        join(
          copiedWorkspace,
          "spaces",
          "notes",
          "docs",
          "generated",
          "status.html"
        ),
        "utf8"
      )
    ).toBe("<!doctype html><title>Status</title><p>Generated</p>")
    await writeWidgetState("notes", "generated/status", { selected: "all" })
    expect(await readWidgetState("notes", "generated/status")).toEqual({
      selected: "all",
    })
    expect(
      await moveHtmlDocument("notes", "generated/status", "generated/moved")
    ).toMatchObject({
      ok: true,
      from: "generated/status",
      to: "generated/moved",
    })
    expect(await readWidgetState("notes", "generated/moved")).toEqual({
      selected: "all",
    })
    expect(
      await setWidgetArchived("notes", "generated/moved", true, "owner")
    ).toMatchObject({ data: { archive: { archivedBy: "owner" } }, error: null })
    expect(
      await setWidgetArchived("notes", "generated/moved", false, "owner")
    ).toMatchObject({ data: { archive: null }, error: null })
    expect(await deleteHtmlDocument("notes", "generated/moved")).toMatchObject({
      ok: true,
    })
    expect(await readWidget("notes", "generated/moved")).toMatchObject({
      data: null,
    })
    expect(await readWidgetHtml("notes", "dashboard")).toEqual({
      data: "<!doctype html><title>Dashboard</title><main>Current metrics</main>\n",
      error: null,
    })
    expect(await readWidgetState("notes", "dashboard")).toEqual({
      period: "quarter",
      expanded: true,
    })
    expect(
      await moveHtmlDocument("notes", "dashboard", "reports/dashboard")
    ).toMatchObject({ ok: true, to: "reports/dashboard" })
    expect(
      (
        await listWidgetVersions("notes", "reports/dashboard", {
          checkpointsOnly: false,
        })
      ).map((version) => version.id)
    ).toContain(legacyHtmlVersionId)
    expect(await readWidgetState("notes", "reports/dashboard")).toEqual({
      period: "quarter",
      expanded: true,
    })
    expect(await retireDocAlias("notes", "dashboard", "exact")).toBe(true)
    expect(
      await moveHtmlDocument("notes", "reports/dashboard", "dashboard")
    ).toMatchObject({ ok: true, to: "dashboard" })
    const portableState = await readDocumentPortableStateV2({
      workspaceRoot: copiedWorkspace,
      spaceId: "notes",
      documentId: migratedHtml!.documentId,
    })
    expect(portableState?.entries.map((entry) => entry.path)).toContain(
      HTML_DOCUMENT_RUNTIME_STATE_ENTRY
    )
    expect(
      portableState?.entries.find(
        (entry) =>
          entry.path === `${HTML_DOCUMENT_LEGACY_COMPANION_PREFIX}source.txt`
      )?.bytes
    ).toEqual(new TextEncoder().encode("preserve this companion exactly\n"))
    const htmlVersions = await listWidgetVersions("notes", "dashboard", {
      checkpointsOnly: false,
    })
    expect(htmlVersions).toHaveLength(3)
    expect(htmlVersions.find(version => version.id === reviewedId)).toMatchObject({ operation: "checkpoint", checkpoint: { kind: "review", label: "Approved metrics" } })
    expect(
      (
        await getWidgetVersion(
          "notes",
          "dashboard",
          legacyHtmlVersionId
        )
      )?.after.content
    ).toMatchObject({
      html: expect.stringContaining("Previous metrics"),
    })
    const htmlVersion = await getWidgetVersion(
      "notes",
      "dashboard",
      htmlVersions.find((version) => version.id !== legacyHtmlVersionId)!.id
    )
    expect(htmlVersion?.after.content).toMatchObject({
      html: "<!doctype html><title>Dashboard</title><main>Current metrics</main>\n",
      widget: {
        name: "Team Dashboard",
        permissions: { network: true },
      },
    })
    await expect(
      readFile(
        join(
          copiedWorkspace,
          "spaces",
          "notes",
          "annotations",
          "docs",
          "kept.annotations.json"
        ),
        "utf8"
      )
    ).rejects.toThrow()
    expect(
      await readDocumentAnnotationsV2({
        workspaceRoot: copiedWorkspace,
        spaceId: "notes",
        documentId: stableDocumentId,
      })
    ).toMatchObject({
      documentId: stableDocumentId,
      logicalPath: "kept",
      annotations: [
        {
          id: "annotation-1",
          target: {
            type: "document",
            documentId: stableDocumentId,
            path: "kept",
          },
        },
      ],
    })
    expect(
      await readFile(
        join(
          result.backupPath,
          "spaces",
          "notes",
          "annotations",
          "docs",
          "kept.annotations.json"
        ),
        "utf8"
      )
    ).toBe(annotationFile())
    expect(
      await readFile(
        join(
          copiedWorkspace,
          "versions",
          "notes",
          "docs",
          "kept",
          "sentinel.json"
        ),
        "utf8"
      )
    ).toBe('{"history":"preserved"}\n')
    expect(
      await readFile(
        join(
          copiedWorkspace,
          "versions",
          "notes",
          "docs",
          "orphan ",
          "sentinel.json"
        ),
        "utf8"
      )
    ).toBe('{"legacy":"preserved exactly"}\n')
    expect(
      (
        await stat(join(copiedWorkspace, "spaces", "notes", "docs", "empty"))
      ).isDirectory()
    ).toBe(true)
  }, 60_000)

  it("recovers an interrupted copy before the next migration attempt", async () => {
    const copiedWorkspace = await freshCopy("failed-copy")
    setWorkspaceRootOverride(copiedWorkspace)
    const before = await planDocumentStorageV2Migration(copiedWorkspace)
    let renameAttempt = 0
    setWorkspaceReplacementRenameHookForTests(async (from, to) => {
      renameAttempt += 1
      if (renameAttempt >= 2) {
        throw new Error("injected migration process interruption")
      }
      await rename(from, to)
    })

    await expect(
      migrateDocumentStorageV2({
        workspaceRoot: copiedWorkspace,
        expectedWorkspaceId: workspaceId,
        expectedWorkspaceContentCheckpoint: before.workspaceContentCheckpoint,
      })
    ).rejects.toThrow("injected migration process interruption")

    setWorkspaceReplacementRenameHookForTests(null)
    const recovered = await migrateDocumentStorageV2({
      workspaceRoot: copiedWorkspace,
      expectedWorkspaceId: workspaceId,
      expectedWorkspaceContentCheckpoint: before.workspaceContentCheckpoint,
    })

    expect(await readWorkspaceStorageLayoutAt(copiedWorkspace)).toMatchObject({
      kind: "v2",
    })
    expect(recovered.beforeWorkspaceContentCheckpoint).toBe(
      before.workspaceContentCheckpoint
    )
    expect(
      (await planDocumentStorageV2Migration(recovered.backupPath))
        .workspaceContentCheckpoint
    ).toBe(before.workspaceContentCheckpoint)
    expect(await readWorkspaceStorageLayoutAt(source)).toMatchObject({
      kind: "v1",
    })
  }, 60_000)
})
