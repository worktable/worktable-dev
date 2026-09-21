import { randomBytes } from "node:crypto"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import {
  CanonicalIdSchema,
  DocumentIdSchema,
  type DocumentId,
} from "@worktable/types"
import { z } from "zod"
import { ensureAppDir } from "./app-storage.ts"
import { buildDocumentCatalog } from "./document-catalog.ts"
import {
  readDocumentAnnotationsV2,
  readDocumentPortableStateV2,
  writeDocumentAnnotationsV2,
  writeDocumentPortableStateV2,
} from "./document-data-v2.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import { getWorkspaceRoot, workspaceCacheKey } from "./workspace.ts"
import {
  documentDataV2Directory,
  documentRetiredVersionsV2Directory,
  documentVersionsV2Directory,
  ensureRealDocumentStorageDirectory,
  readWorkspaceStorageLayoutAt,
  requireRealDocumentStorageDirectory,
} from "./workspace-storage-v2.ts"
import { requireWorkspaceRecovery } from "./workspace-safety.ts"

const JOB_ID_PATTERN = /^dsv2_[A-Za-z0-9_-]{22}$/
const JOB_MAX_BYTES = 1024 * 1024

const MoveDocumentSchema = z
  .object({
    documentId: DocumentIdSchema,
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .strict()

const DeleteDocumentSchema = z
  .object({
    documentId: DocumentIdSchema,
    from: z.string().min(1),
  })
  .strict()

const JobSchema = z.discriminatedUnion("operation", [
  z
    .object({
      type: z.literal("worktable.document-data-lifecycle"),
      version: z.literal(1),
      id: z.string().regex(JOB_ID_PATTERN),
      state: z.enum(["prepared", "base-committed"]),
      operation: z.literal("move"),
      spaceId: CanonicalIdSchema,
      createdAt: z.iso.datetime(),
      documents: z.array(MoveDocumentSchema).min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("worktable.document-data-lifecycle"),
      version: z.literal(1),
      id: z.string().regex(JOB_ID_PATTERN),
      state: z.enum(["prepared", "base-committed"]),
      operation: z.literal("delete"),
      spaceId: CanonicalIdSchema,
      createdAt: z.iso.datetime(),
      documents: z.array(DeleteDocumentSchema).min(1).max(128),
    })
    .strict(),
])

type DocumentDataLifecycleV2Job = z.infer<typeof JobSchema>

export interface RecoveredDocumentDataLifecycleV2 {
  directory: string
  path: string
  job: DocumentDataLifecycleV2Job
}

function recoveryRoot(): string {
  return join(ensureAppDir(), "document-data-lifecycle-v2", workspaceCacheKey())
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, "r")
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const unsupported = ["EINVAL", "ENOTSUP", "ENOSYS"].includes(code ?? "")
    const unsupportedOnWindows =
      process.platform === "win32" &&
      ["EACCES", "EISDIR", "EPERM"].includes(code ?? "")
    if (!unsupported && !unsupportedOnWindows) throw error
  } finally {
    await handle?.close()
  }
}

async function ensureRecoveryRoot(): Promise<string> {
  const appRoot = ensureAppDir()
  const base = join(appRoot, "document-data-lifecycle-v2")
  const root = join(base, workspaceCacheKey())
  for (const directory of [base, root]) {
    let created = false
    try {
      await mkdir(directory, { mode: 0o700 })
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(
        "document V2 lifecycle recovery path is not a real directory"
      )
    }
    if (created) await fsyncDirectory(dirname(directory))
  }
  return root
}

