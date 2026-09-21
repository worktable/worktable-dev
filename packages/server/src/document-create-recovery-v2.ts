import { createHash, randomBytes } from "node:crypto"
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  CanonicalIdSchema,
  DocumentFormatClaimSchema,
  DocumentGenerationEntrySchema,
  DocumentGenerationIdSchema,
  DocumentIdSchema,
  DocumentSourceSchema,
} from "@worktable/types"
import { z } from "zod"
import { ensureAppDir } from "./app-storage.ts"
import {
  BoundedFileReadError,
  readBoundedRegularFileBytes,
} from "./bounded-file.ts"
import {
  readDocumentInventoryAt,
  updateDocumentInventoryAt,
  validateDocumentSource,
} from "./document-inventory.ts"
import { readDocumentGenerationV2 } from "./document-version-store-v2.ts"
import { getWorkspaceRoot, workspaceCacheKey } from "./workspace.ts"
import {
  documentGenerationV2Directory,
  readWorkspaceStorageLayoutAt,
  requireRealDocumentStorageDirectory,
} from "./workspace-storage-v2.ts"

const JOB_ID_PATTERN = /^dcv2_[A-Za-z0-9_-]{22}$/
const JOB_MAX_BYTES = 1024 * 1024

const JobSchema = z
  .object({
    type: z.literal("worktable.document-create-recovery"),
    version: z.literal(1),
    id: z.string().regex(JOB_ID_PATTERN),
    state: z.enum([
      "prepared",
      "generation-written",
      "source-written",
      "committed",
    ]),
    workspaceRoot: z.string().min(1),
    workspaceId: z.string().min(1),
    spaceId: CanonicalIdSchema,
    documentId: DocumentIdSchema,
    path: z.string().min(1),
    format: DocumentFormatClaimSchema,
    source: DocumentSourceSchema,
    generationId: DocumentGenerationIdSchema,
    generationEntry: DocumentGenerationEntrySchema.shape.path,
    createdAt: z.iso.datetime(),
    createdBy: z.string().min(1),
    operationSource: z.string().min(1),
    reason: z.string().optional(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

type DocumentCreateRecoveryV2Job = z.infer<typeof JobSchema>

export interface RecoveredDocumentCreateV2 {
  path: string
  job: DocumentCreateRecoveryV2Job
}

function recoveryRoot(): string {
  return join(
    ensureAppDir(),
    "document-create-recovery-v2",
    workspaceCacheKey()
  )
}

async function ensureRecoveryRoot(): Promise<string> {
  const appRoot = ensureAppDir()
  const base = join(appRoot, "document-create-recovery-v2")
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
      throw new Error("document create recovery path is not a real directory")
    }
    if (created) await fsyncDirectory(dirname(directory))
  }
  return root
}

function jobPath(id: string): string {
  return join(recoveryRoot(), `${id}.json`)
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
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

async function writeJob(job: DocumentCreateRecoveryV2Job): Promise<void> {
  const root = await ensureRecoveryRoot()
  const text = `${JSON.stringify(JobSchema.parse(job), null, 2)}\n`
  if (Buffer.byteLength(text) > JOB_MAX_BYTES) {
    throw new Error("document create recovery job exceeds its size limit")
  }
  const destination = jobPath(job.id)
  const temporary = join(
    root,
    `.pending-${job.id}-${randomBytes(8).toString("hex")}`
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
    await rename(temporary, destination)
    published = true
    await fsyncDirectory(root)
  } finally {
    if (!published) await rm(temporary, { force: true })
  }
}

export async function prepareDocumentCreateRecoveryV2(input: {
  spaceId: string
  documentId: string
  path: string
  format: z.infer<typeof DocumentFormatClaimSchema>
  source: z.infer<typeof DocumentSourceSchema>
  generationId: string
  generationEntry: string
  createdAt: string
  createdBy: string
  operationSource: string
  reason?: string
  sourceBytes: Uint8Array
}): Promise<RecoveredDocumentCreateV2> {
  if (input.source.kind !== "file") {
    throw new Error("document create recovery supports managed files only")
  }
  const workspaceRoot = resolve(getWorkspaceRoot())
  const layout = await readWorkspaceStorageLayoutAt(workspaceRoot)
  if (layout.kind !== "v2") {
    throw new Error("document create recovery requires Storage V2")
  }
  const id = `dcv2_${randomBytes(16).toString("base64url")}`
  const job = JobSchema.parse({
    type: "worktable.document-create-recovery",
    version: 1,
    id,
    state: "prepared",
    workspaceRoot,
    workspaceId: layout.manifest.id,
    spaceId: input.spaceId,
    documentId: input.documentId,
    path: input.path,
    format: input.format,
    source: input.source,
    generationId: input.generationId,
    generationEntry: input.generationEntry,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    operationSource: input.operationSource,
    ...(input.reason ? { reason: input.reason } : {}),
    bytes: input.sourceBytes.byteLength,
    sha256: sha256(input.sourceBytes),
  })
  await writeJob(job)
  return { path: jobPath(id), job }
}

export async function advanceDocumentCreateRecoveryV2(
  recovery: RecoveredDocumentCreateV2,
  state: DocumentCreateRecoveryV2Job["state"]
): Promise<void> {
  recovery.job = JobSchema.parse({ ...recovery.job, state })
  await writeJob(recovery.job)
}

export async function finishDocumentCreateRecoveryV2(
  recovery: RecoveredDocumentCreateV2
): Promise<void> {
  await rm(recovery.path, { force: true })
  await fsyncDirectory(dirname(recovery.path))
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function sourceState(
  workspaceRoot: string,
  job: DocumentCreateRecoveryV2Job
): Promise<"absent" | "different" | "exact"> {
  const spaceRoot = resolve(workspaceRoot, "spaces", job.spaceId)
  const validated = validateDocumentSource(spaceRoot, job.source)
  if (!validated.safe) throw new Error(validated.message)
  const parent = dirname(validated.absolutePath)
  const parentInfo = await lstat(parent).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return null
    throw error
  })
  if (!parentInfo) return "absent"
  await requireRealDocumentStorageDirectory(workspaceRoot, parent)
  try {
    const bytes = await readBoundedRegularFileBytes(
      validated.absolutePath,
      job.bytes
    )
    if (bytes.byteLength !== job.bytes || sha256(bytes) !== job.sha256) {
      return "different"
    }
    return "exact"
  } catch (error) {
    if (error instanceof BoundedFileReadError) {
      return error.reason === "missing" ? "absent" : "different"
    }
    throw error
  }
}

async function generationState(
  workspaceRoot: string,
  job: DocumentCreateRecoveryV2Job
): Promise<"absent" | "exact"> {
  const generation = await readDocumentGenerationV2({
    workspaceRoot,
    spaceId: job.spaceId,
    documentId: job.documentId,
    generationId: job.generationId,
  })
  if (!generation) return "absent"
  const entry = generation.authoredSource.entries[0]
  if (
    generation.manifest.logicalPath !== job.path ||
    !sameJson(generation.manifest.format, job.format) ||
    generation.manifest.operation !== "create" ||
    generation.manifest.createdAt !== job.createdAt ||
    generation.manifest.createdBy !== job.createdBy ||
    generation.manifest.source !== job.operationSource ||
    generation.manifest.reason !== job.reason ||
    generation.authoredSource.kind !== "file" ||
    generation.authoredSource.entries.length !== 1 ||
    entry?.path !== job.generationEntry ||
    entry.bytes.byteLength !== job.bytes ||
    sha256(entry.bytes) !== job.sha256
  ) {
    throw new Error("document generation differs from its recovery job")
  }
  return "exact"
}

async function removeExactGeneration(
  workspaceRoot: string,
  job: DocumentCreateRecoveryV2Job
): Promise<void> {
  const path = documentGenerationV2Directory(
    workspaceRoot,
    job.spaceId,
    job.documentId,
    job.generationId
  )
  await requireRealDocumentStorageDirectory(workspaceRoot, path)
  await rm(path, { recursive: true, force: true })
  await fsyncDirectory(dirname(path))
}

async function reconcileOne(
  recovery: RecoveredDocumentCreateV2
): Promise<"committed" | "rolled-back"> {
  const workspaceRoot = resolve(getWorkspaceRoot())
  const layout = await readWorkspaceStorageLayoutAt(workspaceRoot)
  if (
    layout.kind !== "v2" ||
    workspaceRoot !== recovery.job.workspaceRoot ||
    layout.manifest.id !== recovery.job.workspaceId
  ) {
    throw new Error("document create recovery belongs to another workspace")
  }
  const spaceRoot = resolve(workspaceRoot, "spaces", recovery.job.spaceId)
  await requireRealDocumentStorageDirectory(workspaceRoot, spaceRoot)
  const inventory = await readDocumentInventoryAt(
    resolve(spaceRoot, "documents.meta.json"),
    spaceRoot
  )
  if (
    inventory.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new Error("document inventory is invalid during create recovery")
  }
  const owned = inventory.entries.get(recovery.job.documentId)
  if (
    owned &&
    (owned.path !== recovery.job.path ||
      !sameJson(owned.format, recovery.job.format) ||
      !sameJson(owned.source, recovery.job.source))
  ) {
    throw new Error("document inventory differs from its create recovery job")
  }
  const [source, generation] = await Promise.all([
    sourceState(workspaceRoot, recovery.job),
    generationState(workspaceRoot, recovery.job),
  ])
  if (owned) {
    if (generation !== "exact") {
      throw new Error("committed document create is incomplete")
    }
    // Ownership is published only after the exact source and generation. A
    // different or absent source at recovery time is therefore a later valid
    // filesystem edit, which normal reconciliation owns after this job closes.
    await finishDocumentCreateRecoveryV2(recovery)
    return "committed"
  }
  if (source === "exact" && generation === "absent") {
    throw new Error("document create source has no recoverable generation")
  }
  if (source === "exact" && generation === "exact") {
    await updateDocumentInventoryAt(spaceRoot, {
      upsert: [
        {
          documentId: recovery.job.documentId,
          path: recovery.job.path,
          format: recovery.job.format,
          source: recovery.job.source,
        },
      ],
    })
    await finishDocumentCreateRecoveryV2(recovery)
    return "committed"
  }
  // An unowned source with different bytes belongs to the competing writer
  // that won publication. Preserve it while rolling back only this job's
  // exact staged generation.
  if (generation === "exact") {
    await removeExactGeneration(workspaceRoot, recovery.job)
  }
  await finishDocumentCreateRecoveryV2(recovery)
  return "rolled-back"
}

/** Discover validated pending jobs synchronously before requests are admitted. */
export function discoverDocumentCreateRecoveryV2(): RecoveredDocumentCreateV2[] {
  const root = recoveryRoot()
  if (!existsSync(root)) return []
  const rootInfo = lstatSync(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("document create recovery path is not a real directory")
  }
  const recovered: RecoveredDocumentCreateV2[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const match = /^(dcv2_[A-Za-z0-9_-]{22})\.json$/.exec(entry.name)
    if (!match) continue
    const path = join(root, entry.name)
    const info = lstatSync(path)
    if (!entry.isFile() || info.isSymbolicLink()) {
      throw new Error("document create recovery job is not a regular file")
    }
    const text = readFileSync(path, "utf8")
    if (Buffer.byteLength(text) > JOB_MAX_BYTES) {
      throw new Error("document create recovery job exceeds its size limit")
    }
    const job = JobSchema.parse(JSON.parse(text))
    if (job.id !== match[1]) {
      throw new Error("document create recovery identity mismatch")
    }
    recovered.push({ path, job })
  }
  return recovered
}

export async function reconcileDocumentCreateRecoveryV2(
  recovered: readonly RecoveredDocumentCreateV2[]
): Promise<Array<"committed" | "rolled-back">> {
  const outcomes: Array<"committed" | "rolled-back"> = []
  for (const recovery of recovered) outcomes.push(await reconcileOne(recovery))
  return outcomes
}
