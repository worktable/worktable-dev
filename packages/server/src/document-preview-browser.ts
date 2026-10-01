import {
  launchPreviewBrowserProcess,
  resolveHeadlessPreviewExecutable,
} from "./document-preview-process.ts"
import { AsyncLocalStorage } from "node:async_hooks"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve, sep } from "node:path"
import type { Browser, BrowserContext, Page } from "playwright-core"

export type PreviewKind = "drawing" | "html"
export type PreviewBrowserErrorCode =
  | "PREVIEW_UNAVAILABLE"
  | "PREVIEW_BUSY"
  | "PREVIEW_TIMEOUT"
  | "PREVIEW_CANCELLED"
export class PreviewBrowserError extends Error {
  readonly code: PreviewBrowserErrorCode
  constructor(code: PreviewBrowserErrorCode, message: string) {
    super(message)
    this.name = "PreviewBrowserError"
    this.code = code
  }
}
const DRIVER_VERSION = "1.61.1"
let launchStatus: "not_checked" | "ready" | "failed" = "not_checked"
let launchFailure: string | undefined
const localRequire = createRequire(import.meta.url)
interface Runtime {
  driver: typeof import("playwright-core")
  executablePath: string
  source: "packaged" | "development"
}

/** No browser installation or download occurs on this path. */
function resolveRuntime(): Runtime {
  const release = process.env.WORKTABLE_RELEASE_DIR
  const roots = release
    ? [resolve(release)]
    : [resolve(dirname(process.execPath), "..")]
  for (const root of roots) {
    const runtime = join(root, "preview-runtime")
    if (!existsSync(runtime)) continue
    const manifest = JSON.parse(
      readFileSync(join(runtime, "manifest.json"), "utf8")
    )
    if (
      manifest.playwrightVersion !== DRIVER_VERSION ||
      manifest.platform !== process.platform ||
      manifest.arch !== process.arch
    )
      throw new Error(
        "Packaged preview runtime does not match this Worktable installation"
      )
    const executablePath = resolve(runtime, manifest.executable)
    if (
      !executablePath.startsWith(runtime + sep) ||
      !existsSync(executablePath)
    )
      throw new Error("Packaged preview browser executable is missing")
    const driverRoot = join(runtime, "driver")
    const driverPackage = JSON.parse(
      readFileSync(join(driverRoot, "package.json"), "utf8")
    )
    const browserDescriptor = JSON.parse(
      readFileSync(join(driverRoot, "browsers.json"), "utf8")
    ).browsers.find(
      (entry: { name: string }) => entry.name === "chromium-headless-shell"
    )
    if (
      driverPackage.version !== DRIVER_VERSION ||
      browserDescriptor?.revision !== manifest.browserRevision ||
      browserDescriptor?.browserVersion !== manifest.browserVersion
    )
      throw new Error(
        "Packaged preview driver and browser identities do not match; reinstall Worktable"
      )
    const driver = localRequire(
      join(driverRoot, "index.js")
    ) as Runtime["driver"]
    return { driver, executablePath, source: "packaged" }
  }
  // Installed releases must never silently pick an ambient developer browser.
  if (
    release ||
    process.execPath.endsWith("/worktable") ||
    process.execPath.endsWith("/worktable-server")
  )
    throw new Error(
      "This installation is missing its managed preview runtime; reinstall Worktable"
    )
  const packageName = "playwright-core"
  const packagePath = localRequire.resolve(packageName + "/package.json")
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"))
  if (pkg.version !== DRIVER_VERSION)
    throw new Error("Preview driver version mismatch")
  const driver = localRequire(
    join(dirname(packagePath), "index.js")
  ) as Runtime["driver"]
  return {
    driver,
    executablePath: resolveHeadlessPreviewExecutable(
      driver,
      dirname(packagePath)
    ),
    source: "development",
  }
}

export function previewBrowserAvailability(): {
  available: boolean
  sandboxRequired: true
  source?: string
  reason?: string
  launchStatus: "not_checked" | "ready" | "failed"
} {
  try {
    const runtime = resolveRuntime()
    return {
      available: launchStatus !== "failed",
      sandboxRequired: true,
      source: runtime.source,
      launchStatus,
      ...(launchFailure ? { reason: launchFailure } : {}),
    }
  } catch (error) {
    return {
      available: false,
      sandboxRequired: true,
      reason: String(error),
      launchStatus,
    }
  }
}

/** Browser protocol shutdown may never acknowledge a broken pipe. OS process
 * termination is the authority; protocol disposal gets only a bounded grace. */
