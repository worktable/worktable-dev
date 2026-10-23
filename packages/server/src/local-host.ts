import { createHash, randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { ensureAppDir } from "./app-storage.ts"
import { workspaceCacheKeyForRoot } from "./workspace.ts"

export const LOCAL_HOST_SCHEMA_VERSION = 1
export const LOCAL_WORKSPACES_FILE = "local-workspaces.json"
/** Each running local host publishes its lease in this directory, one file per Worktable. */
export const LOCAL_RUNTIME_DIRECTORY = "local-runtime"
/** The single lease of releases that ran one local host at a time. */
export const LEGACY_LOCAL_RUNTIME_FILE = "local-runtime.json"
export const LOCAL_PROOF_HEADER = "X-Worktable-Local-Proof"
const LOCAL_RUNTIME_LOCK_DIRECTORY = "local-runtime.lock"
const LOCAL_RUNTIME_LOCK_OWNER_FILE = "owner.json"
const LOCAL_RUNTIME_LOCK_TIMEOUT_MS = 15_000
const LOCAL_RUNTIME_INCOMPLETE_LOCK_GRACE_MS = 5_000

export class UnsupportedLocalRuntimeSchemaError extends Error {
  readonly schemaVersion: unknown

  constructor(schemaVersion: unknown) {
    super(
      `local runtime record uses unsupported schema ${String(schemaVersion ?? "(missing)")}`
    )
    this.name = "UnsupportedLocalRuntimeSchemaError"
    this.schemaVersion = schemaVersion
  }
}

export class UnsupportedLocalWorkspaceRegistrySchemaError extends Error {
  readonly schemaVersion: unknown

  constructor(schemaVersion: unknown) {
    super(
      `local workspace registry uses unsupported schema ${String(schemaVersion ?? "(missing)")}`
    )
    this.name = "UnsupportedLocalWorkspaceRegistrySchemaError"
    this.schemaVersion = schemaVersion
  }
}

export type LocalRuntimeOwner = "desktop" | "service" | "cli"

export interface LocalWorkspaceEntry {
  workspaceId: string
  name: string
  path: string
  host: string
  port: number
  lastUsedAt: string
}

export interface LocalWorkspaceRegistry {
  schemaVersion: 1
  activeWorkspaceId: string | null
  workspaces: LocalWorkspaceEntry[]
}

export interface LocalRuntimeRecord {
  schemaVersion: 1
  owner: LocalRuntimeOwner
  pid: number
  ownerIdentity?: string
  installId: string
  workspaceId: string
  workspacePath: string
  host: string
  port: number
  nonce: string
  proofToken: string
  startedAt: string
}

export type LocalRuntimePublic = Omit<
  LocalRuntimeRecord,
  "ownerIdentity" | "proofToken"
> & {
  processAlive: boolean
  endpointVerified: boolean
}

export type LocalRuntimeEndpointState = "verified" | "unreachable" | "rejected"

export type LocalRuntimeInspection = LocalRuntimePublic & {
  endpointState: LocalRuntimeEndpointState
}

function normalizedLocalHost(host: string): string {
  const trimmed = host.trim().toLowerCase()
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed
}

function localHostIsWildcard(host: string): boolean {
  const normalized = normalizedLocalHost(host)
  return normalized === "0.0.0.0" || normalized === "::"
}

function localHostIsLoopback(host: string): boolean {
  const normalized = normalizedLocalHost(host)
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  )
}

export function localClientHost(host: string): string {
  return localHostIsWildcard(host) ? "127.0.0.1" : normalizedLocalHost(host)
}

export function localHttpOrigin(host: string, port: number): string {
  const clientHost = localClientHost(host)
  const urlHost = clientHost.includes(":") ? `[${clientHost}]` : clientHost
  return `http://${urlHost}:${port}`
}

export function localHostsSharePortSpace(left: string, right: string): boolean {
  const normalizedLeft = normalizedLocalHost(left)
  const normalizedRight = normalizedLocalHost(right)
  return (
    normalizedLeft === normalizedRight ||
    localHostIsWildcard(normalizedLeft) ||
    localHostIsWildcard(normalizedRight) ||
    (localHostIsLoopback(normalizedLeft) &&
      localHostIsLoopback(normalizedRight))
  )
}