async function writeDurableJobFile(path: string, text: string): Promise<void> {
  if (Buffer.byteLength(text) > JOB_MAX_BYTES) {
    throw new Error("document V2 lifecycle recovery job is too large")
  }
  const parent = dirname(path)
  const temporary = join(
    parent,
    `.pending-${basename(path)}-${randomBytes(8).toString("hex")}`
  )
  let published = false
  try {
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(text, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    published = true
    await fsyncDirectory(parent)
  } finally {
    if (!published) await rm(temporary, { force: true })
  }
}

function requirePortablePath(path: string): string {
  const analyzed = analyzeDocumentPath(path, { enforceNewPathGrammar: true })
  if (!analyzed.safe || !analyzed.portable || analyzed.canonicalPath !== path) {
    throw new Error("document data lifecycle path is not portable")
  }
  return path
}

function validatedJob(
  job: DocumentDataLifecycleV2Job
): DocumentDataLifecycleV2Job {
  for (const document of job.documents) {
    requirePortablePath(document.from)
  }
  if (job.operation === "move") {
    for (const document of job.documents) requirePortablePath(document.to)
  }
  const ids = new Set(job.documents.map((document) => document.documentId))
  if (ids.size !== job.documents.length) {
    throw new Error("document data lifecycle contains duplicate documents")
  }
  return job
}

async function writeJob(
  job: DocumentDataLifecycleV2Job
): Promise<RecoveredDocumentDataLifecycleV2> {
  const root = await ensureRecoveryRoot()
  const directory = join(root, job.id)
  let created = false
  try {
    await mkdir(directory, { mode: 0o700 })
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("document V2 lifecycle job path is not a real directory")
  }
  if (created) await fsyncDirectory(root)
  const path = join(directory, "job.json")
  await writeDurableJobFile(path, `${JSON.stringify(job, null, 2)}\n`)
  return { directory, path, job }
}

async function updateJob(
  recovery: RecoveredDocumentDataLifecycleV2,
  state: DocumentDataLifecycleV2Job["state"]
): Promise<void> {
  recovery.job = { ...recovery.job, state }
  await writeDurableJobFile(
    recovery.path,
    `${JSON.stringify(recovery.job, null, 2)}\n`
  )
}

async function finishJob(
  recovery: RecoveredDocumentDataLifecycleV2
): Promise<void> {
  await rm(recovery.directory, { recursive: true, force: true })
  await fsyncDirectory(dirname(recovery.directory))
}

async function currentDurableDocuments(
  spaceId: string,
  paths: readonly string[]
): Promise<Array<{ documentId: DocumentId; path: string }>> {
  const requested = new Set(paths.map(requirePortablePath))
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
  })
  if (
    catalog.inventoryDiagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    )
  ) {
    throw new Error(
      "document inventory must be repaired before changing V2 document data"
    )
  }
  const documents = catalog.entries.flatMap((entry) => {
    if (
      entry.kind !== "document" ||
      entry.handle.identity !== "durable" ||
      !requested.has(entry.descriptor.path)
    ) {
      return []
    }
    return [
      {
        documentId: entry.handle.documentId,
        path: entry.descriptor.path,
      },
    ]
  })
  const byPath = new Map(documents.map((document) => [document.path, document]))
  return paths.flatMap((path) => {
    const document = byPath.get(path)
    return document ? [document] : []
  })
}

async function prepareMoveJob(
  spaceId: string,
  moves: readonly { from: string; to: string }[]
): Promise<RecoveredDocumentDataLifecycleV2 | null> {
  const layout = await readWorkspaceStorageLayoutAt(getWorkspaceRoot())
  if (layout.kind !== "v2") return null
  const documents = await currentDurableDocuments(
    spaceId,
    moves.map((move) => move.from)
  )
  const toByFrom = new Map(moves.map((move) => [move.from, move.to]))
  const planned = documents.map((document) => ({
    documentId: document.documentId,
    from: document.path,
    to: requirePortablePath(toByFrom.get(document.path)!),
  }))
  if (planned.length === 0) return null
  const job = validatedJob(
    JobSchema.parse({
      type: "worktable.document-data-lifecycle",
      version: 1,
      id: `dsv2_${randomBytes(16).toString("base64url")}`,
      state: "prepared",
      operation: "move",
      spaceId,
      createdAt: new Date().toISOString(),
      documents: planned,
    })
  )
  return writeJob(job)
}

async function prepareDeleteJob(
  spaceId: string,
  paths: readonly string[]
): Promise<RecoveredDocumentDataLifecycleV2 | null> {
  const layout = await readWorkspaceStorageLayoutAt(getWorkspaceRoot())
  if (layout.kind !== "v2") return null
  const documents = await currentDurableDocuments(spaceId, paths)
  if (documents.length === 0) return null
  const job = validatedJob(
    JobSchema.parse({
      type: "worktable.document-data-lifecycle",
      version: 1,
      id: `dsv2_${randomBytes(16).toString("base64url")}`,
      state: "prepared",
      operation: "delete",
      spaceId,
      createdAt: new Date().toISOString(),
      documents: documents.map((document) => ({
        documentId: document.documentId,
        from: document.path,
      })),
    })
  )
  return writeJob(job)
}

