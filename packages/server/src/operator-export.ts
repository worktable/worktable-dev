import { randomBytes, timingSafeEqual } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { ensureAppDir } from "./app-storage.ts"
import { withWorkspaceExportSnapshot } from "./workspace-export-coordinator.ts"
import { withWorkspaceExportLease } from "./workspace-replacement-coordinator.ts"
import { writeWorkspaceExportV2 } from "./workspace-transfer-v2.ts"

export const LOCAL_OPERATOR_EXPORT_PATH = "/internal/operator/workspace-export"
export const LOCAL_OPERATOR_TOKEN_HEADER = "x-worktable-local-operator"

const OPERATION_FILE = /^(?<operationId>[A-Za-z0-9_-]{8,80})\.wtb$/
const OPERATOR_EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000

let activeOperatorToken: string | null = null

function operatorRuntimeDirectory(): string {
  return join(ensureAppDir(), "operator-runtime")
}

export function localOperatorTokenPath(): string {
  return join(operatorRuntimeDirectory(), "token")
}

/**
 * Rotate the process-local operator capability before binding the listener.
 * The detached operator reads the owner-only file from the same Sprite; public
 * callers never receive this credential.
 */
export function initializeLocalOperatorToken(): string {
  const directory = operatorRuntimeDirectory()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString("base64url")
  const temporary = join(
    directory,
    `.token-${process.pid}-${randomBytes(8).toString("hex")}.partial`
  )
  try {
    writeFileSync(temporary, `${token}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    renameSync(temporary, localOperatorTokenPath())
    chmodSync(localOperatorTokenPath(), 0o600)
  } finally {
    rmSync(temporary, { force: true })
  }
  activeOperatorToken = token
  return token
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function isAuthorizedLocalOperatorRequest(request: Request): boolean {
  const url = new URL(request.url)
  if (
    request.method !== "POST" ||
    url.pathname !== LOCAL_OPERATOR_EXPORT_PATH
  ) {
    return false
  }
  const presented = request.headers.get(LOCAL_OPERATOR_TOKEN_HEADER)?.trim()
  return Boolean(
    activeOperatorToken &&
    presented &&
    safeEqual(activeOperatorToken, presented)
  )
}

export function disableAuthorizedOperatorRequestTimeout(
  request: Request,
  server: { timeout(request: Request, seconds: number): void }
): boolean {
  if (!isAuthorizedLocalOperatorRequest(request)) return false
  server.timeout(request, 0)
  return true
}

function operatorExportsRoot(): string {
  return resolve(join(ensureAppDir(), "operator-exports"))
}

function operatorExportOperationId(name: string): string | null {
  return (
    /^(?<id>[A-Za-z0-9_-]{8,80})\.wtb(?:$|\.)/.exec(name)?.groups?.["id"] ??
    /^\.(?<id>[A-Za-z0-9_-]{8,80})\.wtb\./.exec(name)?.groups?.["id"] ??
    null
  )
}

async function operatorExportWorkerIsActive(
  startedPath: string
): Promise<boolean> {
  let lines: string[]
  try {
    lines = (await readFile(startedPath, "utf8")).trim().split("\n")
  } catch {
    return false
  }
  const pid = Number(lines[0])
  const expectedIncarnation = lines[1]?.trim()
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !expectedIncarnation ||
    !/^\d+$/.test(expectedIncarnation)
  ) {
    return false
  }
  try {
    const processStat = await readFile(`/proc/${pid}/stat`, "utf8")
    const commandEnd = processStat.lastIndexOf(")")
    if (commandEnd < 0) return false
    // Fields after the command begin at field 3; starttime is field 22.
    const actualIncarnation = processStat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/)[19]
    process.kill(pid, 0)
    return actualIncarnation === expectedIncarnation
  } catch {
    return false
  }
}

/**
 * General maintenance for operator-only staging artifacts. Each sweep tries
 * once; a later hourly sweep naturally retries filesystem failures. Exact PID
 * incarnation checks protect an export that legitimately runs past retention.
 */
export async function cleanupExpiredOperatorWorkspaceExports(
  options: { now?: number; retentionMs?: number } = {}
): Promise<number> {
  const root = operatorExportsRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const groups = new Map<string, string[]>()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const operationId = operatorExportOperationId(entry.name)
    if (!operationId) continue
    const names = groups.get(operationId) ?? []
    names.push(entry.name)
    groups.set(operationId, names)
  }

  const now = options.now ?? Date.now()
  const retentionMs = options.retentionMs ?? OPERATOR_EXPORT_RETENTION_MS
  let removed = 0
  for (const [operationId, names] of groups) {
    const paths = names.map((name) => join(root, name))
    let newest = 0
    for (const path of paths) {
      try {
        newest = Math.max(newest, (await stat(path)).mtimeMs)
      } catch {
        // A concurrent cleanup already removed it.
      }
    }
    if (newest > now - retentionMs) continue
    if (
      await operatorExportWorkerIsActive(
        join(root, `${operationId}.wtb.started`)
      )
    ) {
      continue
    }
    await Promise.all(paths.map((path) => rm(path, { force: true })))
    removed += 1
  }
  return removed
}

async function validateOperatorDestination(
  destination: string
): Promise<string> {
  const root = operatorExportsRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("operator export directory must be a real directory")
  }
  const candidate = resolve(destination)
  if (
    dirname(candidate) !== root ||
    !OPERATION_FILE.test(basename(candidate))
  ) {
    throw new Error("operator export destination is invalid")
  }
  return candidate
}

export interface LiveOperatorWorkspaceExportResult {
  command: "workspace-export"
  destination: string
  exportId: string
  sourceWorkspaceId: string
  sourceCheckpoint: string
  files: number
}

/** Capture through the live server's writer flush and mutation barrier. */
export async function writeLiveOperatorWorkspaceExport(
  destination: string
): Promise<LiveOperatorWorkspaceExportResult> {
  const validated = await validateOperatorDestination(destination)
  const bundle = await withWorkspaceExportLease(() =>
    writeWorkspaceExportV2(validated, {
      force: true,
      withCaptureBarrier: withWorkspaceExportSnapshot,
    })
  )
  return {
    command: "workspace-export",
    destination: bundle.destination,
    exportId: bundle.manifest.exportId,
    sourceWorkspaceId: bundle.manifest.source.workspaceId,
    sourceCheckpoint: bundle.manifest.integrity.sourceCheckpoint,
    files: bundle.manifest.integrity.files.length,
  }
}

function validResult(
  value: unknown,
  destination: string
): value is LiveOperatorWorkspaceExportResult {
  if (!value || typeof value !== "object") return false
  const result = value as Partial<LiveOperatorWorkspaceExportResult>
  return (
    result.command === "workspace-export" &&
    result.destination === destination &&
    typeof result.exportId === "string" &&
    typeof result.sourceWorkspaceId === "string" &&
    typeof result.sourceCheckpoint === "string" &&
    typeof result.files === "number" &&
    Number.isSafeInteger(result.files) &&
    result.files >= 1
  )
}

/**
 * Maintenance processes never read the workspace. They present the rotating
 * local capability to the live server, which owns the flush/barrier contract.
 */
export async function requestLiveOperatorWorkspaceExport(
  destination: string
): Promise<LiveOperatorWorkspaceExportResult> {
  const token = readFileSync(localOperatorTokenPath(), "utf8").trim()
  if (!token) throw new Error("live workspace export token is unavailable")
  const port = Number(process.env["PORT"] ?? "7480")
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("live workspace export port is invalid")
  }
  const response = await fetch(
    `http://127.0.0.1:${port}${LOCAL_OPERATOR_EXPORT_PATH}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [LOCAL_OPERATOR_TOKEN_HEADER]: token,
      },
      body: JSON.stringify({ destination }),
    }
  )
  const value = (await response.json().catch(() => null)) as unknown
  if (!response.ok) {
    const message =
      value &&
      typeof value === "object" &&
      "error" in value &&
      typeof value.error === "string"
        ? value.error
        : `HTTP ${response.status}`
    throw new Error(`live workspace export failed: ${message}`)
  }
  if (!validResult(value, destination)) {
    throw new Error("live workspace export returned invalid metadata")
  }
  return value
}

export function resetLocalOperatorTokenForTests(): void {
  activeOperatorToken = null
}