function emptyRegistry(): LocalWorkspaceRegistry {
  return {
    schemaVersion: LOCAL_HOST_SCHEMA_VERSION,
    activeWorkspaceId: null,
    workspaces: [],
  }
}

/**
 * Whether Worktable Link is on for the Worktable at this path on this device:
 * its link record exists and is not disabled. Pausing happens in Cloud, so a
 * paused link still counts as on here. null when the record can't be read,
 * so a caller never mistakes an unreadable record for Link being off.
 */
export function localWorkspaceLinked(workspacePath: string): boolean | null {
  let text: string
  try {
    text = readFileSync(
      join(
        ensureAppDir(),
        "linked",
        `${workspaceCacheKeyForRoot(resolve(workspacePath))}.json`
      ),
      "utf8"
    )
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null
  }
  try {
    const link = JSON.parse(text) as unknown
    return isRecord(link) && typeof link["disabled"] === "boolean"
      ? link["disabled"] === false
      : null
  } catch {
    return null
  }
}

export function getLocalWorkspaceRegistryPath(): string {
  return join(ensureAppDir(), LOCAL_WORKSPACES_FILE)
}

function localRuntimeFileStem(workspaceId: string): string {
  // Manifest ids are base64url. Anything else still gets a safe file name.
  return /^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)
    ? workspaceId
    : `id-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 32)}`
}

export function getLocalRuntimeDirectory(): string {
  return join(ensureAppDir(), LOCAL_RUNTIME_DIRECTORY)
}

/** The lease of the host serving one Worktable. */
export function getLocalRuntimePath(workspaceId: string): string {
  return join(
    getLocalRuntimeDirectory(),
    `${localRuntimeFileStem(workspaceId)}.json`
  )
}

export function getLegacyLocalRuntimePath(): string {
  return join(ensureAppDir(), LEGACY_LOCAL_RUNTIME_FILE)
}

