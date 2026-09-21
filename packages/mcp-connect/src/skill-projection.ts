import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import {
  isSkillProjectionTargetId,
  SKILL_PROJECTION_TARGET_IDS,
  SKILL_PROJECTION_TARGETS,
  type SkillProjectionTargetId,
} from "@worktable/types"

const MANIFEST_VERSION = 2
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const STALE_LOCK_AGE_MS = 5 * 60 * 1000
const LIFECYCLE_LOCK_KEY = "lifecycle"

export type SkillProjectionOperation =
  | "install"
  | "update"
  | "repair"
  | "remove"

export const SKILL_PROJECTION_OPERATIONS: SkillProjectionOperation[] = [
  "install",
  "update",
  "repair",
  "remove",
]

export type SkillProjectionState =
  | "not-installed"
  | "current"
  | "outdated"
  | "missing"
  | "locally-modified"
  | "conflict"
  | "incomplete"

export interface SkillProjectionEnvironment {
  homeDir: string
  appDataDir: string
  sourceDir: string
  sourceVersion: string
  /** Test-only interruption hook. Production callers leave this unset. */
  interruptAfter?:
    | "journal"
    | "backup"
    | "materialize"
    | "manifest-removal"
    | "manifest"
    | "stage-cleanup"
  /** Test-only race hook, invoked after staging and before the final recheck. */
  beforeMutationCheck?: () => void
  /** Test-only race hook, invoked after an owned directory moves to backup. */
  afterBackupMoved?: (backupPath: string) => void
  /** Test-only concurrency hook, invoked while the per-target mutation lock is held. */
  afterLockAcquired?: () => void
  /** Test-only handoff hook, invoked after uninstall releases its lifecycle lock. */
  afterLifecycleLockReleased?: () => void
}

export interface SkillProjectionRequest {
  targetId: SkillProjectionTargetId
  operation: SkillProjectionOperation
}

export interface SkillTreeDigest {
  name: string
  digest: string
}

export interface SkillSourceInventory {
  sourceDir: string
  sourceVersion: string
  packageDigest: string
  skills: SkillTreeDigest[]
}

export interface SkillProjectionStatus {
  targetId: SkillProjectionTargetId
  label: string
  state: SkillProjectionState
  detail: string
  targetRoot: string
  resolvedTargetRoot: string
  sourcePackageDigest: string | null
  installedPackageDigest: string | null
  missingSkills: string[]
  modifiedSkills: string[]
  allowedOperations: SkillProjectionOperation[]
}

export type SkillProjectionAction =
  | "none"
  | "write"
  | "replace"
  | "restore-missing"
  | "remove"

export interface SkillProjectionPreview {
  schemaVersion: 2
  planId: string
  request: SkillProjectionRequest
  status: SkillProjectionStatus
  action: SkillProjectionAction
  allowed: boolean
  changes: string[]
  source: SkillSourceInventory | null
}

export interface SkillProjectionResult extends SkillProjectionPreview {
  applied: boolean
  recoveredInterruptedTransaction: boolean
  statusAfter: SkillProjectionStatus
}

export interface RemovedSkillProjection {
  targetRoot: string
  targetId: SkillProjectionTargetId
  skillPaths: string[]
}

export interface PreservedSkillProjection {
  targetRoot: string
  targetId: SkillProjectionTargetId
  modifiedSkillPaths: string[]
  missingSkillPaths: string[]
}

export interface SkillProjectionUninstallResult {
  removed: RemovedSkillProjection[]
  preserved: PreservedSkillProjection[]
}

interface ProjectionManifest {
  schemaVersion: 2
  targetId: SkillProjectionTargetId
  logicalTargetRoot: string
  resolvedTargetRoot: string
  sourceVersion: string
  sourcePackageDigest: string
  skills: SkillTreeDigest[]
  materialization: "copy"
  installedAt: string
  updatedAt: string
  transactionId: string
}

interface TransactionJournal {
  schemaVersion: 2
  transactionId: string
  targetKey: string
  operation: SkillProjectionOperation
  targetRoot: string
  stageDir: string
  skillNames: string[]
  incomingSkills: SkillTreeDigest[]
  manifestBefore: ProjectionManifest | null
  missingBefore: string[]
  removesManifest?: true
  manifestRemovalCommitted?: true
}

interface TargetResolution {
  targetId: SkillProjectionTargetId
  logicalRoot: string
  resolvedRoot: string
  targetKey: string
}

interface Inspection {
  missing: string[]
  modified: string[]
}

export class SkillProjectionError extends Error {
  readonly code:
    | "invalid-request"
    | "unsupported-target"
    | "unsafe-source"
    | "unsafe-target"
    | "stale-plan"
    | "conflict"
    | "interrupted"