async function applyMoveDocument(
  spaceId: string,
  document: z.infer<typeof MoveDocumentSchema>
): Promise<void> {
  const workspaceRoot = getWorkspaceRoot()
  const annotations = await readDocumentAnnotationsV2({
    workspaceRoot,
    spaceId,
    documentId: document.documentId,
  })
  if (annotations && annotations.logicalPath !== document.to) {
    if (annotations.logicalPath !== document.from) {
      throw new Error("document annotations disagree with lifecycle paths")
    }
    await writeDocumentAnnotationsV2({
      workspaceRoot,
      spaceId,
      documentId: document.documentId,
      logicalPath: document.to,
      annotations: annotations.annotations.map((annotation) => ({
        ...annotation,
        target: { ...annotation.target, path: document.to },
      })),
      expectedRevision: annotations.revision,
      updatedAt: annotations.updatedAt,
    })
  }

  const state = await readDocumentPortableStateV2({
    workspaceRoot,
    spaceId,
    documentId: document.documentId,
  })
  if (state && state.manifest.logicalPath !== document.to) {
    if (state.manifest.logicalPath !== document.from) {
      throw new Error("document portable state disagrees with lifecycle paths")
    }
    await writeDocumentPortableStateV2({
      workspaceRoot,
      spaceId,
      documentId: document.documentId,
      logicalPath: document.to,
      format: state.manifest.format,
      stateVersion: state.manifest.stateVersion,
      entries: state.entries,
      expectedRevision: state.manifest.revision,
      updatedAt: state.manifest.updatedAt,
    })
  }
}

async function removeRealStorageDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return null
    throw error
  })
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("document V2 storage target is not a real directory")
  }
  await rm(path, { recursive: true, force: true })
}

async function retireRealStorageDirectory(
  workspaceRoot: string,
  source: string,
  destination: string
): Promise<void> {
  const [sourceInfo, destinationInfo] = await Promise.all(
    [source, destination].map((path) =>
      lstat(path).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR") return null
        throw error
      })
    )
  )
  if (destinationInfo) {
    if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
      throw new Error("retired document history is not a real directory")
    }
    if (sourceInfo) {
      throw new Error("active and retired document history both exist")
    }
    return
  }
  if (!sourceInfo) return
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error("active document history is not a real directory")
  }
  await requireRealDocumentStorageDirectory(workspaceRoot, dirname(source))
  await ensureRealDocumentStorageDirectory(workspaceRoot, dirname(destination))
  await rename(source, destination)
}

async function applyJob(job: DocumentDataLifecycleV2Job): Promise<void> {
  const workspaceRoot = getWorkspaceRoot()
  if (job.operation === "move") {
    for (const document of job.documents) {
      await applyMoveDocument(job.spaceId, document)
    }
    return
  }
  for (const document of job.documents) {
    const data = documentDataV2Directory(
      workspaceRoot,
      job.spaceId,
      document.documentId
    )
    const versions = documentVersionsV2Directory(
      workspaceRoot,
      job.spaceId,
      document.documentId
    )
    const dataParent = dirname(data)
    const dataParentInfo = await lstat(dataParent).catch(() => null)
    if (dataParentInfo) {
      await requireRealDocumentStorageDirectory(workspaceRoot, dataParent)
    }
    await removeRealStorageDirectory(data)
    await retireRealStorageDirectory(
      workspaceRoot,
      versions,
      documentRetiredVersionsV2Directory(
        workspaceRoot,
        job.spaceId,
        document.documentId,
        job.id
      )
    )
  }
}

async function runWithJob<T>(
  recovery: RecoveredDocumentDataLifecycleV2 | null,
  operation: () => Promise<T>,
  committed: (result: T) => boolean
): Promise<T> {
  let result: T
  try {
    result = await operation()
  } catch (error) {
    if (recovery) {
      requireWorkspaceRecovery(
        "document V2 data is waiting for lifecycle recovery"
      )
    }
    throw error
  }
  if (!recovery) return result
  if (!committed(result)) {
    await finishJob(recovery)
    return result
  }
  try {
    await updateJob(recovery, "base-committed")
    await applyJob(recovery.job)
    await finishJob(recovery)
    return result
  } catch (error) {
    requireWorkspaceRecovery(
      "document V2 data is waiting for lifecycle recovery"
    )
    throw error
  }
}