async function settleWithin(pending: Promise<unknown>, milliseconds = 1_000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending.then(
        () => true,
        () => false
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

interface Worker {
  browser: Browser
  server: { kill: () => Promise<void> }
}
interface Job {
  kind: PreviewKind
  task: (page: Page) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  cancelled: boolean
  cleanup: () => void
  abort: (error: Error) => void
  interrupted: Promise<void>
  interrupt: () => void
}
interface PoolOptions {
  launch?: (kind: PreviewKind) => Promise<Worker>
  deadlineMs?: number
  idleMs?: number
  queueLimit?: number
}

async function launchWorker(): Promise<Worker> {
  try {
    const { driver, executablePath } = resolveRuntime()
    const worker = await launchPreviewBrowserProcess(driver, executablePath)
    launchStatus = "ready"
    launchFailure = undefined
    return worker
  } catch (error) {
    launchStatus = "failed"
    const details = String(error)
    launchFailure = /No usable sandbox|Chromium sandboxing failed/.test(details)
      ? "This host cannot start Chromium with its OS sandbox. Preview rendering requires a host with sandbox support."
      : `Managed preview browser could not start: ${details.split("\n")[0]}`
    throw new PreviewBrowserError("PREVIEW_UNAVAILABLE", launchFailure)
  }
}

/** Injectable lifecycle boundaries support deterministic tests without an unsafe production launch mode. */
export class PreviewBrowserPool {
  private readonly workers = new Map<PreviewKind, Worker>()
  private readonly queue: Job[] = []
  private active: Job | undefined
  private activeCompletion: Promise<void> = Promise.resolve()
  private readonly retiring = new Set<Promise<void>>()
  private readonly starting = new Set<Promise<void>>()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private closing: Promise<void> | undefined
  private readonly options: PoolOptions
  constructor(options: PoolOptions = {}) {
    this.options = options
  }

  async run<T>(
    kind: PreviewKind,
    task: (page: Page) => Promise<T>,
    options: { signal?: AbortSignal } = {}
  ): Promise<T> {
    if (options.signal?.aborted)
      throw new PreviewBrowserError(
        "PREVIEW_CANCELLED",
        "Preview was cancelled"
      )
    if (this.closing)
      throw new PreviewBrowserError(
        "PREVIEW_CANCELLED",
        "Preview service is shutting down"
      )
    if (this.queue.length >= (this.options.queueLimit ?? 8))
      throw new PreviewBrowserError(
        "PREVIEW_BUSY",
        "Preview queue is full; retry later"
      )
    clearTimeout(this.idleTimer)
    return new Promise<T>((resolveJob, reject) => {
      let interrupt!: () => void
      const interrupted = new Promise<void>((resolve) => {
        interrupt = resolve
      })
      const job: Job = {
        interrupted,
        interrupt,
        kind,
        task,
        resolve: (value) => resolveJob(value as T),
        reject,
        cancelled: false,
        cleanup: () => {
          clearTimeout(timer)
          options.signal?.removeEventListener("abort", onAbort)
        },
        abort: (error) => {
          if (job.cancelled) return
          job.cancelled = true
          job.interrupt()
          job.cleanup()
          reject(error)
          const index = this.queue.indexOf(job)
          if (index >= 0) this.queue.splice(index, 1)
          if (this.active === job) void this.retire(kind)
        },
      }
      const onAbort = () =>
        job.abort(
          options.signal?.reason?.name === "TimeoutError"
            ? new PreviewBrowserError(
                "PREVIEW_TIMEOUT",
                "Preview exceeded its time budget"
              )
            : new PreviewBrowserError(
                "PREVIEW_CANCELLED",
                "Preview was cancelled"
              )
        )
      const timer = setTimeout(
        () =>
          job.abort(
            new PreviewBrowserError(
              "PREVIEW_TIMEOUT",
              "Preview exceeded its time budget"
            )
          ),
        this.options.deadlineMs ?? 30_000
      )
      options.signal?.addEventListener("abort", onAbort, { once: true })
      this.queue.push(job)
      void this.drain()
    })
  }

  private async retire(kind: PreviewKind): Promise<void> {
    const worker = this.workers.get(kind)
    if (!worker) return
    this.workers.delete(kind)
    // Kill, rather than relying on a renderer acknowledgement from arbitrary JS.
    const stopping = (async () => {
      await settleWithin(worker.server.kill())
    })()
    this.retiring.add(stopping)
    try {
      await stopping
    } finally {
      this.retiring.delete(stopping)
    }
  }

  private async drain(): Promise<void> {
    if (this.active || this.closing) return
    const job = this.queue.shift()
    if (!job) {
      this.idleTimer = setTimeout(() => {
        void Promise.all(
          [...this.workers.keys()].map((kind) => this.retire(kind))
        )
      }, this.options.idleMs ?? 60_000)
      this.idleTimer.unref?.()
      return
    }
    this.active = job
    let complete!: () => void
    this.activeCompletion = new Promise<void>((resolve) => {
      complete = resolve
    })
    let context: BrowserContext | undefined
    let outcome:
      | { ok: true; value: unknown }
      | { ok: false; error: unknown }
      | undefined
    try {
      const operation = (async () => {
        let worker = this.workers.get(job.kind)
        if (!worker || !worker.browser.isConnected()) {
          await this.retire(job.kind)
          const launching = (async () => {
            const launched = await (this.options.launch ?? launchWorker)(
              job.kind
            )
            if (job.cancelled || this.closing) {
              await settleWithin(launched.server.kill())
              throw new PreviewBrowserError(
                "PREVIEW_CANCELLED",
                "Preview was cancelled"
              )
            }
            this.workers.set(job.kind, launched)
            worker = launched
          })()
          this.starting.add(launching)
          try {
            await launching
          } finally {
            this.starting.delete(launching)
          }
        }
        if (job.cancelled || this.closing)
          throw new PreviewBrowserError(
            "PREVIEW_CANCELLED",
            "Preview was cancelled"
          )
        context = await worker!.browser.newContext({
          acceptDownloads: false,
          // Playwright 1.61's block shim reads navigator.serviceWorker without
          // guarding opaque sandbox origins, generating false authored errors.
          // The init script below denies registration at the prototype instead.
          serviceWorkers: "allow",
          javaScriptEnabled: true,
          viewport: { width: 1280, height: 900 },
          deviceScaleFactor: 1,
        })
        await context.route("**/*", (route) => route.abort("blockedbyclient"))
        await context.routeWebSocket("**/*", (socket) => socket.close())
        await context.addInitScript(() => {
          try {
            const serviceWorker = navigator.serviceWorker
            if (serviceWorker)
              Object.defineProperty(
                Object.getPrototypeOf(serviceWorker),
                "register",
                {
                  value: () =>
                    Promise.reject(
                      new DOMException(
                        "Service workers are disabled during preview",
                        "NotAllowedError"
                      )
                    ),
                  configurable: false,
                  writable: false,
                }
              )
          } catch {
            // Opaque sandbox frames already prohibit access to service workers.
          }
          for (const key of [
            "RTCPeerConnection",
            "webkitRTCPeerConnection",
            "WebTransport",
            "Worker",
            "SharedWorker",
          ]) {
            Object.defineProperty(globalThis, key, {
              value: undefined,
              writable: false,
              configurable: false,
            })
          }
        })
        const page = await context.newPage()
        page.setDefaultTimeout(10_000)
        page.setDefaultNavigationTimeout(10_000)
        page.on("dialog", (dialog) => {
          void dialog.dismiss()
        })
        page.on("download", (download) => {
          void download.cancel()
        })
        context.on("page", (other) => {
          if (other !== page) void other.close()
        })
        if (job.cancelled || this.closing)
          throw new PreviewBrowserError(
            "PREVIEW_CANCELLED",
            "Preview was cancelled"
          )
        return job.task(page)
      })()
      const result = await Promise.race([
        operation,
        job.interrupted.then(() => {
          throw new PreviewBrowserError(
            "PREVIEW_CANCELLED",
            "Preview was cancelled"
          )
        }),
      ])
      outcome = { ok: true, value: result }
    } catch (error) {
      outcome = { ok: false, error }
    } finally {
      // Keep the admission slot until a cancelled launch has disposed its
      // process. Launch itself has a 15s deadline; cancellation still rejects
      // the caller immediately without allowing unbounded concurrent starts.
      if (job.cancelled) await Promise.allSettled(this.starting)
      if (job.cancelled) await this.retire(job.kind)
      if (context) {
        const closingContext = context.close()
        const closed = await Promise.race([
          settleWithin(closingContext),
          job.interrupted.then(() => false),
        ])
        if (!closed) await this.retire(job.kind)
      }
      job.cleanup()
      this.active = undefined
      complete()
      if (!job.cancelled && outcome) {
        if (outcome.ok) job.resolve(outcome.value)
        else job.reject(outcome.error)
      }
      void this.drain()
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      clearTimeout(this.idleTimer)
      const error = new PreviewBrowserError(
        "PREVIEW_CANCELLED",
        "Preview service is shutting down"
      )
      for (const job of [...this.queue]) job.abort(error)
      this.active?.abort(error)
      await Promise.all(
        [...this.workers.keys()].map((kind) => this.retire(kind))
      )
      await this.activeCompletion
      await Promise.allSettled(this.starting)
      await Promise.all(this.retiring)
    })()
    return this.closing
  }
}

const scopedPools = new AsyncLocalStorage<PreviewBrowserPool>()

/** Scoped dependency injection for controlled fixture tests; never changes production launch policy. */
export function runWithPreviewBrowserPool<T>(
  testingPool: PreviewBrowserPool,
  task: () => Promise<T>
): Promise<T> {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Preview pool injection is available only in tests")
  return scopedPools.run(testingPool, task)
}

let pool = new PreviewBrowserPool()
export function withPreviewPage<T>(
  kind: PreviewKind,
  task: (page: Page) => Promise<T>,
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  return (scopedPools.getStore() ?? pool).run(kind, task, options)
}
export async function closePreviewBrowsers(): Promise<void> {
  const closing = pool
  pool = new PreviewBrowserPool()
  await closing.close()
}