  constructor(
    code:
      | "invalid-request"
      | "unsupported-target"
      | "unsafe-source"
      | "unsafe-target"
      | "stale-plan"
      | "conflict"
      | "interrupted",
    message: string
  ) {
    super(message)
    this.code = code
    this.name = "SkillProjectionError"
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const fd = openSync(temp, "wx", 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch (error) {
    throw new SkillProjectionError(
      "conflict",
      `Worktable's skill installation state at ${path} is invalid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function hashTree(root: string): string {
  const hash = createHash("sha256")
  const caseFoldedPaths = new Set<string>()
  const visit = (absolute: string, rel: string): void => {
    const info = lstatSync(absolute)
    if (info.isSymbolicLink()) {
      throw new SkillProjectionError(
        "unsafe-source",
        `Skill trees may not contain symbolic links (${rel || absolute}).`
      )
    }
    const normalized = rel.split("\\").join("/")
    if (normalized) {
      const caseFolded = normalized.toLowerCase()
      if (caseFoldedPaths.has(caseFolded)) {
        throw new SkillProjectionError(
          "unsafe-source",
          `Skill trees may not contain case-conflicting paths (${normalized}).`
        )
      }
      caseFoldedPaths.add(caseFolded)
    }
    if (info.isDirectory()) {
      hash.update(`d\0${normalized}\0`)
      for (const name of readdirSync(absolute).sort(compareStrings)) {
        visit(join(absolute, name), rel ? join(rel, name) : name)
      }
      return
    }
    if (!info.isFile()) {
      throw new SkillProjectionError(
        "unsafe-source",
        `Skill trees may contain only directories and regular files (${normalized}).`
      )
    }
    const body = readFileSync(absolute)
    const executable = (info.mode & 0o111) === 0 ? "0" : "1"
    hash.update(`f\0${normalized}\0${executable}\0${body.length}\0`)
    hash.update(body)
    hash.update("\0")
  }
  visit(root, "")
  return hash.digest("hex")
}

export function inspectSkillSource(
  env: SkillProjectionEnvironment
): SkillSourceInventory {
  const sourceDir = resolve(env.sourceDir)
  if (!isAbsolute(env.sourceDir) || !existsSync(sourceDir)) {
    throw new SkillProjectionError(
      "unsafe-source",
      `The Worktable skill source is missing: ${sourceDir}`
    )
  }
  const rootInfo = lstatSync(sourceDir)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new SkillProjectionError(
      "unsafe-source",
      `The Worktable skill source must be a real directory: ${sourceDir}`
    )
  }
  const names = readdirSync(sourceDir).sort(compareStrings)
  if (names.length === 0) {
    throw new SkillProjectionError(
      "unsafe-source",
      `The Worktable skill source is empty: ${sourceDir}`
    )
  }
  const folded = new Set<string>()
  const skills = names.map((name) => {
    if (!SKILL_NAME.test(name) || folded.has(name.toLowerCase())) {
      throw new SkillProjectionError(
        "unsafe-source",
        `Invalid or case-conflicting skill directory: ${name}`
      )
    }
    folded.add(name.toLowerCase())
    const skillDir = join(sourceDir, name)
    const info = lstatSync(skillDir)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new SkillProjectionError(
        "unsafe-source",
        `Each skill must be a real directory: ${skillDir}`
      )
    }
    const skillFile = join(skillDir, "SKILL.md")
    if (!existsSync(skillFile) || !lstatSync(skillFile).isFile()) {
      throw new SkillProjectionError(
        "unsafe-source",
        `Each skill must contain a regular SKILL.md file: ${skillDir}`
      )
    }
    return { name, digest: hashTree(skillDir) }
  })
  return {
    sourceDir,
    sourceVersion: env.sourceVersion,
    packageDigest: sha256(stableJson(skills)),
    skills,
  }
}

function resolvedThroughExistingAncestor(path: string): string {
  const missing: string[] = []
  let cursor = resolve(path)
  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) {
      throw new SkillProjectionError(
        "unsafe-target",
        `Could not resolve a safe ancestor for ${path}.`
      )
    }
    missing.unshift(basename(cursor))
    cursor = parent
  }
  const info = lstatSync(cursor)
  if (!info.isDirectory()) {
    throw new SkillProjectionError(
      "unsafe-target",
      `The nearest existing target ancestor is not a directory: ${cursor}`
    )
  }
  return join(realpathSync(cursor), ...missing)
}

function resolveTarget(
  request: SkillProjectionRequest,
  env: SkillProjectionEnvironment
): TargetResolution {
  if (!isSkillProjectionTargetId(request.targetId)) {
    throw new SkillProjectionError(
      "unsupported-target",
      `Unknown skill installation target: ${request.targetId}`
    )
  }
  if (!isAbsolute(env.homeDir)) {
    throw new SkillProjectionError(
      "invalid-request",
      "The user home directory must be absolute."
    )
  }
  const base = resolve(env.homeDir)
  const relativeRoot =
    SKILL_PROJECTION_TARGETS[request.targetId].physicalRoot.split("/")
  const logicalRoot = join(base, ...relativeRoot)
  const resolvedRoot = resolvedThroughExistingAncestor(logicalRoot)
  const targetKey = projectionTargetKey(request.targetId, resolvedRoot)
  return { targetId: request.targetId, logicalRoot, resolvedRoot, targetKey }
}

function projectionTargetKey(
  targetId: SkillProjectionTargetId,
  resolvedRoot: string
): string {
  return sha256(`${targetId}\0${resolvedRoot}`).slice(0, 32)
}

function stateRoot(env: SkillProjectionEnvironment): string {
  if (!isAbsolute(env.appDataDir)) {
    throw new SkillProjectionError(
      "invalid-request",
      "The Worktable app-data directory must be absolute."
    )
  }
  return join(resolve(env.appDataDir), "agent-skills")
}

function manifestPath(
  env: SkillProjectionEnvironment,
  targetKey: string
): string {
  return join(stateRoot(env), "projections", "v2", `${targetKey}.json`)
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function validTransactionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value
    )
  )
}

function validateSkillDigests(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {}
): SkillTreeDigest[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    throw new SkillProjectionError("conflict", `${label} has no skill entries.`)
  }
  const names = new Set<string>()
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      !("name" in item) ||
      typeof item.name !== "string" ||
      !SKILL_NAME.test(item.name) ||
      names.has(item.name) ||
      !("digest" in item) ||
      !validDigest(item.digest)
    ) {
      throw new SkillProjectionError(
        "conflict",
        `${label} contains an invalid or duplicate skill entry.`
      )
    }
    names.add(item.name)
  }
  return value as SkillTreeDigest[]
}

function validateJournal(
  journal: TransactionJournal,
  target: TargetResolution
): TransactionJournal {
  const candidate = journal as Partial<TransactionJournal>
  const operation = candidate.operation
  if (
    candidate.schemaVersion !== MANIFEST_VERSION ||
    candidate.targetKey !== target.targetKey ||
    candidate.targetRoot !== target.resolvedRoot ||
    !validTransactionId(candidate.transactionId) ||
    !operation ||
    !["install", "update", "repair", "remove"].includes(operation) ||
    candidate.stageDir !==
      join(target.resolvedRoot, `.worktable-${candidate.transactionId}`) ||
    !Array.isArray(candidate.skillNames) ||
    !candidate.skillNames.every(
      (name) => typeof name === "string" && SKILL_NAME.test(name)
    ) ||
    new Set(candidate.skillNames).size !== candidate.skillNames.length
  ) {
    throw new SkillProjectionError(
      "conflict",
      "The interrupted skill transaction does not match the allowlisted target."
    )
  }
  const incoming = validateSkillDigests(
    candidate.incomingSkills,
    "Worktable's interrupted transaction",
    { allowEmpty: true }
  )
  if (incoming.some((skill) => !candidate.skillNames!.includes(skill.name))) {
    throw new SkillProjectionError(
      "conflict",
      "The interrupted skill transaction contains an unexpected incoming path."
    )
  }
  const missingBefore = candidate.missingBefore ?? []
  if (
    !Array.isArray(missingBefore) ||
    new Set(missingBefore).size !== missingBefore.length ||
    !missingBefore.every(
      (name) =>
        typeof name === "string" &&
        SKILL_NAME.test(name) &&
        candidate.skillNames!.includes(name)
    )
  ) {
    throw new SkillProjectionError(
      "conflict",
      "The interrupted skill transaction contains invalid missing-path evidence."
    )
  }
  if (candidate.manifestBefore !== null) {
    if (
      !candidate.manifestBefore ||
      typeof candidate.manifestBefore !== "object"
    ) {
      throw new SkillProjectionError(
        "conflict",
        "The interrupted skill transaction has no valid prior ownership record."
      )
    }
    validateManifest(candidate.manifestBefore as ProjectionManifest, target)
    const priorNames = new Set(
      candidate.manifestBefore.skills.map(({ name }) => name)
    )
    if (missingBefore.some((name) => !priorNames.has(name))) {
      throw new SkillProjectionError(
        "conflict",
        "The interrupted skill transaction has unexpected missing-path evidence."
      )
    }
  } else if (missingBefore.length > 0) {
    throw new SkillProjectionError(
      "conflict",
      "A new installation cannot claim prior missing owned paths."
    )
  }
  if (
    candidate.removesManifest !== undefined &&
    (candidate.removesManifest !== true ||
      candidate.operation !== "remove" ||
      !candidate.manifestBefore ||
      candidate.incomingSkills!.length > 0)
  ) {
    throw new SkillProjectionError(
      "conflict",
      "The interrupted skill transaction contains invalid manifest-removal evidence."
    )
  }
  if (
    candidate.manifestRemovalCommitted !== undefined &&
    (candidate.manifestRemovalCommitted !== true ||
      candidate.removesManifest !== true)
  ) {
    throw new SkillProjectionError(
      "conflict",
      "The interrupted skill transaction contains invalid manifest-removal commit evidence."
    )
  }
  if (
    candidate.skillNames.length === 0 &&
    !(
      candidate.operation === "remove" &&
      candidate.removesManifest === true &&
      candidate.manifestBefore
    )
  ) {
    throw new SkillProjectionError(
      "conflict",
      "The interrupted skill transaction has no owned skill paths."
    )
  }
  return { ...journal, missingBefore }
}

function journalPath(
  env: SkillProjectionEnvironment,
  targetKey: string
): string {
  return join(stateRoot(env), "transactions", `${targetKey}.json`)
}

function lockPath(env: SkillProjectionEnvironment, targetKey: string): string {
  if (targetKey === LIFECYCLE_LOCK_KEY) {
    return join(dirname(stateRoot(env)), "agent-skills-lifecycle.lock")
  }
  return join(stateRoot(env), "locks", `${targetKey}.lock`)
}

function removeDirectoryContentsExcept(
  directory: string,
  preservedName: string
): void {
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) {
    if (name === preservedName) continue
    rmSync(join(directory, name), { recursive: true, force: true })
  }
}

function assertSafeAppDataRootForUninstall(
  env: SkillProjectionEnvironment
): string {
  const appDataDir = resolve(env.appDataDir)
  if (!isAbsolute(env.appDataDir) || dirname(appDataDir) === appDataDir) {
    throw new SkillProjectionError(
      "invalid-request",
      "The Worktable app-data directory must be an absolute path below the filesystem root."
    )
  }
  if (!existsSync(appDataDir)) return appDataDir
  const info = lstatSync(appDataDir)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SkillProjectionError(
      "unsafe-target",
      `Worktable cannot safely remove a linked or non-directory app-data root: ${appDataDir}`
    )
  }
  return appDataDir
}

function removeAppDataPreservingLifecycleLock(
  env: SkillProjectionEnvironment
): void {
  // Recheck at the destructive step so replacing the preflighted root with a
  // symlink cannot redirect recursive deletion into an unrelated directory.
  const appDataDir = assertSafeAppDataRootForUninstall(env)
  const lifecycleLock = lockPath(env, LIFECYCLE_LOCK_KEY)
  if (!existsSync(lifecycleLock)) {
    throw new SkillProjectionError(
      "stale-plan",
      "The Worktable skill lifecycle lock disappeared during uninstall."
    )
  }
  removeDirectoryContentsExcept(appDataDir, basename(lifecycleLock))
}

function removeEmptyAppDataDir(env: SkillProjectionEnvironment): void {
  const appDataDir = resolve(env.appDataDir)
  try {
    rmdirSync(appDataDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error
    }
    // A post-release install may have recreated state. Its new lifecycle owns
    // the directory, so uninstall leaves the non-empty tree alone.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function processStartIdentity(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/)
      const startTicks = fields[19]
      return startTicks ? `linux:${startTicks}` : null
    } catch {
      return null
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    })
    const startedAt = result.status === 0 ? result.stdout.trim() : ""
    return startedAt ? `darwin:${startedAt}` : null
  }
  return null
}

function clearStaleLock(path: string): boolean {
  let info
  try {
    info = statSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
  let pid: number | null = null
  let processIdentity: string | null = null
  try {
    const owner = JSON.parse(readFileSync(path, "utf8")) as {
      pid?: unknown
      processIdentity?: unknown
    }
    if (Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0) {
      pid = Number(owner.pid)
    }
    if (typeof owner.processIdentity === "string") {
      processIdentity = owner.processIdentity
    }
  } catch {
    // A partial lock is reclaimable only once its grace period has elapsed.
  }
  const staleByAge = Date.now() - info.mtimeMs >= STALE_LOCK_AGE_MS
  if (pid !== null) {
    if (processIsAlive(pid)) {
      const currentIdentity = processStartIdentity(pid)
      // An operation can legitimately run longer than the stale-age grace
      // period. A matching process birth owns the lock until that process
      // exits; a differing birth proves that the PID has been reused.
      if (
        !processIdentity ||
        !currentIdentity ||
        processIdentity === currentIdentity
      ) {
        return false
      }
    }
  } else if (!staleByAge) {
    return false
  }
  const stale = `${path}.${randomUUID()}.stale`
  try {
    renameSync(path, stale)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    return false
  }
  rmSync(stale, { force: true })
  return true
}

function acquireTargetLock(
  env: SkillProjectionEnvironment,
  targetKey: string
): () => void {
  const path = lockPath(env, targetKey)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const processIdentity = processStartIdentity(process.pid)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number
    try {
      fd = openSync(path, "wx", 0o600)
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST" &&
        attempt === 0 &&
        clearStaleLock(path)
      ) {
        continue
      }
      throw new SkillProjectionError(
        "stale-plan",
        "Another Worktable skill operation is already in progress for this target. Try again after it finishes."
      )
    }
    try {
      writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, processIdentity, token, acquiredAt: new Date().toISOString() })}\n`
      )
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return () => {
      try {
        const owner = JSON.parse(readFileSync(path, "utf8")) as {
          token?: unknown
        }
        if (owner.token === token) rmSync(path, { force: true })
      } catch {
        // Never remove a lock that no longer proves this operation owns it.
      }
    }
  }
  throw new SkillProjectionError(
    "stale-plan",
    "Another Worktable skill operation is already in progress for this target."
  )
}

function validateManifest(
  manifest: ProjectionManifest | null,
  target: TargetResolution
): ProjectionManifest | null {
  if (!manifest) return null
  const candidate = manifest as Partial<ProjectionManifest>
  if (
    candidate.schemaVersion !== MANIFEST_VERSION ||
    candidate.targetId !== target.targetId ||
    typeof candidate.logicalTargetRoot !== "string" ||
    !isAbsolute(candidate.logicalTargetRoot) ||
    resolve(candidate.logicalTargetRoot) !== candidate.logicalTargetRoot ||
    resolvedThroughExistingAncestor(candidate.logicalTargetRoot) !==
      target.resolvedRoot ||
    candidate.resolvedTargetRoot !== target.resolvedRoot ||
    candidate.materialization !== "copy" ||
    !validDigest(candidate.sourcePackageDigest) ||
    typeof candidate.sourceVersion !== "string" ||
    typeof candidate.installedAt !== "string" ||
    typeof candidate.updatedAt !== "string" ||
    !validTransactionId(candidate.transactionId)
  ) {
    throw new SkillProjectionError(
      "conflict",
      `Worktable's ownership manifest does not match the resolved target ${target.logicalRoot}.`
    )
  }
  const skills = validateSkillDigests(
    candidate.skills,
    "Worktable's ownership manifest"
  )
  if (sha256(stableJson(skills)) !== candidate.sourcePackageDigest) {
    throw new SkillProjectionError(
      "conflict",
      "Worktable's ownership manifest package digest is invalid."
    )
  }
  return manifest
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function inspectProjection(
  manifest: ProjectionManifest,
  target: TargetResolution
): Inspection {
  const missing: string[] = []
  const modified: string[] = []
  for (const skill of manifest.skills) {
    const path = join(target.resolvedRoot, skill.name)
    try {
      const info = lstatSync(path)
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        hashTree(path) !== skill.digest
      ) {
        modified.push(skill.name)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(skill.name)
      } else {
        modified.push(skill.name)
      }
    }
  }
  return { missing, modified }
}

function unmanagedConflicts(
  source: SkillSourceInventory,
  target: TargetResolution
): string[] {
  return source.skills
    .filter((skill) => pathEntryExists(join(target.resolvedRoot, skill.name)))
    .map((skill) => skill.name)
}

function overlappingProjectionDetail(
  target: TargetResolution,
  env: SkillProjectionEnvironment
): string | null {
  const projectionsDir = join(stateRoot(env), "projections", "v2")
  if (existsSync(projectionsDir)) {
    for (const name of readdirSync(projectionsDir).sort(compareStrings)) {
      const match = /^([a-f0-9]{32})\.json$/.exec(name)
      if (!match || match[1] === target.targetKey) continue
      const stored = readJson<ProjectionManifest>(join(projectionsDir, name))
      if (!stored || stored.resolvedTargetRoot !== target.resolvedRoot) continue
      const otherTarget = targetFromStoredManifest(stored, match[1]!, env)
      validateManifest(stored, otherTarget)
      return `${target.resolvedRoot} is already managed through the ${otherTarget.targetId} skills target. Remove it there before using this target.`
    }
  }

  const transactionsDir = join(stateRoot(env), "transactions")
  if (existsSync(transactionsDir)) {
    for (const name of readdirSync(transactionsDir).sort(compareStrings)) {
      const match = /^([a-f0-9]{32})\.json$/.exec(name)
      if (!match || match[1] === target.targetKey) continue
      const stored = readJson<TransactionJournal>(join(transactionsDir, name))
      if (!stored || stored.targetRoot !== target.resolvedRoot) continue
      const otherTarget = targetFromStoredJournal(stored, match[1]!, env)
      validateJournal(stored, otherTarget)
      return `A previous change to ${target.resolvedRoot} did not finish through the ${otherTarget.targetId} skills target. Repair or remove it there before using this target.`
    }
  }
  return null
}

function readState(
  request: SkillProjectionRequest,
  env: SkillProjectionEnvironment
): {
  target: TargetResolution
  source: SkillSourceInventory | null
  manifest: ProjectionManifest | null
  status: SkillProjectionStatus
} {
  const target = resolveTarget(request, env)
  let source: SkillSourceInventory | null = null
  let sourceError: string | null = null
  try {
    source = inspectSkillSource(env)
  } catch (error) {
    sourceError = error instanceof Error ? error.message : String(error)
  }

  const common = {
    targetId: request.targetId,
    label: SKILL_PROJECTION_TARGETS[request.targetId].label,
    targetRoot: target.logicalRoot,
    resolvedTargetRoot: target.resolvedRoot,
    sourcePackageDigest: source?.packageDigest ?? null,
    missingSkills: [] as string[],
    modifiedSkills: [] as string[],
    allowedOperations: [] as SkillProjectionOperation[],
  }

  const overlapDetail = overlappingProjectionDetail(target, env)
  if (overlapDetail) {
    return withAllowedOperations(request, {
      target,
      source,
      manifest: null,
      status: {
        ...common,
        state: "conflict",
        detail: overlapDetail,
        installedPackageDigest: null,
      },
    })
  }

  const manifest = validateManifest(
    readJson<ProjectionManifest>(manifestPath(env, target.targetKey)),
    target
  )

  if (existsSync(journalPath(env, target.targetKey))) {
    return withAllowedOperations(request, {
      target,
      source,
      manifest,
      status: {
        ...common,
        state: "incomplete",
        detail:
          "A previous Worktable skill change did not finish. Repair it before making another change.",
        installedPackageDigest: manifest?.sourcePackageDigest ?? null,
      },
    })
  }

  if (!manifest) {
    const conflicts = source ? unmanagedConflicts(source, target) : []
    return withAllowedOperations(request, {
      target,
      source,
      manifest,
      status: {
        ...common,
        state: conflicts.length > 0 ? "conflict" : "not-installed",
        detail:
          conflicts.length > 0
            ? `Worktable won’t replace existing folders it doesn’t manage: ${conflicts.join(", ")}.`
            : source
              ? "Worktable skills are not installed in this folder."
              : `Worktable skills are not installed, and this Worktable installation can’t find the skill package: ${sourceError ?? "unknown error"}`,
        installedPackageDigest: null,
      },
    })
  }

  const inspection = inspectProjection(manifest, target)
  const ownedNames = new Set(manifest.skills.map((skill) => skill.name))
  const addedSourceConflicts =
    source?.skills
      .filter(
        (skill) =>
          !ownedNames.has(skill.name) &&
          pathEntryExists(join(target.resolvedRoot, skill.name))
      )
      .map((skill) => skill.name) ?? []

  let state: SkillProjectionState
  let detail: string
  if (inspection.modified.length > 0 && inspection.missing.length > 0) {
    state = "locally-modified"
    detail = `Some Worktable skills are missing and others were changed outside Worktable. Missing: ${inspection.missing.join(", ")}. Changed: ${inspection.modified.join(", ")}.`
  } else if (inspection.modified.length > 0) {
    state = "locally-modified"
    detail = `Some Worktable skills were changed outside Worktable: ${inspection.modified.join(", ")}. They won’t be overwritten.`
  } else if (addedSourceConflicts.length > 0) {
    state = "conflict"
    detail = `An update would replace existing folders Worktable doesn’t manage: ${addedSourceConflicts.join(", ")}.`
  } else if (inspection.missing.length > 0) {
    state = "missing"
    detail = `Some installed Worktable skills are missing: ${inspection.missing.join(", ")}.`
  } else if (source && manifest.sourcePackageDigest !== source.packageDigest) {
    state = "outdated"
    detail = "A newer Worktable skill package is available."
  } else {
    state = "current"
    detail = source
      ? "Installed skills match this Worktable release."
      : `The installed skills are unchanged, but this Worktable installation can’t find the skill package to check for updates: ${sourceError ?? "unknown error"}`
  }

  return withAllowedOperations(request, {
    target,
    source,
    manifest,
    status: {
      ...common,
      state,
      detail,
      installedPackageDigest: manifest.sourcePackageDigest,
      missingSkills: inspection.missing,
      modifiedSkills: inspection.modified,
    },
  })
}

function withAllowedOperations(
  request: SkillProjectionRequest,
  state: ReturnType<typeof readState>
): ReturnType<typeof readState> {
  state.status.allowedOperations = SKILL_PROJECTION_OPERATIONS.filter(
    (operation) =>
      planAction(
        { targetId: request.targetId, operation },
        state.status,
        state.manifest,
        state.source
      ).allowed
  )
  return state
}

export function getSkillProjectionStatus(
  request: Omit<SkillProjectionRequest, "operation">,
  env: SkillProjectionEnvironment
): SkillProjectionStatus {
  return readState({ ...request, operation: "install" }, env).status
}

function planAction(
  request: SkillProjectionRequest,
  status: SkillProjectionStatus,
  manifest: ProjectionManifest | null,
  source: SkillSourceInventory | null
): Pick<SkillProjectionPreview, "action" | "allowed" | "changes"> {
  const blocked = (message = status.detail) => ({
    action: "none" as const,
    allowed: false,
    changes: [message],
  })
  const skillNames = source?.skills.map((skill) => skill.name) ?? []

  switch (request.operation) {
    case "install":
      if (status.state !== "not-installed" || !source) return blocked()
      return {
        action: "write",
        allowed: true,
        changes: skillNames.map((name) => `Add ${name}.`),
      }

    case "update":
      if (status.state !== "outdated" || !manifest || !source) {
        return blocked(
          status.state === "not-installed"
            ? "Nothing is installed; use install first."
            : status.state === "current"
              ? "The installed package is already current."
              : status.detail
        )
      }
      return {
        action: "replace",
        allowed: true,
        changes: [
          `Replace ${manifest.skills.length} unchanged Worktable skill folders with the latest versions.`,
        ],
      }

    case "repair":
      if (status.state === "incomplete") {
        return {
          action: "restore-missing",
          allowed: true,
          changes: [
            "Finish recovering the previous change, then create a fresh repair plan.",
          ],
        }
      }
      if (
        status.state === "missing" &&
        source &&
        manifest?.sourcePackageDigest === source.packageDigest
      ) {
        return {
          action: "restore-missing",
          allowed: true,
          changes: [
            `Restore ${status.missingSkills.length} missing Worktable skill ${status.missingSkills.length === 1 ? "folder" : "folders"}.`,
          ],
        }
      }
      return blocked(
        status.state === "outdated"
          ? "The installed package is intact but outdated; use update."
          : status.state === "current"
            ? "The installed package does not need repair."
            : status.detail
      )

    case "remove": {
      if (status.state === "incomplete") {
        return {
          action: "remove",
          allowed: true,
          changes: [
            "Finish recovering the previous change, then remove unchanged Worktable skill folders and stop managing this location.",
          ],
        }
      }
      if (!manifest) return blocked("Nothing is installed at this target.")
      const preserved = new Set([
        ...status.missingSkills,
        ...status.modifiedSkills,
      ])
      const removable = manifest.skills.filter(
        (skill) => !preserved.has(skill.name)
      )
      return {
        action: "remove",
        allowed: true,
        changes: [
          ...removable.map((skill) => `Remove unchanged folder ${skill.name}.`),
          ...status.modifiedSkills.map(
            (name) => `Keep locally changed folder ${name}.`
          ),
          ...status.missingSkills.map(
            (name) => `Leave already-missing folder ${name} unchanged.`
          ),
        ],
      }
    }
  }
}

export function previewSkillProjection(
  request: SkillProjectionRequest,
  env: SkillProjectionEnvironment
): SkillProjectionPreview {
  return readProjectionPlan(request, env).preview
}

function readProjectionPlan(
  request: SkillProjectionRequest,
  env: SkillProjectionEnvironment
): ReturnType<typeof readState> & { preview: SkillProjectionPreview } {
  const state = readState(request, env)
  const { status, manifest, source } = state
  const planned = planAction(request, status, manifest, source)
  const material = {
    schemaVersion: MANIFEST_VERSION,
    request,
    status,
    action: planned.action,
    allowed: planned.allowed,
    changes: planned.changes,
    source,
  }
  const preview: SkillProjectionPreview = {
    schemaVersion: MANIFEST_VERSION,
    planId: sha256(stableJson(material)),
    request,
    status,
    ...planned,
    source,
  }
  return { ...state, preview }
}

function copySkills(
  sourceDir: string,
  skills: SkillTreeDigest[],
  destination: string
): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const skill of skills) {
    cpSync(join(sourceDir, skill.name), join(destination, skill.name), {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
      preserveTimestamps: false,
    })
  }
  for (const skill of skills) {
    const path = join(destination, skill.name)
    const info = lstatSync(path)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      hashTree(path) !== skill.digest
    ) {
      throw new SkillProjectionError(
        "conflict",
        `The source for ${skill.name} changed while the skill plan was being materialized.`
      )
    }
  }
}

