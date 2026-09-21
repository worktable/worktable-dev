import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fc from "fast-check"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createWorkspaceExport,
  importWorkspaceExport,
  WORKSPACE_EXPORT_MAX_ENCODED_BYTES,
  WORKSPACE_EXPORT_MAX_ENTRIES,
  writeWorkspaceExport,
} from "./workspace-transfer.ts"
import {
  ensureWorkspaceManifest,
  isWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

let root: string
let source: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-transfer-"))
  source = join(root, "source")
  setWorkspaceRootOverride(source)
  ensureWorkspaceManifest()
  await mkdir(join(source, "spaces", "notes", "docs"), { recursive: true })
  await mkdir(join(source, "spaces", "empty"), { recursive: true })
  await writeFile(
    join(source, "spaces", "notes", "docs", "hello.md"),
    "# Hello\n"
  )
  await writeFile(
    join(source, "spaces", "notes", "binary.dat"),
    Buffer.from([0, 1, 2, 255])
  )
})

afterEach(async () => {
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("workspace export/import", () => {
  it("round-trips a real workspace as an independent one-way snapshot", async () => {
    const sourceManifest = ensureWorkspaceManifest()
    const bundleFile = join(root, "workspace.wtb.json")
    const bundle = await writeWorkspaceExport(bundleFile)
    const destination = join(root, "restored")
    const imported = await importWorkspaceExport(bundleFile, destination)

    expect(bundle.sourceWorkspaceId).toBe(sourceManifest.id)
    expect(imported.id).not.toBe(sourceManifest.id)
    expect(imported.provenance).toMatchObject({
      source: { workspaceId: sourceManifest.id },
      snapshotAt: bundle.exportedAt,
      oneWay: true,
    })
    expect(
      await readFile(
        join(destination, "spaces", "notes", "docs", "hello.md"),
        "utf8"
      )
    ).toBe("# Hello\n")
    expect(
      await readFile(join(destination, "spaces", "notes", "binary.dat"))
    ).toEqual(Buffer.from([0, 1, 2, 255]))
    const restoredManifest = JSON.parse(
      await readFile(join(destination, "worktable.workspace.json"), "utf8")
    )
    expect(isWorkspaceManifest(restoredManifest)).toBe(true)
    expect(restoredManifest.id).toBe(imported.id)
    expect((await stat(bundleFile)).size).toBeLessThanOrEqual(
      WORKSPACE_EXPORT_MAX_ENCODED_BYTES
    )

    const capturedManifest = JSON.parse(
      Buffer.from(
        bundle.files.find((file) => file.path === "worktable.workspace.json")!
          .data,
        "base64"
      ).toString("utf8")
    )
    expect({
      id: bundle.sourceWorkspaceId,
      name: bundle.sourceWorkspaceName,
    }).toEqual({ id: capturedManifest.id, name: capturedManifest.name })
  })

  it("refuses symlinks instead of following them", async () => {
    await symlink(
      join(source, "worktable.workspace.json"),
      join(source, "spaces", "manifest-link")
    )
    await expect(createWorkspaceExport()).rejects.toThrow(/refuses symlink/)
  })

  it("restores private permissions when force-overwriting an export", async () => {
    const bundleFile = join(root, "forced.wtb.json")
    await writeFile(bundleFile, "public placeholder")
    await chmod(bundleFile, 0o644)

    await writeWorkspaceExport(bundleFile, { force: true })

    expect((await stat(bundleFile)).mode & 0o777).toBe(0o600)
  })

  it("does not chmod a directory passed as a forced export destination", async () => {
    const destination = join(root, "export-directory")
    await mkdir(destination)
    await chmod(destination, 0o755)

    await expect(
      writeWorkspaceExport(destination, { force: true })
    ).rejects.toThrow(/regular file/)

    expect((await stat(destination)).mode & 0o777).toBe(0o755)
  })

  it("never follows a forced export symlink", async () => {
    const target = join(root, "private-target.txt")
    const destination = join(root, "forced-link.wtb.json")
    await writeFile(target, "must remain unchanged")
    await symlink(target, destination)

    await expect(
      writeWorkspaceExport(destination, { force: true })
    ).rejects.toThrow(/regular file/)

    expect(await readFile(target, "utf8")).toBe("must remain unchanged")
  })

  it("refuses to write an export inside the workspace being captured", async () => {
    const destination = join(source, "nested-snapshot.wtb.json")

    await expect(writeWorkspaceExport(destination)).rejects.toThrow(
      /outside the workspace/
    )
    await expect(readFile(destination)).rejects.toThrow()

    const sourceAlias = join(root, "source-alias")
    await symlink(source, sourceAlias, "dir")
    await expect(
      writeWorkspaceExport(join(sourceAlias, "aliased-snapshot.wtb.json"))
    ).rejects.toThrow(/outside the workspace/)
  })

  it("verifies integrity before creating the destination", async () => {
    const bundleFile = join(root, "tampered.wtb.json")
    await writeWorkspaceExport(bundleFile)
    const bundle = JSON.parse(await readFile(bundleFile, "utf8"))
    const file = bundle.files.find((entry: { path: string }) =>
      entry.path.endsWith("hello.md")
    )
    file.data = Buffer.from("tampered").toString("base64")
    await writeFile(bundleFile, JSON.stringify(bundle))
    const destination = join(root, "never-created")
    await expect(
      importWorkspaceExport(bundleFile, destination)
    ).rejects.toThrow(/integrity check failed/)
    await expect(
      readFile(join(destination, "worktable.workspace.json"))
    ).rejects.toThrow()
  })

  it("never replaces an existing workspace", async () => {
    const bundleFile = join(root, "workspace.wtb.json")
    await writeWorkspaceExport(bundleFile)
    const destination = join(root, "existing")
    setWorkspaceRootOverride(destination)
    ensureWorkspaceManifest()
    setWorkspaceRootOverride(source)
    await expect(
      importWorkspaceExport(bundleFile, destination)
    ).rejects.toThrow(/never replaced/)
  })

  it("imports into a directory containing only cosmetic OS metadata", async () => {
    const bundleFile = join(root, "workspace.wtb.json")
    await writeWorkspaceExport(bundleFile)
    const destination = join(root, "finder-created")
    await mkdir(destination)
    await writeFile(join(destination, ".DS_Store"), "finder metadata")

    const imported = await importWorkspaceExport(bundleFile, destination)

    expect(
      JSON.parse(
        await readFile(join(destination, "worktable.workspace.json"), "utf8")
      ).id
    ).toBe(imported.id)
  })

  it("rejects bundles whose entry count exceeds the v1 limit", async () => {
    const bundleFile = join(root, "too-many-entries.wtb.json")
    const bundle = await createWorkspaceExport()
    bundle.directories = Array.from(
      { length: WORKSPACE_EXPORT_MAX_ENTRIES + 1 },
      (_, index) => `spaces/entry-${index}`
    )
    await writeFile(bundleFile, JSON.stringify(bundle))
    const destination = join(root, "entry-limit-target")

    await expect(
      importWorkspaceExport(bundleFile, destination)
    ).rejects.toThrow(/entry limit/)
    await expect(
      readFile(join(destination, "worktable.workspace.json"))
    ).rejects.toThrow()
  })

  it("rejects path traversal before creating a destination (fast-check)", async () => {
    const bundleFile = join(root, "unsafe.wtb.json")
    const base = await createWorkspaceExport()
    const unsafePath = fc.oneof(
      fc.constant(".."),
      fc.constant("../escape"),
      fc.constant("/absolute"),
      fc.constant("spaces\\escape"),
      fc.string({ maxLength: 40 }).map((value) => `../${value}`),
      fc.string({ maxLength: 40 }).map((value) => `/tmp/${value}`),
      fc.string({ maxLength: 40 }).map((value) => `spaces\\${value}`)
    )
    let iteration = 0

    await fc.assert(
      fc.asyncProperty(unsafePath, async (path) => {
        await writeFile(
          bundleFile,
          JSON.stringify({ ...base, directories: [path] })
        )
        const destination = join(root, `unsafe-target-${iteration++}`)
        await expect(
          importWorkspaceExport(bundleFile, destination)
        ).rejects.toThrow(/invalid workspace path|unsafe workspace path/)
        await expect(
          readFile(join(destination, "worktable.workspace.json"))
        ).rejects.toThrow()
      }),
      { numRuns: 50 }
    )
  })
})
