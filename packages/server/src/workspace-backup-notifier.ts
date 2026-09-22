import { createHash, randomUUID } from "node:crypto"
import { open } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { ENV } from "@worktable/hosted-contract"
import { atomicWriteText } from "./atomic-file.ts"
import { readBoundedRegularFile } from "./bounded-file.ts"
import { ensureAppDir } from "./app-storage.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { onDocContentChanged } from "./content-events.ts"
import { inspectPortableWorkspaceTree } from "./workspace-transfer-v2.ts"

export const LOCAL_OPERATOR_BACKUP_AUDIT_PATH =
  "/internal/operator/workspace-backup-audit"
const Ledger = z
  .object({
    version: z.literal(1),
    epoch: z.uuid(),
    generation: z.number().int().nonnegative(),
    reported: z.number().int().nonnegative(),
    fingerprint: z.string().optional(),
  })
  .refine((value) => value.reported <= value.generation)
type LedgerState = z.infer<typeof Ledger>

/** App-local outbox. The Cloud revision, not this epoch, orders backup completion. */
export class WorkspaceBackupNotifier {
  private state: LedgerState = {
    version: 1,
    epoch: randomUUID(),
    generation: 0,
    reported: 0,
  }
  private timer: ReturnType<typeof setTimeout> | undefined
  private work: Promise<void> = Promise.resolve()
  private stopped = false
  private loaded = false
  private pendingChanges = 0
  private readonly cancellation = new AbortController()
  private readonly file: string
  private readonly workspace: string
  private readonly report: (
    value: { epoch: string; generation: number },
    signal: AbortSignal
  ) => Promise<void>
  constructor(
    file: string,
    workspace: string,
    report: (
      value: { epoch: string; generation: number },
      signal: AbortSignal
    ) => Promise<void>
  ) {
    this.file = file
    this.workspace = workspace
    this.report = report
  }

  async initialize() {
    try {
      this.state = Ledger.parse(
        JSON.parse(await readBoundedRegularFile(this.file, 16384))
      )
    } catch {
      /* Missing or damaged app state is audited as a new dirty epoch. */
    }
    this.state.generation += this.pendingChanges
    this.loaded = true
    this.queue()
    await this.audit()
  }
  changed() {
    if (this.stopped) return
    if (!this.loaded) {
      this.pendingChanges += 1
      return
    }
    this.state.generation += 1
    this.queue()
  }
  private async persist() {
    await atomicWriteText(this.file, JSON.stringify(this.state))
    for (const path of [this.file, dirname(this.file)]) {
      const handle = await open(path, "r")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
  }
  private queue(delay = 50) {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.work = this.work
        .catch(() => {})
        .then(() => this.flush())
        .catch(() => {
          this.queue(60000)
        })
    }, delay)
    this.timer.unref()
  }
  private async flush() {
    const generation = this.state.generation
    const epoch = this.state.epoch
    await this.persist()
    if (this.stopped || this.state.reported >= generation) return
    await this.report({ epoch, generation }, this.cancellation.signal)
    // Edits arriving during this request remain pending for a later report.
    this.state.reported = Math.max(this.state.reported, generation)
    await this.persist()
    if (this.state.generation > generation) this.queue()
  }
  async audit() {
    if (this.stopped || !this.loaded) return
    try {
      const inventory = await inspectPortableWorkspaceTree(this.workspace)
      if (this.stopped) return
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            directories: inventory.directories.map(({ path, mode }) => ({
              path,
              mode,
            })),
            files: inventory.files.map(({ path, mode, size, sha256 }) => ({
              path,
              mode,
              size,
              sha256,
            })),
          })
        )
        .digest("hex")
      if (fingerprint !== this.state.fingerprint) {
        this.state.fingerprint = fingerprint
        this.changed()
      }
    } catch {
      // A changing or unsupported tree must not silently become "clean".
      this.changed()
    }
    this.queue()
  }
  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.cancellation.abort()
    await this.work.catch(() => {})
    await this.persist()
  }
}

let activeNotifier: WorkspaceBackupNotifier | undefined
export async function auditWorkspaceBackup() {
  if (!activeNotifier) return { enabled: false }
  await activeNotifier.audit()
  return { enabled: true }
}
export function startWorkspaceBackupNotifier(): () => Promise<void> {
  const url = process.env[ENV.BACKUP_REPORT_URL]
  const runtimeId = process.env[ENV.BACKUP_RUNTIME_ID]
  const spriteId = process.env[ENV.BACKUP_PROVIDER_ID]
  const secret = process.env[ENV.GATEWAY_SECRET]
  if (
    !url ||
    !runtimeId ||
    !spriteId ||
    !secret ||
    process.env[ENV.HOSTED] !== "1"
  )
    return async () => {}
  const endpoint = new URL(url)
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw new Error("invalid backup reporting endpoint")
  const notifier = new WorkspaceBackupNotifier(
    join(ensureAppDir(), "backup-notifications.json"),
    getWorkspaceRoot(),
    async (generation, signal) => {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
          "X-Worktable-Runtime": runtimeId,
        },
        body: JSON.stringify({ spriteId, ...generation }),
      })
      if (!response.ok)
        throw new Error("backup change notification was not accepted")
    }
  )
  activeNotifier = notifier
  const stopWorkspace = onWorkspaceChange(() => {
    notifier.changed()
  })
  const stopContent = onDocContentChanged(() => {
    notifier.changed()
  })
  const initialized = notifier.initialize()
  void initialized.catch(() => {})
  const auditTimer = setInterval(() => {
    void notifier.audit()
  }, 60 * 60000)
  auditTimer.unref()
  return async () => {
    stopWorkspace()
    stopContent()
    clearInterval(auditTimer)
    await initialized.catch(() => {})
    await notifier.stop()
    if (activeNotifier === notifier) activeNotifier = undefined
  }
}