function maybeInterrupt(
  env: SkillProjectionEnvironment,
  phase: SkillProjectionEnvironment["interruptAfter"]
): void {
  if (env.interruptAfter === phase) {
    throw new SkillProjectionError(
      "interrupted",
      `Injected skill transaction interruption after ${phase}.`
    )
  }
}

function removeManifest(
  env: SkillProjectionEnvironment,
  targetKey: string
): void {
  rmSync(manifestPath(env, targetKey), { force: true })
}

function recoverTransaction(
  target: TargetResolution,
  env: SkillProjectionEnvironment
): boolean {
  const path = journalPath(env, target.targetKey)
  const loaded = readJson<TransactionJournal>(path)
  if (!loaded) return false
  const journal = validateJournal(loaded, target)
  const current = validateManifest(
    readJson<ProjectionManifest>(manifestPath(env, target.targetKey)),
    target
  )
  const backupDir = join(journal.stageDir, "backup")
  const previousByName = new Map(
    journal.manifestBefore?.skills.map((skill) => [skill.name, skill.digest]) ??
      []
  )
  const manifestRemovalDestinationsAbsent =
    journal.removesManifest === true &&
    !current &&
    journal.skillNames.every((name) => {
      const expected = previousByName.get(name)
      const destination = join(target.resolvedRoot, name)
      return Boolean(expected) && !pathEntryExists(destination)
    })
  const exactManifestRemovalBackups =
    manifestRemovalDestinationsAbsent &&
    journal.skillNames.every((name) => {
      const expected = previousByName.get(name)!
      const backup = join(backupDir, name)
      if (!pathEntryExists(backup)) return false
      const info = lstatSync(backup)
      return (
        info.isDirectory() &&
        !info.isSymbolicLink() &&
        hashTree(backup) === expected
      )
    })
  const committedManifestRemoval =
    manifestRemovalDestinationsAbsent &&
    (journal.manifestRemovalCommitted === true || exactManifestRemovalBackups)
  if (
    current?.transactionId === journal.transactionId ||
    committedManifestRemoval
  ) {
    rmSync(journal.stageDir, { recursive: true, force: true })
    rmSync(path, { force: true })
    return true
  }
  const incomingByName = new Map(
    journal.incomingSkills.map((skill) => [skill.name, skill.digest])
  )
  const missingBefore = new Set(journal.missingBefore)
  // Validate every previously owned path whose backup disappeared before
  // restoring any sibling. Otherwise a later conflict could leave an earlier
  // sibling rolled back while the only valid incoming tree remains elsewhere.
  for (const name of journal.skillNames) {
    const previous = previousByName.get(name)
    if (!previous || missingBefore.has(name)) continue
    const backup = join(backupDir, name)
    if (pathEntryExists(backup)) continue
    const destination = join(target.resolvedRoot, name)
    if (!pathEntryExists(destination)) {
      throw new SkillProjectionError(
        "conflict",
        `Interrupted recovery cannot restore the missing directory ${destination}.`
      )
    }
    const info = lstatSync(destination)
    const observed =
      info.isDirectory() && !info.isSymbolicLink()
        ? hashTree(destination)
        : null
    if (observed === previous) continue
    const incoming = incomingByName.get(name)
    if (incoming && observed === incoming) {
      throw new SkillProjectionError(
        "conflict",
        `Interrupted recovery cannot restore ${destination} because its transaction backup is missing; the exact incoming directory was preserved.`
      )
    }
    throw new SkillProjectionError(
      "conflict",
      `Interrupted recovery will not overwrite the changed directory ${destination}.`
    )
  }
  for (const name of journal.skillNames) {
    const destination = join(target.resolvedRoot, name)
    const backup = join(backupDir, name)
    if (pathEntryExists(backup)) {
      if (pathEntryExists(destination)) {
        const info = lstatSync(destination)
        const observed =
          info.isDirectory() && !info.isSymbolicLink()
            ? hashTree(destination)
            : null
        const incoming = incomingByName.get(name)
        if (!incoming || observed !== incoming) {
          throw new SkillProjectionError(
            "conflict",
            `Interrupted recovery will not overwrite the changed directory ${destination}.`
          )
        }
        rmSync(destination, { recursive: true, force: true })
      }
      renameSync(backup, destination)
    } else if (pathEntryExists(destination)) {
      const info = lstatSync(destination)
      const observed =
        info.isDirectory() && !info.isSymbolicLink()
          ? hashTree(destination)
          : null
      const previous = previousByName.get(name)
      const incoming = incomingByName.get(name)
      if (missingBefore.has(name)) {
        if (!incoming || observed !== incoming) {
          throw new SkillProjectionError(
            "conflict",
            `Interrupted recovery will not overwrite the changed directory ${destination}.`
          )
        }
        rmSync(destination, { recursive: true, force: true })
        continue
      }
      if (previous && observed === previous) {
        // The transaction stopped after journaling but before this owned
        // directory was renamed. It is already the exact prior payload.
        continue
      }
      if (!incoming || observed !== incoming) {
        throw new SkillProjectionError(
          "conflict",
          `Interrupted recovery will not overwrite the changed directory ${destination}.`
        )
      }
      if (previous) {
        throw new SkillProjectionError(
          "conflict",
          `Interrupted recovery cannot restore ${destination} because its transaction backup is missing; the exact incoming directory was preserved.`
        )
      }
      rmSync(destination, { recursive: true, force: true })
    } else if (previousByName.has(name) && !missingBefore.has(name)) {
      throw new SkillProjectionError(
        "conflict",
        `Interrupted recovery cannot restore the missing directory ${destination}.`
      )
    }
  }
  if (journal.manifestBefore) {
    atomicWriteJson(manifestPath(env, target.targetKey), journal.manifestBefore)
  } else {
    removeManifest(env, target.targetKey)
  }
  rmSync(journal.stageDir, { recursive: true, force: true })
  rmSync(path, { force: true })
  return true
}