function getLocalRuntimeLockPath(workspaceId?: string): string {
  return workspaceId === undefined
    ? join(ensureAppDir(), LOCAL_RUNTIME_LOCK_DIRECTORY)
    : join(
        getLocalRuntimeDirectory(),
        `${localRuntimeFileStem(workspaceId)}.lock`
      )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

interface LocalRuntimeFileLockOwner {
  schemaVersion: 1
  pid: number
  ownerIdentity?: string
  nonce: string
}

function readLocalRuntimeFileLockOwner(
  lockPath: string
): LocalRuntimeFileLockOwner | null {
  try {
    const value = JSON.parse(
      readFileSync(join(lockPath, LOCAL_RUNTIME_LOCK_OWNER_FILE), "utf8")
    ) as unknown
    if (
      !isRecord(value) ||
      value["schemaVersion"] !== 1 ||
      typeof value["pid"] !== "number" ||
      !Number.isInteger(value["pid"]) ||
      value["pid"] <= 0 ||
      typeof value["nonce"] !== "string" ||
      value["nonce"].trim() === "" ||
      !(
        value["ownerIdentity"] === undefined ||
        (typeof value["ownerIdentity"] === "string" &&
          value["ownerIdentity"].trim() !== "")
      )
    ) {
      return null
    }
    return {
      schemaVersion: 1,
      pid: value["pid"],
      ...(typeof value["ownerIdentity"] === "string"
        ? { ownerIdentity: value["ownerIdentity"] }
        : {}),
      nonce: value["nonce"],
    }
  } catch {
    return null
  }
}

function localRuntimeFileLockOwnerAlive(
  owner: LocalRuntimeFileLockOwner
): boolean {
  if (!localProcessAlive(owner.pid)) return false
  if (!owner.ownerIdentity) return true
  const identity = localProcessIdentity(owner.pid)
  return identity === null || identity === owner.ownerIdentity
}

function waitForLocalRuntimeFileLock(): void {
  localRuntimeLockWaitHookForTests?.()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
}

let localRuntimeLockWaitHookForTests: (() => void) | null = null

export function setLocalRuntimeLockWaitHookForTests(
  hook: (() => void) | null
): void {
  localRuntimeLockWaitHookForTests = hook
}

function acquireLocalRuntimeFileLock(workspaceId?: string): () => void {
  const lockPath = getLocalRuntimeLockPath(workspaceId)
  const ownerIdentity = localProcessIdentity(process.pid)
  const nonce = randomBytes(18).toString("base64url")
  const startedAt = Date.now()
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })

  while (true) {
    let acquired = false
    try {
      mkdirSync(lockPath, { mode: 0o700 })
      acquired = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }

    if (acquired) {
      try {
        writePrivateJson(join(lockPath, LOCAL_RUNTIME_LOCK_OWNER_FILE), {
          schemaVersion: 1,
          pid: process.pid,
          ...(ownerIdentity ? { ownerIdentity } : {}),
          nonce,
        })
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true })
        throw error
      }
      return () => {
        const owner = readLocalRuntimeFileLockOwner(lockPath)
        if (owner?.nonce === nonce && owner.pid === process.pid) {
          rmSync(lockPath, { recursive: true, force: true })
        }
      }
    }

    const owner = readLocalRuntimeFileLockOwner(lockPath)
    let incompleteLockIsRecent = false
    if (!owner) {
      try {
        incompleteLockIsRecent =
          Date.now() - statSync(lockPath).mtimeMs <
          LOCAL_RUNTIME_INCOMPLETE_LOCK_GRACE_MS
      } catch {
        continue
      }
    }
    if (
      owner ? localRuntimeFileLockOwnerAlive(owner) : incompleteLockIsRecent
    ) {
      if (Date.now() - startedAt >= LOCAL_RUNTIME_LOCK_TIMEOUT_MS) {
        throw new Error(
          "timed out waiting for another process to finish publishing the local runtime lease"
        )
      }
      waitForLocalRuntimeFileLock()
      continue
    }

    const stalePath = `${lockPath}.stale-${process.pid}-${randomBytes(6).toString("hex")}`
    try {
      renameSync(lockPath, stalePath)
      rmSync(stalePath, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

function withLocalRuntimeFileLock<T>(
  workspaceId: string | undefined,
  operation: () => T
): T {
  const release = acquireLocalRuntimeFileLock(workspaceId)
  try {
    return operation()
  } finally {
    release()
  }
}

function isPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 65535
  )
}

function isWorkspaceEntry(value: unknown): value is LocalWorkspaceEntry {
  if (!isRecord(value)) return false
  return (
    typeof value["workspaceId"] === "string" &&
    value["workspaceId"].trim() !== "" &&
    typeof value["name"] === "string" &&
    value["name"].trim() !== "" &&
    typeof value["path"] === "string" &&
    isAbsolute(value["path"]) &&
    typeof value["host"] === "string" &&
    value["host"].trim() !== "" &&
    isPort(value["port"]) &&
    typeof value["lastUsedAt"] === "string" &&
    value["lastUsedAt"].trim() !== ""
  )
}

function parseRegistry(value: unknown): LocalWorkspaceRegistry {
  if (!isRecord(value)) throw new Error("invalid local workspace registry")
  const schemaVersion = value["schemaVersion"]
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    throw new Error("invalid local workspace registry")
  }
  if (schemaVersion !== LOCAL_HOST_SCHEMA_VERSION) {
    throw new UnsupportedLocalWorkspaceRegistrySchemaError(schemaVersion)
  }
  const activeWorkspaceId = value["activeWorkspaceId"]
  const workspaces = value["workspaces"]
  if (
    !(activeWorkspaceId === null || typeof activeWorkspaceId === "string") ||
    !Array.isArray(workspaces) ||
    !workspaces.every(isWorkspaceEntry)
  ) {
    throw new Error("invalid local workspace registry")
  }
  const ids = new Set<string>()
  const paths = new Set<string>()
  const normalized = workspaces.map((entry) => ({
    ...entry,
    path: resolve(entry.path),
    host: entry.host.trim(),
  }))
  for (const entry of normalized) {
    if (
      ids.has(entry.workspaceId) ||
      paths.has(entry.path) ||
      normalized.some(
        (candidate) =>
          candidate !== entry &&
          candidate.port === entry.port &&
          localHostsSharePortSpace(candidate.host, entry.host)
      )
    ) {
      throw new Error("local workspace registry contains duplicate ownership")
    }
    ids.add(entry.workspaceId)
    paths.add(entry.path)
  }
  if (activeWorkspaceId !== null && !ids.has(activeWorkspaceId)) {
    throw new Error(
      "local workspace registry points at an unknown active workspace"
    )
  }
  return {
    schemaVersion: LOCAL_HOST_SCHEMA_VERSION,
    activeWorkspaceId,
    workspaces: normalized,
  }
}

