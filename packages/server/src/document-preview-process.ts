import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { Browser, ConnectOverCDPTransport } from "playwright-core"

type Driver = typeof import("playwright-core")
/** Match release artifacts in development and tests. The public Chromium path
 * locates Playwright's configured cache only; full Chrome is never launched. */
export function resolveHeadlessPreviewExecutable(
  driver: Driver,
  driverRoot: string
): string {
  const pkg = JSON.parse(readFileSync(join(driverRoot, "package.json"), "utf8"))
  if (pkg.version !== "1.61.1")
    throw new Error("Preview driver version mismatch")
  const descriptors = JSON.parse(
    readFileSync(join(driverRoot, "browsers.json"), "utf8")
  ).browsers
  const chromium = descriptors.find(
    (entry: { name: string }) => entry.name === "chromium"
  )
  const headless = descriptors.find(
    (entry: { name: string }) => entry.name === "chromium-headless-shell"
  )
  if (
    !/^\d+$/.test(headless?.revision) ||
    headless.browserVersion !== chromium?.browserVersion
  )
    throw new Error("Preview headless browser identity mismatch")
  let directory = dirname(driver.chromium.executablePath())
  while (basename(directory) !== `chromium-${chromium.revision}`) {
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error("Cannot locate the pinned Playwright browser cache")
    directory = parent
  }
  // Exact archive layouts verified against the pinned driver and release staging.
  const executables: Record<string, string> = {
    "linux-x64": "chrome-headless-shell-linux64/chrome-headless-shell",
    "linux-arm64": "chrome-linux/headless_shell",
    "darwin-x64": "chrome-headless-shell-mac-x64/chrome-headless-shell",
    "darwin-arm64": "chrome-headless-shell-mac-arm64/chrome-headless-shell",
  }
  const executable = executables[`${process.platform}-${process.arch}`]
  if (!executable) throw new Error("Unsupported preview browser platform")
  const path = join(
    dirname(directory),
    `chromium_headless_shell-${headless.revision}`,
    executable
  )
  if (!existsSync(path))
    throw new Error(
      "Pinned preview headless browser is missing; install the development browser prerequisites"
    )
  return path
}

type PreviewProcess = Bun.Subprocess<"ignore", "ignore", "pipe">
export type SpawnPreviewProcess = (
  command: string[],
  env: Record<string, string>
) => PreviewProcess
const spawnProcess: SpawnPreviewProcess = (command, env) =>
  Bun.spawn(command, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    detached: true,
    env,
  })

/** Own the process with Bun's native API, avoiding its child_process extra-FD
 * finalizer bug. Public CDP transport uses native WebSocket, avoiding the Node
 * ws/custom-Agent path. No authored document can choose these arguments. */
export async function launchPreviewBrowserProcess(
  driver: Driver,
  executable: string,
  spawn: SpawnPreviewProcess = spawnProcess
): Promise<{ browser: Browser; server: { kill(): Promise<void> } }> {
  const profile = await mkdtemp(join(tmpdir(), "worktable-preview-"))
  let child: PreviewProcess | undefined
  let socket: WebSocket | undefined
  let stopping: Promise<void> | undefined
  let stderr = ""
  let groupTerminated = false
  const terminateGroup = () => {
    if (!child || groupTerminated) return
    groupTerminated = true
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  const stop = () =>
    (stopping ??= (async () => {
      socket?.close()
      terminateGroup()
      if (child) await child.exited
      await rm(profile, { recursive: true, force: true })
    })())
  try {
    child = spawn(
      [
        executable,
        "--headless",
        "--no-startup-window",
        "--no-first-run",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-dev-shm-usage",
        "--disable-breakpad",
        "--disable-search-engine-choice-screen",
        "--no-default-browser-check",
        "--password-store=basic",
        "--use-mock-keychain",
        "--mute-audio",
        "--hide-scrollbars",
        "--force-color-profile=srgb",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--host-resolver-rules=MAP * ~NOTFOUND",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
      ],
      {
        HOME: profile,
        TMPDIR: tmpdir(),
        XDG_CACHE_HOME: join(profile, "cache"),
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
      }
    )
    // No --no-sandbox: Chromium's OS sandbox is mandatory in production.
    const running = child
    // Reap descendants immediately even if the parent exits unexpectedly.
    // Terminate at most once so later cleanup never signals a reused PID.
    void running.exited.then(() => stop()).catch(() => {})
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of running.stderr)
        stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-8192)
    })().catch(() => {})
    const expires = Date.now() + 15_000
    let endpoint: string | undefined
    while (Date.now() < expires) {
      if (running.exitCode !== null || running.signalCode !== null)
        throw new Error(`Preview browser exited: ${stderr.trim()}`)
      try {
        const [port, path] = (
          await readFile(join(profile, "DevToolsActivePort"), "utf8")
        )
          .trim()
          .split("\n")
        if (
          /^\d+$/.test(port!) &&
          Number(port) > 0 &&
          Number(port) <= 65535 &&
          /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path!)
        ) {
          endpoint = `ws://127.0.0.1:${port}${path}`
          break
        }
      } catch {}
      await Bun.sleep(25)
    }
    if (!endpoint)
      throw new Error("Preview browser startup exceeded its time budget")
    socket = new WebSocket(endpoint)
    const connectedSocket = socket
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Preview browser connection timed out")),
        Math.max(1, expires - Date.now())
      )
      const cleanup = () => clearTimeout(timer)
      connectedSocket.addEventListener(
        "open",
        () => {
          cleanup()
          resolve()
        },
        { once: true }
      )
      connectedSocket.addEventListener(
        "error",
        () => {
          cleanup()
          reject(new Error("Preview browser connection failed"))
        },
        { once: true }
      )
      connectedSocket.addEventListener(
        "close",
        () => {
          cleanup()
          reject(new Error("Preview browser exited during connection"))
        },
        { once: true }
      )
    })
    const transport: ConnectOverCDPTransport = {
      send: (message) => connectedSocket.send(JSON.stringify(message)),
      close: () => connectedSocket.close(),
    }
    connectedSocket.addEventListener("message", (event) => {
      try {
        transport.onmessage?.(JSON.parse(String(event.data)))
      } catch {
        connectedSocket.close(1002, "Invalid browser protocol message")
      }
    })
    connectedSocket.addEventListener("close", () => transport.onclose?.())
    const browser = await driver.chromium.connectOverCDP(transport, {
      timeout: Math.max(1, expires - Date.now()),
      isLocal: true,
    })
    return { browser, server: { kill: stop } }
  } catch (error) {
    await stop()
    throw error
  }
}