function assertMutationPreconditions(input: {
  action: SkillProjectionAction
  target: TargetResolution
  env: SkillProjectionEnvironment
  manifestBefore: ProjectionManifest | null
  affectedSkillNames: string[]
  expectedMissingSkillNames: string[]
  preservedMissingSkillNames: string[]
  preservedModifiedSkillNames: string[]
}): void {
  const {
    action,
    target,
    env,
    manifestBefore,
    affectedSkillNames,
    expectedMissingSkillNames,
    preservedMissingSkillNames,
    preservedModifiedSkillNames,
  } = input
  if (
    resolvedThroughExistingAncestor(target.logicalRoot) !== target.resolvedRoot
  ) {
    throw new SkillProjectionError(
      "stale-plan",
      "The resolved skill target changed after preview. Preview the operation again."
    )
  }
  const currentManifest = validateManifest(
    readJson<ProjectionManifest>(manifestPath(env, target.targetKey)),
    target
  )
  if (stableJson(currentManifest) !== stableJson(manifestBefore)) {
    throw new SkillProjectionError(
      "stale-plan",
      "The skill ownership manifest changed after preview. Preview the operation again."
    )
  }
  if (!manifestBefore) {
    const collisions = affectedSkillNames.filter((name) =>
      pathEntryExists(join(target.resolvedRoot, name))
    )
    if (collisions.length > 0) {
      throw new SkillProjectionError(
        "stale-plan",
        `Unmanaged skill directories appeared after preview: ${collisions.join(", ")}.`
      )
    }
    return
  }

  const inspection = inspectProjection(manifestBefore, target)
  if (
    action === "remove" &&
    (preservedMissingSkillNames.length > 0 ||
      preservedModifiedSkillNames.length > 0)
  ) {
    const observedMissing = [...inspection.missing].sort(compareStrings)
    const expectedMissing = [...preservedMissingSkillNames].sort(compareStrings)
    const observedModified = [...inspection.modified].sort(compareStrings)
    const expectedModified = [...preservedModifiedSkillNames].sort(
      compareStrings
    )
    const preserved = new Set([...expectedMissing, ...expectedModified])
    const expectedAffected = manifestBefore.skills
      .map((skill) => skill.name)
      .filter((name) => !preserved.has(name))
      .sort(compareStrings)
    if (
      stableJson(observedMissing) !== stableJson(expectedMissing) ||
      stableJson(observedModified) !== stableJson(expectedModified) ||
      stableJson([...affectedSkillNames].sort(compareStrings)) !==
        stableJson(expectedAffected)
    ) {
      throw new SkillProjectionError(
        "stale-plan",
        "The owned skill files changed while uninstall cleanup was being staged. Run uninstall again."
      )
    }
    return
  }
  if (action === "restore-missing") {
    const observedMissing = [...inspection.missing].sort(compareStrings)
    const expectedMissing = [...expectedMissingSkillNames].sort(compareStrings)
    if (
      inspection.modified.length > 0 ||
      stableJson(observedMissing) !== stableJson(expectedMissing)
    ) {
      throw new SkillProjectionError(
        "stale-plan",
        "The owned skill files changed while repair was being staged. Preview the operation again."
      )
    }
    return
  }
  if (inspection.missing.length > 0 || inspection.modified.length > 0) {
    throw new SkillProjectionError(
      "stale-plan",
      "The owned skill files changed after preview. Preview the operation again."
    )
  }
  const ownedNames = new Set(manifestBefore.skills.map((skill) => skill.name))
  const newCollisions = affectedSkillNames.filter(
    (name) =>
      !ownedNames.has(name) && pathEntryExists(join(target.resolvedRoot, name))
  )
  if (newCollisions.length > 0) {
    throw new SkillProjectionError(
      "stale-plan",
      `Unmanaged skill directories appeared after preview: ${newCollisions.join(", ")}.`
    )
  }
}

