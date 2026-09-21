import {
  authenticatedFetch,
  BASE_URL,
  fetchJSON,
  redirectToLogin,
} from "./http"

export type ExportHistoryPolicy =
  | { mode: "all" }
  | { mode: "age"; maxAgeDays: number }
  | { mode: "count"; maxPerItem: number }
  | { mode: "none" }

export interface TransferHistorySummary {
  requested: ExportHistoryPolicy
  complete: boolean
  includedFiles: number
  includedBytes: number
  omittedFiles: number
  omittedBytes: number
  meaningfulCheckpoints: number
  oldestIncludedAt?: string
  newestIncludedAt?: string
  warnings: string[]
}

export interface TransferManifestSummary {
  exportId: string
  exportedAt: string
  source: {
    workspaceId: string
    workspaceName: string
  }
  history: TransferHistorySummary
  viewer: {
    status: "complete" | "partial" | "failed"
    warnings: string[]
  }
  contentCheckpoint: string
  files: number
  bytes: number
}

interface TransferBase {
  version: 1
  id: string
  createdAt: string
  updatedAt: string
  expiresAt: string
  error?: string
}

export interface WorkspaceExportJob extends TransferBase {
  kind: "export"
  state: "queued" | "running" | "complete" | "failed"
  history: ExportHistoryPolicy
  downloadName?: string
  bytes?: number
  sha256?: string
  manifest?: TransferManifestSummary
}

export interface WorkspaceImportJob extends TransferBase {
  kind: "import"
  state:
    | "uploading"
    | "verifying"
    | "uploaded"
    | "preparing"
    | "ready"
    | "replacing"
    | "complete"
    | "failed"
  fileName: string
  expectedBytes: number
  receivedBytes: number
  resumeFingerprint?: string
  sha256?: string
  manifest?: TransferManifestSummary
  prepared?: {
    source: TransferManifestSummary["source"]
    exportedAt: string
    history: TransferHistorySummary
    contentCheckpoint: string
    files: number
    bytes: number
  }
}

export interface WorkspaceImportCreated extends WorkspaceImportJob {
  chunkBytes: number
}

export function createWorkspaceExport(history: ExportHistoryPolicy) {
  return fetchJSON<WorkspaceExportJob>("/api/workspace/transfers/exports", {
    method: "POST",
    body: JSON.stringify({ history }),
  })
}

export function getWorkspaceExportJob(id: string) {
  return fetchJSON<WorkspaceExportJob>(
    `/api/workspace/transfers/exports/${encodeURIComponent(id)}`
  )
}

export async function getCurrentWorkspaceExportJob() {
  const result = await fetchJSON<{ job: WorkspaceExportJob | null }>(
    "/api/workspace/transfers/exports/current"
  )
  return result.job
}

export function workspaceExportDownloadUrl(id: string): string {
  return `${BASE_URL}/api/workspace/transfers/exports/${encodeURIComponent(id)}/download`
}

const IMPORT_RESUME_SAMPLE_BYTES = 64 * 1024

function fallbackResumeFingerprint(bytes: Uint8Array): string {
  const mask = (1n << 64n) - 1n
  const prime = 1_099_511_628_211n
  const spread = 11_400_714_819_323_198_485n
  const states = Array.from(
    { length: 4 },
    (_, index) => 14_695_981_039_346_656_037n ^ (BigInt(index) * spread)
  )
  for (const byte of bytes) {
    for (let index = 0; index < states.length; index += 1) {
      states[index] =
        ((states[index]! ^ BigInt(byte)) * prime + BigInt(index)) & mask
    }
  }
  return states.map((state) => state.toString(16).padStart(16, "0")).join("")
}

export async function workspaceImportResumeFingerprint(
  file: File,
  subtle: Pick<SubtleCrypto, "digest"> | null = globalThis.crypto?.subtle ??
    null
): Promise<string> {
  const headEnd = Math.min(file.size, IMPORT_RESUME_SAMPLE_BYTES)
  const tailStart = Math.max(headEnd, file.size - IMPORT_RESUME_SAMPLE_BYTES)
  const envelope = new Blob([
    new TextEncoder().encode(`worktable-import-resume-v1\0${file.size}\0`),
    file.slice(0, headEnd),
    file.slice(tailStart),
  ])
  const bytes = new Uint8Array(await envelope.arrayBuffer())
  if (!subtle) return fallbackResumeFingerprint(bytes)
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function canResumeWorkspaceImport(
  file: File,
  job: WorkspaceImportCreated | null | undefined,
  resumeFingerprint: string
): job is WorkspaceImportCreated {
  return (
    job?.state === "uploading" &&
    job.fileName === file.name &&
    job.expectedBytes === file.size &&
    job.resumeFingerprint === resumeFingerprint
  )
}

export function createWorkspaceImport(file: File, resumeFingerprint: string) {
  return fetchJSON<WorkspaceImportCreated>("/api/workspace/transfers/imports", {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      bytes: file.size,
      resumeFingerprint,
    }),
  })
}