export function readLocalWorkspaceRegistry(): LocalWorkspaceRegistry {
  const path = getLocalWorkspaceRegistryPath()
  if (!existsSync(path)) return emptyRegistry()
  return parseRegistry(JSON.parse(readFileSync(path, "utf8")) as unknown)
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null
  try {
    fd = openSync(path, "r")
    fsyncSync(fd)
  } catch {
    // Some filesystems do not support directory fsync. The atomic rename still
    // prevents readers from observing a partial JSON document.
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function writePrivateJson(path: string, value: unknown): void {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  const fd = openSync(temporary, "wx", 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n")
    try {
      fsyncSync(fd)
    } catch {
      // Best effort on filesystems without fsync support.
    }
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, path)
    fsyncDirectory(parent)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

export function writeLocalWorkspaceRegistry(
  registry: LocalWorkspaceRegistry
): LocalWorkspaceRegistry {
  const normalized = parseRegistry(registry)
  writePrivateJson(getLocalWorkspaceRegistryPath(), normalized)
  return normalized
}

interface LocalWorkspaceReservation {
  workspaceId?: string
  path: string
  host: string
  port: number
}

function assertLocalWorkspaceReservationInRegistry(
  current: LocalWorkspaceRegistry,
  input: LocalWorkspaceReservation
): void {
  const path = resolve(input.path)
  const host = input.host.trim()
  const workspaceId = input.workspaceId?.trim()
  const collision = current.workspaces.find(
    (candidate) =>
      candidate.workspaceId !== workspaceId &&
      (candidate.path === path ||
        (localHostsSharePortSpace(candidate.host, host) &&
          candidate.port === input.port))
  )
  if (collision) {
    throw new Error(
      collision.path === path
        ? `workspace path is already registered to ${collision.workspaceId}`
        : `local endpoint ${host}:${input.port} belongs to ${collision.name}`
    )
  }
}

/**
 * Side-effect-free reservation preflight for commands that must validate the
 * shared endpoint before changing credentials or config. The authority lock must
 * remain held between this check and rememberLocalWorkspace's final commit.
 */
export function assertLocalWorkspaceReservationAvailable(
  input: LocalWorkspaceReservation
): void {
  assertLocalWorkspaceReservationInRegistry(readLocalWorkspaceRegistry(), input)
}

export function rememberLocalWorkspace(input: {
  workspaceId: string
  name: string
  path: string
  host: string
  port: number
  active?: boolean
  now?: string
}): LocalWorkspaceRegistry {
  const current = readLocalWorkspaceRegistry()
  const path = resolve(input.path)
  const host = input.host.trim()
  const entry: LocalWorkspaceEntry = {
    workspaceId: input.workspaceId.trim(),
    name: input.name.trim(),
    path,
    host,
    port: input.port,
    lastUsedAt: input.now ?? new Date().toISOString(),
  }
  if (!isWorkspaceEntry(entry)) throw new Error("invalid local workspace entry")
  assertLocalWorkspaceReservationInRegistry(current, entry)

  const workspaces = current.workspaces.filter(
    (candidate) => candidate.workspaceId !== entry.workspaceId
  )
  workspaces.push(entry)
  return writeLocalWorkspaceRegistry({
    schemaVersion: LOCAL_HOST_SCHEMA_VERSION,
    activeWorkspaceId:
      input.active === false ? current.activeWorkspaceId : entry.workspaceId,
    workspaces,
  })
}

export function findLocalWorkspace(
  workspaceId: string
): LocalWorkspaceEntry | null {
  return (
    readLocalWorkspaceRegistry().workspaces.find(
      (entry) => entry.workspaceId === workspaceId
    ) ?? null
  )
}

export function findLocalWorkspaceByPath(
  path: string
): LocalWorkspaceEntry | null {
  const normalized = resolve(path)
  return (
    readLocalWorkspaceRegistry().workspaces.find(
      (entry) => entry.path === normalized
    ) ?? null
  )
}

function isRuntimeOwner(value: unknown): value is LocalRuntimeOwner {
  return value === "desktop" || value === "service" || value === "cli"
}

function parseRuntime(value: unknown): LocalRuntimeRecord {
  if (!isRecord(value)) throw new Error("invalid local runtime record")
  const schemaVersion = value["schemaVersion"]
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    throw new Error("invalid local runtime record")
  }
  if (schemaVersion !== LOCAL_HOST_SCHEMA_VERSION) {
    throw new UnsupportedLocalRuntimeSchemaError(schemaVersion)
  }
  if (
    !isRuntimeOwner(value["owner"]) ||
    typeof value["pid"] !== "number" ||
    !Number.isInteger(value["pid"]) ||
    value["pid"] <= 0 ||
    !(
      value["ownerIdentity"] === undefined ||
      (typeof value["ownerIdentity"] === "string" &&
        value["ownerIdentity"].trim() !== "")
    ) ||
    typeof value["installId"] !== "string" ||
    value["installId"].trim() === "" ||
    typeof value["workspaceId"] !== "string" ||
    value["workspaceId"].trim() === "" ||
    typeof value["workspacePath"] !== "string" ||
    !isAbsolute(value["workspacePath"]) ||
    typeof value["host"] !== "string" ||
    value["host"].trim() === "" ||
    !isPort(value["port"]) ||
    typeof value["nonce"] !== "string" ||
    value["nonce"].trim().length < 16 ||
    typeof value["proofToken"] !== "string" ||
    value["proofToken"].trim().length < 32 ||
    typeof value["startedAt"] !== "string" ||
    value["startedAt"].trim() === ""
  ) {
    throw new Error("invalid local runtime record")
  }
  return {
    schemaVersion: LOCAL_HOST_SCHEMA_VERSION,
    owner: value["owner"],
    pid: value["pid"],
    ...(typeof value["ownerIdentity"] === "string"
      ? { ownerIdentity: value["ownerIdentity"].trim() }
      : {}),
    installId: value["installId"].trim(),
    workspaceId: value["workspaceId"].trim(),
    workspacePath: resolve(value["workspacePath"]),
    host: value["host"].trim(),
    port: value["port"],
    nonce: value["nonce"].trim(),
    proofToken: value["proofToken"].trim(),
    startedAt: value["startedAt"],
  }
}

function readLocalRuntimeFile(path: string): LocalRuntimeRecord | null {
  if (!existsSync(path)) return null
  return parseRuntime(JSON.parse(readFileSync(path, "utf8")) as unknown)
}

/**
 * The lease of the host serving one Worktable, or null. A lease written by a
 * release that ran one host at a time still counts for its Worktable.
 */
export function readLocalRuntime(
  workspaceId: string
): LocalRuntimeRecord | null {
  const current = readLocalRuntimeFile(getLocalRuntimePath(workspaceId))
  let legacy: LocalRuntimeRecord | null
  try {
    legacy = readLocalRuntimeFile(getLegacyLocalRuntimePath())
  } catch (error) {
    // Only a missing current lease depends on the legacy file.
    if (current) return current
    throw error
  }
  return preferredLocalRuntime(
    current,
    legacy?.workspaceId === workspaceId ? legacy : null
  )
}

/**
 * Choose between this release's lease and the single-host lease for one
 * Worktable. The legacy file may hold a copy of the same lease (the configured
 * Worktable's host writes both), or an older release's host. A stale new
 * lease never hides a live legacy one.
 */
function preferredLocalRuntime(
  current: LocalRuntimeRecord | null,
  legacy: LocalRuntimeRecord | null
): LocalRuntimeRecord | null {
  if (!current || !legacy || current.nonce === legacy.nonce) {
    return current ?? legacy
  }
  return !localRuntimeProcessAlive(current) && localRuntimeProcessAlive(legacy)
    ? legacy
    : current
}

export interface LocalRuntimeFileError {
  path: string
  /** The Worktable the lease is named for, when its file name says so. */
  workspaceId: string | null
  error: unknown
}

export interface LocalRuntimeFile {
  path: string
  runtime: LocalRuntimeRecord | null
  error: LocalRuntimeFileError | null
}

export interface LocalRuntimeListing {
  runtimes: LocalRuntimeRecord[]
  errors: LocalRuntimeFileError[]
}

/**
 * Every lease file, including a legacy lease that a newer one supersedes, so
 * repair can clear stale files individually.
 */
export function readLocalRuntimeFiles(): LocalRuntimeFile[] {
  const files: LocalRuntimeFile[] = []
  const directory = getLocalRuntimeDirectory()
  let names: string[] = []
  try {
    names = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const read = (path: string, workspaceId: string | null) => {
    try {
      const runtime = readLocalRuntimeFile(path)
      if (runtime) files.push({ path, runtime, error: null })
    } catch (error) {
      files.push({ path, runtime: null, error: { path, workspaceId, error } })
    }
  }
  for (const name of names.sort()) {
    // Temporary writes end in .tmp and locks in .lock; quarantined files keep
    // a .corrupt- infix.
    if (!name.endsWith(".json") || name.includes(".corrupt-")) continue
    const stem = name.slice(0, -".json".length)
    read(join(directory, name), stem.startsWith("id-") ? null : stem)
  }
  read(getLegacyLocalRuntimePath(), null)
  return files
}

/** Every published lease, one per Worktable, and the files that could not be read. */
export function readLocalRuntimes(): LocalRuntimeListing {
  const runtimes: LocalRuntimeRecord[] = []
  const errors: LocalRuntimeFileError[] = []
  const legacyPath = getLegacyLocalRuntimePath()
  const files = readLocalRuntimeFiles()
  const legacy = files.find((file) => file.path === legacyPath)?.runtime ?? null
  let legacyListed = false
  for (const file of files) {
    if (file.error) errors.push(file.error)
    if (!file.runtime || file.path === legacyPath) continue
    // One lease per Worktable: the legacy lease stands in for this one only
    // while it is alive and this one is not.
    const chosen =
      legacy?.workspaceId === file.runtime.workspaceId
        ? preferredLocalRuntime(file.runtime, legacy)!
        : file.runtime
    if (chosen === legacy) legacyListed = true
    runtimes.push(chosen)
  }
  if (
    legacy &&
    !legacyListed &&
    !runtimes.some((runtime) => runtime.workspaceId === legacy.workspaceId)
  ) {
    runtimes.push(legacy)
  }
  return { runtimes, errors }
}

export function createLocalRuntimeRecord(input: {
  owner: LocalRuntimeOwner
  installId: string
  workspaceId: string
  workspacePath: string
  host: string
  port: number
  proofToken?: string
  /** null deliberately creates a legacy PID-only lease for compatibility tests. */
  ownerIdentity?: string | null
  now?: string
}): LocalRuntimeRecord {
  const ownerIdentity =
    input.ownerIdentity === undefined
      ? localProcessIdentity(process.pid)
      : input.ownerIdentity
  const record: LocalRuntimeRecord = {
    schemaVersion: LOCAL_HOST_SCHEMA_VERSION,
    owner: input.owner,
    pid: process.pid,
    ...(ownerIdentity ? { ownerIdentity } : {}),
    installId: input.installId,
    workspaceId: input.workspaceId,
    workspacePath: resolve(input.workspacePath),
    host: input.host,
    port: input.port,
    nonce: randomBytes(18).toString("base64url"),
    proofToken: input.proofToken ?? randomBytes(32).toString("base64url"),
    startedAt: input.now ?? new Date().toISOString(),
  }
  return parseRuntime(record)
}

/**
 * Publish a host's lease. The configured Worktable's host also publishes it in
 * the single-host `local-runtime.json` (`legacy`), which is all that older
 * releases sharing this app directory read, so they keep seeing that host.
 * The legacy file is never taken from another live host.
 */
export function writeLocalRuntime(
  record: LocalRuntimeRecord,
  options: { legacy?: boolean } = {}
): void {
  const parsed = parseRuntime(record)
  withLocalRuntimeFileLock(parsed.workspaceId, () => {
    writePrivateJson(getLocalRuntimePath(parsed.workspaceId), parsed)
  })
  try {
    withLocalRuntimeFileLock(undefined, () => {
      const legacyPath = getLegacyLocalRuntimePath()
      let legacy: LocalRuntimeRecord | null = null
      try {
        legacy = readLocalRuntimeFile(legacyPath)
      } catch {
        // An unreadable legacy lease is left for `local-host recover`.
        return
      }
      const legacyLive =
        legacy !== null &&
        legacy.pid !== parsed.pid &&
        localRuntimeProcessAlive(legacy)
      if (options.legacy && !legacyLive) {
        writePrivateJson(legacyPath, parsed)
      } else if (
        legacy?.workspaceId === parsed.workspaceId &&
        !legacyLive &&
        legacy.nonce !== parsed.nonce
      ) {
        // A dead lease an older release left for this Worktable is
        // superseded; remove it so it never reappears after this host exits.
        rmSync(legacyPath, { force: true })
      }
    })
  } catch {
    // The per-Worktable lease is published; the legacy copy is best effort.
  }
}

/**
 * Remove this process's own lease for a Worktable, and its legacy copy; a
 * newer owner's is kept.
 */
export function clearLocalRuntime(
  runtime: Pick<LocalRuntimeRecord, "workspaceId" | "nonce">
): boolean {
  const owned = (current: LocalRuntimeRecord | null) =>
    current !== null &&
    current.nonce === runtime.nonce &&
    current.pid === process.pid
  const cleared = withLocalRuntimeFileLock(runtime.workspaceId, () => {
    const path = getLocalRuntimePath(runtime.workspaceId)
    if (!owned(readLocalRuntimeFile(path))) return false
    rmSync(path, { force: true })
    return true
  })
  let legacyCleared = false
  try {
    legacyCleared = withLocalRuntimeFileLock(undefined, () => {
      const legacyPath = getLegacyLocalRuntimePath()
      if (!owned(readLocalRuntimeFile(legacyPath))) return false
      rmSync(legacyPath, { force: true })
      return true
    })
  } catch {
    // An unreadable legacy lease is left for `local-host recover`.
  }
  return cleared || legacyCleared
}

export function localProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

let currentProcessIdentity: string | null = null

/**
 * Return an OS-provided process-start identity that changes when a PID is
 * recycled. A failed identity query is intentionally inconclusive: callers
 * keep treating an otherwise-live PID as live rather than evicting its state.
 */
export function localProcessIdentity(pid: number): string | null {
  if (pid !== process.pid) return queryProcessIdentity(pid)
  // This process's own start identity never changes. Keep the first answer
  // so runtime writes and exit cleanup do not query the OS again. This stays
  // synchronous: the runtime file lock and the exit handler cannot await.
  currentProcessIdentity ??= queryProcessIdentity(pid)
  return currentProcessIdentity
}

function queryProcessIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const commandEnd = stat.lastIndexOf(")")
      if (commandEnd < 0) return null
      // Fields after the command begin at stat field 3. Process start time is
      // field 22, so it is index 19 in this suffix.
      const startedAtTicks = stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/)[19]
      return startedAtTicks && /^\d+$/.test(startedAtTicks)
        ? `linux:${startedAtTicks}`
        : null
    } catch {
      return null
    }
  }

  try {
    const command =
      process.platform === "win32"
        ? [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ]
        : ["ps", "-o", "lstart=", "-p", String(pid)]
    const result = spawnSync(command[0]!, command.slice(1), {
      env: { ...process.env, LC_ALL: "C" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (result.status !== 0) return null
    const startedAt = result.stdout.trim().replace(/\s+/g, " ")
    return startedAt ? `${process.platform}:${startedAt}` : null
  } catch {
    return null
  }
}

/**
 * Check that a runtime lease still belongs to the process that published it.
 * PID liveness alone is insufficient because operating systems recycle PIDs.
 * When process-start identity cannot be queried, remain conservative and treat
 * an otherwise-live PID as live rather than permitting a competing owner.
 */
export function localRuntimeProcessAlive(
  runtime: Pick<LocalRuntimeRecord, "pid" | "ownerIdentity">
): boolean {
  if (!localProcessAlive(runtime.pid)) return false
  if (!runtime.ownerIdentity) return true
  const currentIdentity = localProcessIdentity(runtime.pid)
  return currentIdentity === null || currentIdentity === runtime.ownerIdentity
}

/** Inspect the host serving one Worktable. */
export async function inspectLocalRuntimeDetailed(
  workspaceId: string,
  timeoutMs = 750
): Promise<LocalRuntimeInspection | null> {
  const runtime = readLocalRuntime(workspaceId)
  return runtime ? inspectLocalRuntimeLease(runtime, timeoutMs) : null
}

export interface LocalRuntimeInspections {
  runtimes: LocalRuntimeInspection[]
  errors: LocalRuntimeFileError[]
}

/** Inspect every published lease at once. */
export async function inspectLocalRuntimes(
  timeoutMs = 750
): Promise<LocalRuntimeInspections> {
  const listing = readLocalRuntimes()
  return {
    runtimes: await Promise.all(
      listing.runtimes.map((runtime) =>
        inspectLocalRuntimeLease(runtime, timeoutMs)
      )
    ),
    errors: listing.errors,
  }
}

/** Check one lease's process and endpoint proof. */
export async function inspectLocalRuntimeLease(
  runtime: LocalRuntimeRecord,
  timeoutMs = 750
): Promise<LocalRuntimeInspection> {
  const processAlive = localRuntimeProcessAlive(runtime)
  let endpointState: LocalRuntimeEndpointState = "unreachable"
  if (processAlive) {
    let response: Response | null = null
    try {
      response = await fetch(
        `${localHttpOrigin(runtime.host, runtime.port)}/health`,
        {
          headers: { [LOCAL_PROOF_HEADER]: runtime.proofToken },
          signal: AbortSignal.timeout(timeoutMs),
        }
      )
    } catch {
      endpointState = "unreachable"
    }
    if (response) {
      endpointState = "rejected"
      try {
        const body = (await response.json()) as unknown
        if (
          response.ok &&
          typeof body === "object" &&
          body !== null &&
          "service" in body &&
          body.service === "worktable" &&
          response.headers.get(LOCAL_PROOF_HEADER) === "verified"
        ) {
          endpointState = "verified"
        }
      } catch (error) {
        // A fully read malformed response is a rejection. An abort or body
        // stream failure is still transport-level and remains retryable.
        if (!(error instanceof SyntaxError)) endpointState = "unreachable"
      }
    }
  }
  const publicRuntime: Omit<
    LocalRuntimeRecord,
    "ownerIdentity" | "proofToken"
  > = {
    schemaVersion: runtime.schemaVersion,
    owner: runtime.owner,
    pid: runtime.pid,
    installId: runtime.installId,
    workspaceId: runtime.workspaceId,
    workspacePath: runtime.workspacePath,
    host: runtime.host,
    port: runtime.port,
    nonce: runtime.nonce,
    startedAt: runtime.startedAt,
  }
  return {
    ...publicRuntime,
    processAlive,
    endpointVerified: endpointState === "verified",
    endpointState,
  }
}

export async function inspectLocalRuntime(
  workspaceId: string,
  timeoutMs = 750
): Promise<LocalRuntimePublic | null> {
  const inspection = await inspectLocalRuntimeDetailed(workspaceId, timeoutMs)
  if (!inspection) return null
  const { endpointState: _, ...runtime } = inspection
  return runtime
}