function applyFileTransaction(input: {
  request: SkillProjectionRequest
  action: SkillProjectionAction
  target: TargetResolution
  env: SkillProjectionEnvironment
  sourceDir?: string
  incomingSkills?: SkillTreeDigest[]
  manifestBefore: ProjectionManifest | null
  manifestAfter: ProjectionManifest | null
  affectedSkillNames?: string[]
  expectedMissingSkillNames?: string[]
  preservedMissingSkillNames?: string[]
  preservedModifiedSkillNames?: string[]
}): void {
  const {
    request,
    action,
    target,
    env,
    sourceDir,
    incomingSkills = [],
    manifestBefore,
    manifestAfter,
    affectedSkillNames,
    expectedMissingSkillNames = [],
    preservedMissingSkillNames = [],
    preservedModifiedSkillNames = [],
  } = input
  const transactionId = manifestAfter?.transactionId ?? randomUUID()
  const affected = (
    affectedSkillNames ??
    Array.from(
      new Set([
        ...(manifestBefore?.skills.map((skill) => skill.name) ?? []),
        ...incomingSkills.map((skill) => skill.name),
      ])
    )
  ).sort(compareStrings)
  assertMutationPreconditions({
    action,
    target,
    env,
    manifestBefore,
    affectedSkillNames: affected,
    expectedMissingSkillNames,
    preservedMissingSkillNames,
    preservedModifiedSkillNames,
  })
  mkdirSync(target.resolvedRoot, { recursive: true, mode: 0o700 })
  const stageDir = join(target.resolvedRoot, `.worktable-${transactionId}`)
  const incomingDir = join(stageDir, "incoming")
  const backupDir = join(stageDir, "backup")
  const journal: TransactionJournal = {
    schemaVersion: MANIFEST_VERSION,
    transactionId,
    targetKey: target.targetKey,
    operation: request.operation,
    targetRoot: target.resolvedRoot,
    stageDir,
    skillNames: affected,
    incomingSkills,
    manifestBefore,
    missingBefore: expectedMissingSkillNames,
    ...(manifestAfter === null ? { removesManifest: true as const } : {}),
  }
  atomicWriteJson(journalPath(env, target.targetKey), journal)
  maybeInterrupt(env, "journal")
  try {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    if (sourceDir && incomingSkills.length > 0) {
      copySkills(sourceDir, incomingSkills, incomingDir)
    }
    env.beforeMutationCheck?.()
    assertMutationPreconditions({
      action,
      target,
      env,
      manifestBefore,
      affectedSkillNames: affected,
      expectedMissingSkillNames,
      preservedMissingSkillNames,
      preservedModifiedSkillNames,
    })
  } catch (error) {
    // No owned destination has moved yet, so an in-process staging failure can
    // discard its journal and temporary bytes without recovery ambiguity.
    rmSync(stageDir, { recursive: true, force: true })
    rmSync(journalPath(env, target.targetKey), { force: true })
    throw error
  }
  try {
    const previousByName = new Map(
      manifestBefore?.skills.map((skill) => [skill.name, skill.digest]) ?? []
    )
    const missingBefore = new Set(expectedMissingSkillNames)
    const assertBackupsExact = () => {
      for (const name of affected) {
        const destination = join(target.resolvedRoot, name)
        const backup = join(backupDir, name)
        if (pathEntryExists(backup)) {
          const expected = previousByName.get(name)
          const info = lstatSync(backup)
          if (
            !expected ||
            missingBefore.has(name) ||
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            hashTree(backup) !== expected
          ) {
            throw new SkillProjectionError(
              "stale-plan",
              `The owned skill directory ${destination} changed while it moved into transaction backup.`
            )
          }
        } else if (previousByName.has(name) && !missingBefore.has(name)) {
          throw new SkillProjectionError(
            "stale-plan",
            `The owned skill directory ${destination} disappeared while it moved into transaction backup.`
          )
        }
      }
    }
    for (const name of affected) {
      const destination = join(target.resolvedRoot, name)
      const backup = join(backupDir, name)
      if (pathEntryExists(destination)) {
        renameSync(destination, backup)
        env.afterBackupMoved?.(backup)
      }
    }
    assertBackupsExact()
    maybeInterrupt(env, "backup")
    for (const skill of incomingSkills) {
      renameSync(
        join(incomingDir, skill.name),
        join(target.resolvedRoot, skill.name)
      )
    }
    assertBackupsExact()
    maybeInterrupt(env, "materialize")
    if (manifestAfter) {
      atomicWriteJson(manifestPath(env, target.targetKey), manifestAfter)
    } else {
      removeManifest(env, target.targetKey)
      // This test-only seam proves recovery remains safe if the process stops
      // in the narrow interval before the durable removal marker is written.
      maybeInterrupt(env, "manifest-removal")
      journal.manifestRemovalCommitted = true
      atomicWriteJson(journalPath(env, target.targetKey), journal)
    }
    maybeInterrupt(env, "manifest")
    rmSync(stageDir, { recursive: true, force: true })
    maybeInterrupt(env, "stage-cleanup")
    rmSync(journalPath(env, target.targetKey), { force: true })
  } catch (error) {
    // Deliberately leave a recoverable journal for injected interruption tests;
    // ordinary failures attempt immediate restoration from transaction backup.
    if (error instanceof SkillProjectionError && error.code === "interrupted") {
      throw error
    }
    try {
      recoverTransaction(target, env)
    } catch {
      // The durable journal remains the repair authority when restoration itself
      // cannot complete.
    }
    throw error
  }
}