export async function withDocumentDataV2ExactMove<
  T extends {
    handled: boolean
    documentId?: DocumentId
    error?: string
  },
>(
  spaceId: string,
  from: string,
  to: string,
  operation: () => Promise<T>
): Promise<T> {
  const recovery = await prepareMoveJob(spaceId, [{ from, to }])
  return runWithJob(
    recovery,
    operation,
    (result) => result.handled && !result.error && Boolean(result.documentId)
  )
}

export async function withDocumentDataV2PrefixMove<
  T extends {
    handled: boolean
    renamed?: readonly unknown[]
    error?: string
  },
>(
  spaceId: string,
  moves: readonly { from: string; to: string }[],
  operation: () => Promise<T>
): Promise<T> {
  const recovery = await prepareMoveJob(spaceId, moves)
  return runWithJob(
    recovery,
    operation,
    (result) => result.handled && !result.error && Boolean(result.renamed)
  )
}

export async function withDocumentDataV2ExactDelete<
  T extends {
    handled: boolean
    documentId?: DocumentId
    error?: string
  },
>(spaceId: string, path: string, operation: () => Promise<T>): Promise<T> {
  const recovery = await prepareDeleteJob(spaceId, [path])
  return runWithJob(
    recovery,
    operation,
    (result) => result.handled && !result.error && Boolean(result.documentId)
  )
}

export async function withDocumentDataV2PrefixDelete<
  T extends {
    handled: boolean
    deleted?: readonly unknown[]
    error?: string
  },
>(
  spaceId: string,
  paths: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  const recovery = await prepareDeleteJob(spaceId, paths)
  return runWithJob(
    recovery,
    operation,
    (result) => result.handled && !result.error && Boolean(result.deleted)
  )
}

/** Discover validated jobs synchronously before the server admits requests. */
export function discoverDocumentDataV2LifecycleRecovery(): RecoveredDocumentDataLifecycleV2[] {
  const root = recoveryRoot()
  if (!existsSync(root)) return []
  const recovered: RecoveredDocumentDataLifecycleV2[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue
    const directory = join(root, entry.name)
    const path = join(directory, "job.json")
    const text = readFileSync(path, "utf8")
    if (Buffer.byteLength(text) > JOB_MAX_BYTES) {
      throw new Error("document V2 lifecycle recovery job is too large")
    }
    const job = validatedJob(JobSchema.parse(JSON.parse(text)))
    if (job.id !== entry.name) {
      throw new Error("document V2 lifecycle recovery identity mismatch")
    }
    recovered.push({ directory, path, job })
  }
  if (recovered.length > 1) {
    throw new Error("multiple document V2 lifecycle recoveries are pending")
  }
  return recovered
}

export async function reconcileDocumentDataV2LifecycleRecovery(
  recovered: readonly RecoveredDocumentDataLifecycleV2[]
): Promise<void> {
  for (const recovery of recovered) {
    const catalog = await buildDocumentCatalog({
      workspaceRoot: getWorkspaceRoot(),
      spaceId: recovery.job.spaceId,
    })
    const current = new Map(
      catalog.entries.flatMap((entry) =>
        entry.kind === "document" && entry.handle.identity === "durable"
          ? [[entry.handle.documentId, entry.descriptor.path] as const]
          : []
      )
    )
    if (recovery.job.operation === "move") {
      const atSource = recovery.job.documents.every(
        (document) => current.get(document.documentId) === document.from
      )
      const atDestination = recovery.job.documents.every(
        (document) => current.get(document.documentId) === document.to
      )
      if (atSource) {
        await finishJob(recovery)
        continue
      }
      if (!atDestination) {
        throw new Error("document move outcome is ambiguous during V2 recovery")
      }
      await updateJob(recovery, "base-committed")
      await applyJob(recovery.job)
      await finishJob(recovery)
      continue
    }

    const atSource = recovery.job.documents.every(
      (document) => current.get(document.documentId) === document.from
    )
    const absent = recovery.job.documents.every(
      (document) => !current.has(document.documentId)
    )
    if (atSource) {
      await finishJob(recovery)
      continue
    }
    if (!absent) {
      throw new Error(
        "document deletion outcome is ambiguous during V2 recovery"
      )
    }
    await updateJob(recovery, "base-committed")
    await applyJob(recovery.job)
    await finishJob(recovery)
  }
}