export async function getCurrentWorkspaceImportJob() {
  const result = await fetchJSON<{ job: WorkspaceImportCreated | null }>(
    "/api/workspace/transfers/imports/current"
  )
  return result.job
}

class WorkspaceTransferHttpError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "WorkspaceTransferHttpError"
    this.status = status
  }
}

async function requireOk<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    redirectToLogin()
    throw new WorkspaceTransferHttpError("Unauthorized", response.status)
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
    } | null
    throw new WorkspaceTransferHttpError(
      body?.error ?? `HTTP ${response.status}`,
      response.status
    )
  }
  return response.json() as Promise<T>
}

const IMPORT_UPLOAD_RETRY_INITIAL_DELAY_MS = 1_000
const IMPORT_UPLOAD_MAX_ATTEMPTS = 3

interface WorkspaceImportUploadOptions {
  sleep?: (milliseconds: number) => Promise<void>
  maxAttempts?: number
  resumeFingerprint?: string
  uploadChunk?: (input: {
    id: string
    start: number
    endExclusive: number
    total: number
    body: Blob
  }) => Promise<WorkspaceImportJob>
}

export async function uploadWorkspaceImport(
  file: File,
  created: WorkspaceImportCreated,
  onProgress: (uploaded: number) => void,
  options: WorkspaceImportUploadOptions = {}
): Promise<WorkspaceImportJob> {
  if (
    file.size !== created.expectedBytes ||
    created.receivedBytes < 0 ||
    created.receivedBytes > file.size ||
    (created.resumeFingerprint !== undefined &&
      options.resumeFingerprint !== created.resumeFingerprint)
  ) {
    throw new Error("The selected file does not match this import.")
  }
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const uploadChunk =
    options.uploadChunk ??
    (async ({
      id,
      start,
      endExclusive,
      total,
      body,
    }: {
      id: string
      start: number
      endExclusive: number
      total: number
      body: Blob
    }) => {
      const response = await authenticatedFetch(
        `${BASE_URL}/api/workspace/transfers/imports/${encodeURIComponent(id)}/content`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Range": `bytes ${start}-${endExclusive - 1}/${total}`,
          },
          body,
        }
      )
      return requireOk<WorkspaceImportJob>(response)
    })
  const maxAttempts = Math.max(
    1,
    options.maxAttempts ?? IMPORT_UPLOAD_MAX_ATTEMPTS
  )
  let job: WorkspaceImportJob = created
  onProgress(created.receivedBytes)
  for (let start = created.receivedBytes; start < file.size; ) {
    const endExclusive = Math.min(start + created.chunkBytes, file.size)
    const body = file.slice(start, endExclusive)
    for (let attempt = 1; ; attempt += 1) {
      try {
        job = await uploadChunk({
          id: created.id,
          start,
          endExclusive,
          total: file.size,
          body,
        })
        break
      } catch (error) {
        const retryable = !(
          error instanceof WorkspaceTransferHttpError &&
          ![408, 425, 429].includes(error.status) &&
          error.status < 500
        )
        if (!retryable || attempt >= maxAttempts) {
          throw error
        }
        await sleep(IMPORT_UPLOAD_RETRY_INITIAL_DELAY_MS * 2 ** (attempt - 1))
      }
    }
    start = endExclusive
    onProgress(start)
  }
  return job
}

export function getWorkspaceImportJob(id: string) {
  return fetchJSON<WorkspaceImportJob>(
    `/api/workspace/transfers/imports/${encodeURIComponent(id)}`
  )
}

export function prepareWorkspaceImport(id: string) {
  return fetchJSON<WorkspaceImportJob>(
    `/api/workspace/transfers/imports/${encodeURIComponent(id)}/prepare`,
    {
      method: "POST",
      body: JSON.stringify({}),
    }
  )
}

export function replaceWorkspaceFromImport(id: string) {
  return fetchJSON<WorkspaceImportJob>(
    `/api/workspace/transfers/imports/${encodeURIComponent(id)}/replace`,
    {
      method: "POST",
      body: JSON.stringify({ confirmation: "replace" }),
    }
  )
}