function nextManifest(input: {
  target: TargetResolution
  source: SkillSourceInventory
  previous: ProjectionManifest | null
  transactionId: string
}): ProjectionManifest {
  const now = new Date().toISOString()
  return {
    schemaVersion: MANIFEST_VERSION,
    targetId: input.target.targetId,
    logicalTargetRoot: input.target.logicalRoot,
    resolvedTargetRoot: input.target.resolvedRoot,
    sourceVersion: input.source.sourceVersion,
    sourcePackageDigest: input.source.packageDigest,
    skills: input.source.skills,
    materialization: "copy",
    installedAt: input.previous?.installedAt ?? now,
    updatedAt: now,
    transactionId: input.transactionId,
  }
}

function applySkillProjectionLocked(
  request: SkillProjectionRequest,
  expectedPlanId: string,
  env: SkillProjectionEnvironment
): SkillProjectionResult {
  const { preview, target, source, manifest } = readProjectionPlan(request, env)

  if (
    preview.status.state === "incomplete" &&
    (request.operation === "repair" || request.operation === "remove")
  ) {
    if (preview.planId !== expectedPlanId) {
      throw new SkillProjectionError(
        "stale-plan",
        "The skill installation changed after preview. Review a fresh plan before applying it."
      )
    }
    const recoveredInterruptedTransaction = recoverTransaction(target, env)
    if (!recoveredInterruptedTransaction) {
      throw new SkillProjectionError(
        "conflict",
        `The interrupted transaction could not be found. Preview ${request.operation} again.`
      )
    }
    const statusAfterRecovery = getSkillProjectionStatus(
      { targetId: request.targetId },
      env
    )
    const shouldContinue =
      (request.operation === "repair" &&
        statusAfterRecovery.state === "missing") ||
      (request.operation === "remove" &&
        statusAfterRecovery.state !== "not-installed")
    if (shouldContinue) {
      const remaining = previewSkillProjection(request, env)
      if (!remaining.allowed) {
        throw new SkillProjectionError(
          "conflict",
          `The interrupted transaction was recovered, but ${request.operation} could not finish: ${remaining.status.detail}`
        )
      }
      const completed = applySkillProjectionLocked(
        request,
        remaining.planId,
        env
      )
      return {
        ...preview,
        applied: completed.applied || recoveredInterruptedTransaction,
        recoveredInterruptedTransaction,
        statusAfter: completed.statusAfter,
      }
    }
    return {
      ...preview,
      applied: true,
      recoveredInterruptedTransaction,
      statusAfter: statusAfterRecovery,
    }
  }

  if (preview.planId !== expectedPlanId) {
    throw new SkillProjectionError(
      "stale-plan",
      "The skill installation changed after preview. Review a fresh plan before applying it."
    )
  }
  if (!preview.allowed) {
    throw new SkillProjectionError(
      "conflict",
      preview.changes[0] ?? preview.status.detail
    )
  }

  const transactionId = randomUUID()
  switch (preview.action) {
    case "write": {
      if (!source) {
        throw new SkillProjectionError(
          "conflict",
          "The packaged Worktable skills are unavailable."
        )
      }
      const after = nextManifest({
        target,
        source,
        previous: null,
        transactionId,
      })
      applyFileTransaction({
        request,
        action: preview.action,
        target,
        env,
        sourceDir: source.sourceDir,
        incomingSkills: source.skills,
        manifestBefore: null,
        manifestAfter: after,
      })
      break
    }

    case "replace": {
      if (!source || !manifest) {
        throw new SkillProjectionError(
          "conflict",
          "The packaged source or ownership manifest is unavailable."
        )
      }
      const after = nextManifest({
        target,
        source,
        previous: manifest,
        transactionId,
      })
      applyFileTransaction({
        request,
        action: preview.action,
        target,
        env,
        sourceDir: source.sourceDir,
        incomingSkills: source.skills,
        manifestBefore: manifest,
        manifestAfter: after,
      })
      break
    }

    case "restore-missing": {
      if (!source || !manifest) {
        throw new SkillProjectionError(
          "conflict",
          "The packaged source or ownership manifest is unavailable."
        )
      }
      const missing = source.skills.filter((skill) =>
        preview.status.missingSkills.includes(skill.name)
      )
      const after: ProjectionManifest = {
        ...manifest,
        updatedAt: new Date().toISOString(),
        transactionId,
      }
      applyFileTransaction({
        request,
        action: preview.action,
        target,
        env,
        sourceDir: source.sourceDir,
        incomingSkills: missing,
        manifestBefore: manifest,
        manifestAfter: after,
        affectedSkillNames: missing.map((skill) => skill.name),
        expectedMissingSkillNames: preview.status.missingSkills,
      })
      break
    }

    case "remove": {
      if (!manifest) {
        throw new SkillProjectionError(
          "conflict",
          "Ownership manifest is missing."
        )
      }
      const preserved = new Set([
        ...preview.status.missingSkills,
        ...preview.status.modifiedSkills,
      ])
      const removable = manifest.skills
        .map((skill) => skill.name)
        .filter((name) => !preserved.has(name))
      applyFileTransaction({
        request,
        action: preview.action,
        target,
        env,
        manifestBefore: manifest,
        manifestAfter: null,
        affectedSkillNames: removable,
        preservedMissingSkillNames: preview.status.missingSkills,
        preservedModifiedSkillNames: preview.status.modifiedSkills,
      })
      break
    }

    case "none":
      throw new SkillProjectionError(
        "conflict",
        preview.changes[0] ?? "This operation is not available."
      )
  }

  const statusAfter = getSkillProjectionStatus(
    { targetId: request.targetId },
    env
  )
  return {
    ...preview,
    applied: true,
    recoveredInterruptedTransaction: false,
    statusAfter,
  }
}

export function applySkillProjection(
  request: SkillProjectionRequest,
  expectedPlanId: string,
  env: SkillProjectionEnvironment
): SkillProjectionResult {
  const releaseLifecycle = acquireTargetLock(env, LIFECYCLE_LOCK_KEY)
  try {
    const target = resolveTarget(request, env)
    const releaseTarget = acquireTargetLock(env, target.targetKey)
    try {
      env.afterLockAcquired?.()
      return applySkillProjectionLocked(request, expectedPlanId, env)
    } finally {
      releaseTarget()
    }
  } finally {
    releaseLifecycle()
  }
}

function targetFromStoredManifest(
  manifest: ProjectionManifest,
  expectedTargetKey: string,
  env: SkillProjectionEnvironment
): TargetResolution {
  const candidate = manifest as Partial<ProjectionManifest>
  const targetId = candidate.targetId
  if (typeof targetId !== "string" || !isSkillProjectionTargetId(targetId)) {
    throw new SkillProjectionError(
      "conflict",
      "Worktable cannot safely resolve a recorded skill projection for uninstall."
    )
  }
  const target = resolveTarget({ targetId, operation: "remove" }, env)
  if (
    candidate.logicalTargetRoot !== target.logicalRoot ||
    candidate.resolvedTargetRoot !== target.resolvedRoot ||
    target.targetKey !== expectedTargetKey
  ) {
    throw new SkillProjectionError(
      "conflict",
      "Worktable cannot safely resolve a recorded skill projection for uninstall."
    )
  }
  return target
}

function targetFromStoredJournal(
  journal: TransactionJournal,
  expectedTargetKey: string,
  env: SkillProjectionEnvironment
): TargetResolution {
  const candidate = journal as Partial<TransactionJournal>
  if (
    candidate.targetKey !== expectedTargetKey ||
    typeof candidate.targetRoot !== "string" ||
    !isAbsolute(candidate.targetRoot) ||
    resolve(candidate.targetRoot) !== candidate.targetRoot
  ) {
    throw new SkillProjectionError(
      "conflict",
      "Worktable cannot safely resolve an interrupted skill projection for uninstall."
    )
  }
  if (candidate.manifestBefore) {
    return targetFromStoredManifest(
      candidate.manifestBefore,
      expectedTargetKey,
      env
    )
  }
  for (const targetId of SKILL_PROJECTION_TARGET_IDS) {
    const target = resolveTarget({ targetId, operation: "remove" }, env)
    if (
      target.resolvedRoot === candidate.targetRoot &&
      target.targetKey === expectedTargetKey
    ) {
      return target
    }
  }
  throw new SkillProjectionError(
    "conflict",
    "Worktable cannot safely classify an interrupted skill projection for uninstall."
  )
}

function recoverTransactionsForUninstall(
  env: SkillProjectionEnvironment
): void {
  const transactionsDir = join(stateRoot(env), "transactions")
  if (!existsSync(transactionsDir)) return
  for (const name of readdirSync(transactionsDir).sort(compareStrings)) {
    if (!name.endsWith(".json")) continue
    const match = /^([a-f0-9]{32})\.json$/.exec(name)
    const path = join(transactionsDir, name)
    if (!match || !lstatSync(path).isFile()) {
      throw new SkillProjectionError(
        "conflict",
        `Worktable cannot safely interpret the interrupted skill record ${path}.`
      )
    }
    const targetKey = match[1]!
    const release = acquireTargetLock(env, targetKey)
    try {
      env.afterLockAcquired?.()
      const stored = readJson<TransactionJournal>(path)
      if (!stored) continue
      const target = targetFromStoredJournal(stored, targetKey, env)
      validateJournal(stored, target)
      recoverTransaction(target, env)
    } finally {
      release()
    }
  }
}

interface PreparedSkillProjectionRemoval {
  target: TargetResolution
  manifest: ProjectionManifest
  inspection: Inspection
}

function probeWritableDirectory(directory: string, description: string): void {
  const probe = join(
    directory,
    `.worktable-uninstall-preflight-${randomUUID()}`
  )
  const moved = `${probe}.moved`
  let ownsProbe = false
  let ownsMoved = false
  try {
    mkdirSync(probe, { mode: 0o700 })
    ownsProbe = true
    renameSync(probe, moved)
    ownsProbe = false
    ownsMoved = true
    rmdirSync(moved)
    ownsMoved = false
  } catch {
    try {
      if (ownsProbe) rmdirSync(probe)
      if (ownsMoved) rmdirSync(moved)
    } catch {
      // Preserve anything no longer empty rather than deleting raced user data.
    }
    throw new SkillProjectionError(
      "conflict",
      `Worktable cannot safely write ${description} during uninstall. Restore write access and try again.`
    )
  }
}

function probeWritableTree(root: string, description: string): void {
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink()) return
  probeWritableDirectory(root, description)
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    probeWritableTree(join(root, entry.name), description)
  }
}

function preflightUninstallTargetMutation(
  target: TargetResolution,
  manifest: ProjectionManifest,
  inspection: Inspection
): void {
  const changed = new Set([...inspection.modified, ...inspection.missing])
  const exactSkills = manifest.skills.filter(
    (skill) => !changed.has(skill.name)
  )
  if (exactSkills.length === 0) return
  probeWritableDirectory(target.resolvedRoot, target.logicalRoot)
  for (const skill of exactSkills) {
    probeWritableTree(
      join(target.resolvedRoot, skill.name),
      `owned skill ${join(target.logicalRoot, skill.name)}`
    )
  }
}

function prepareOwnedSkillProjectionsForUninstallLocked(
  env: SkillProjectionEnvironment
): PreparedSkillProjectionRemoval[] {
  recoverTransactionsForUninstall(env)
  const projectionsDir = join(stateRoot(env), "projections", "v2")
  if (!existsSync(projectionsDir)) return []
  probeWritableTree(stateRoot(env), "skill projection state")
  const prepared: PreparedSkillProjectionRemoval[] = []

  for (const name of readdirSync(projectionsDir).sort(compareStrings)) {
    if (!name.endsWith(".json")) continue
    const match = /^([a-f0-9]{32})\.json$/.exec(name)
    const path = join(projectionsDir, name)
    if (!match || !lstatSync(path).isFile()) {
      throw new SkillProjectionError(
        "conflict",
        `Worktable cannot safely interpret the skill ownership record ${path}.`
      )
    }
    const targetKey = match[1]!
    const stored = readJson<ProjectionManifest>(path)
    if (!stored) continue
    const target = targetFromStoredManifest(stored, targetKey, env)
    const manifest = validateManifest(stored, target)
    if (!manifest) continue
    if (existsSync(journalPath(env, targetKey))) {
      throw new SkillProjectionError(
        "conflict",
        `Repair the interrupted skill projection at ${target.logicalRoot} before uninstalling Worktable.`
      )
    }
    const inspection = inspectProjection(manifest, target)
    preflightUninstallTargetMutation(target, manifest, inspection)
    prepared.push({
      target,
      manifest,
      inspection,
    })
  }
  return prepared
}

function removePreparedSkillProjectionsForUninstallLocked(
  prepared: PreparedSkillProjectionRemoval[],
  env: SkillProjectionEnvironment
): SkillProjectionUninstallResult {
  const result: SkillProjectionUninstallResult = {
    removed: [],
    preserved: [],
  }
  for (const entry of prepared) {
    const { target } = entry
    const path = manifestPath(env, target.targetKey)
    const release = acquireTargetLock(env, target.targetKey)
    try {
      const manifest = validateManifest(
        readJson<ProjectionManifest>(path),
        target
      )
      if (
        !manifest ||
        stableJson(manifest) !== stableJson(entry.manifest) ||
        existsSync(journalPath(env, target.targetKey))
      ) {
        throw new SkillProjectionError(
          "stale-plan",
          `The skill projection at ${target.logicalRoot} changed after uninstall preflight. Run uninstall again.`
        )
      }
      const inspection = inspectProjection(manifest, target)
      if (stableJson(inspection) !== stableJson(entry.inspection)) {
        throw new SkillProjectionError(
          "stale-plan",
          `The owned skill files at ${target.logicalRoot} changed after uninstall preflight. Run uninstall again.`
        )
      }
      const changedNames = new Set([
        ...inspection.modified,
        ...inspection.missing,
      ])
      const exactSkills = manifest.skills.filter(
        (skill) => !changedNames.has(skill.name)
      )
      const skillPaths = exactSkills.map((skill) =>
        join(target.logicalRoot, skill.name)
      )
      applyFileTransaction({
        request: {
          targetId: target.targetId,
          operation: "remove",
        },
        action: "remove",
        target,
        env,
        manifestBefore: manifest,
        manifestAfter: null,
        affectedSkillNames: exactSkills.map((skill) => skill.name),
        preservedMissingSkillNames: inspection.missing,
        preservedModifiedSkillNames: inspection.modified,
      })
      if (exactSkills.length > 0) {
        result.removed.push({
          targetRoot: target.logicalRoot,
          targetId: target.targetId,
          skillPaths,
        })
      }
      if (inspection.modified.length > 0 || inspection.missing.length > 0) {
        result.preserved.push({
          targetRoot: target.logicalRoot,
          targetId: target.targetId,
          modifiedSkillPaths: inspection.modified.map((skill) =>
            join(target.logicalRoot, skill)
          ),
          missingSkillPaths: inspection.missing.map((skill) =>
            join(target.logicalRoot, skill)
          ),
        })
      }
    } finally {
      release()
    }
  }
  return result
}

/**
 * Remove every byte-exact owned path before uninstall deletes app data. When a
 * continuation is provided, the lifecycle lock remains held until it returns.
 * The continuation may remove machine-local app data through the supplied
 * lifecycle boundary; that preserves the in-root lock until release, then
 * removes only empty ancestors so a post-release install wins the handoff.
 */
export interface SkillProjectionUninstallLifecycle {
  removeAppData(): void
}

export interface PreparedSkillProjectionUninstallLifecycle extends SkillProjectionUninstallLifecycle {
  removeOwned(): SkillProjectionUninstallResult
}

export function withPreparedSkillProjectionUninstall<T>(
  env: SkillProjectionEnvironment,
  continueWhileLocked: (
    lifecycle: PreparedSkillProjectionUninstallLifecycle
  ) => T
): T {
  // This boundary eventually clears the app-data root while keeping an in-root
  // lifecycle lock. Reject roots that recursive cleanup could follow before any
  // projection, MCP, service, launcher, or workspace mutation begins.
  assertSafeAppDataRootForUninstall(env)
  const releaseLifecycle = acquireTargetLock(env, LIFECYCLE_LOCK_KEY)
  let appDataRemoved = false
  let removed = false
  try {
    const prepared = prepareOwnedSkillProjectionsForUninstallLocked(env)
    return continueWhileLocked({
      removeOwned() {
        if (removed) {
          throw new SkillProjectionError(
            "stale-plan",
            "Worktable skill projections were already removed in this uninstall session."
          )
        }
        const result = removePreparedSkillProjectionsForUninstallLocked(
          prepared,
          env
        )
        removed = true
        return result
      },
      removeAppData() {
        if (!removed) {
          throw new SkillProjectionError(
            "stale-plan",
            "Remove Worktable-owned skill projections before deleting app data."
          )
        }
        removeAppDataPreservingLifecycleLock(env)
        appDataRemoved = true
      },
    })
  } finally {
    releaseLifecycle()
    if (appDataRemoved) {
      env.afterLifecycleLockReleased?.()
      removeEmptyAppDataDir(env)
    }
  }
}

export function removeOwnedSkillProjectionsForUninstall(
  env: SkillProjectionEnvironment
): SkillProjectionUninstallResult
export function removeOwnedSkillProjectionsForUninstall<T>(
  env: SkillProjectionEnvironment,
  continueWhileLocked: (
    result: SkillProjectionUninstallResult,
    lifecycle: SkillProjectionUninstallLifecycle
  ) => T
): T
export function removeOwnedSkillProjectionsForUninstall<T>(
  env: SkillProjectionEnvironment,
  continueWhileLocked?: (
    result: SkillProjectionUninstallResult,
    lifecycle: SkillProjectionUninstallLifecycle
  ) => T
): SkillProjectionUninstallResult | T {
  return withPreparedSkillProjectionUninstall(env, (prepared) => {
    const result = prepared.removeOwned()
    if (!continueWhileLocked) return result
    return continueWhileLocked(result, {
      removeAppData() {
        prepared.removeAppData()
      },
    })
  })
}
