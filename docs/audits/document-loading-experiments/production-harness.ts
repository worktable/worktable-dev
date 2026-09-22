import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:net"
import { stripVTControlCharacters } from "node:util"

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

async function allocatePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const reservation = createServer()
    reservation.unref()
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address()
      if (!address || typeof address === "string") {
        reservation.close()
        reject(new Error("Could not allocate a browser harness port"))
        return
      }
      reservation.close((error) => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })
}

function isPortCollision(output: string): boolean {
  return /EADDRINUSE|address already in use|(?:is )?port \d+ (?:is )?(?:already )?in use/i.test(
    output
  )
}

export interface WebHarness {
  apiUrl: string
  webUrl: string
  workspacePath: (...parts: string[]) => string
  stop: () => Promise<void>
}

function startProcess(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  children: ChildProcess[],
  processOutput: Map<ChildProcess, string[]>
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const output: string[] = []
  const capture = (chunk: Buffer) => {
    output.push(chunk.toString())
    if (output.length > 80) output.shift()
  }
  child.stdout?.on("data", capture)
  child.stderr?.on("data", capture)
  processOutput.set(child, output)
  children.push(child)
  return child
}

async function waitForHttp(
  url: string,
  child: ChildProcess,
  processOutput: Map<ChildProcess, string[]>,
  options: {
    readyOutput: RegExp
    sameOriginRequest?: boolean
    validateResponse?: (response: Response) => Promise<boolean>
  }
): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (hasExited(child)) {
      throw new Error(
        `Process exited (${exitDescription(child)}) while waiting for ${url}:\n${processOutput.get(child)?.join("") ?? ""}`
      )
    }
    const output = stripVTControlCharacters(
      processOutput.get(child)?.join("") ?? ""
    )
    if (!options.readyOutput.test(output)) {
      // test-policy: external-readiness-backoff
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
      continue
    }
    try {
      const response = await fetch(url, {
        headers: options.sameOriginRequest
          ? { Origin: new URL(url).origin }
          : undefined,
      })
      const valid =
        response.ok &&
        (!options.validateResponse ||
          (await options.validateResponse(response.clone())))
      // A stale process may answer the fixed port while our child is failing
      // its bind. The child must both announce its own readiness and still be
      // alive after the response before that response can satisfy the harness.
      if (valid && !hasExited(child)) return
    } catch {
      // The process is still starting.
    }
    // test-policy: external-readiness-backoff
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(
    `Timed out waiting for ${url}:\n${processOutput.get(child)?.join("") ?? ""}`
  )
}

async function startOnAllocatedPort(
  start: (port: number) => ChildProcess,
  urlForPort: (port: number) => string,
  processOutput: Map<ChildProcess, string[]>,
  options: {
    readyOutput: RegExp
    sameOriginRequest?: boolean
    validateResponse?: (response: Response) => Promise<boolean>
  }
): Promise<{ child: ChildProcess; port: number; url: string }> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const port = await allocatePort()
    const url = urlForPort(port)
    const child = start(port)
    try {
      await waitForHttp(url, child, processOutput, options)
      return { child, port, url }
    } catch (error) {
      const output = processOutput.get(child)?.join("") ?? ""
      if (attempt === 5 || !isPortCollision(output)) throw error
      await stopChild(child)
    }
  }
  throw new Error("Could not start browser harness on an allocated port")
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function exitDescription(child: ChildProcess): string {
  if (child.exitCode !== null) return `code ${child.exitCode}`
  if (child.signalCode !== null) return `signal ${child.signalCode}`
  return "unknown status"
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    const finish = (exited: boolean) => {
      clearTimeout(timer)
      child.off("exit", onExit)
      resolveExit(exited)
    }
    child.once("exit", onExit)
    // Close the small race between the first check and registering the event.
    if (hasExited(child)) finish(true)
  })
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // The process may have exited between the check and the signal.
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (hasExited(child) || child.pid === undefined) return

  const gracefulExit = waitForExit(child, 5_000)
  signalChild(child, "SIGTERM")
  if (await gracefulExit) return

  signalChild(child, "SIGKILL")
  if (!(await waitForExit(child, 2_000))) {
    throw new Error(`Process ${child.pid} did not exit after SIGKILL`)
  }
}

export async function startWebHarness(
  name: string,
  options: { onboarding?: "pending" | "complete"; storageVersion?: 2 } = {}
): Promise<WebHarness> {
  const tempRoot = await mkdtemp(join(tmpdir(), `worktable-${name}-`))
  const workspace = join(tempRoot, "workspace")
  const appDir = join(tempRoot, "app")
  await mkdir(workspace, { recursive: true })
  await mkdir(appDir, { recursive: true })
  if (options.storageVersion === 2) {
    await writeFile(
      join(workspace, "worktable.workspace.json"),
      JSON.stringify({
        type: "worktable.workspace",
        version: 2,
        id: `ws_${crypto.randomUUID()}`,
        name,
        createdAt: new Date().toISOString(),
        cloud: { status: "unlinked" },
      })
    )
  }
  const canonicalWorkspace = await realpath(workspace)

  const children: ChildProcess[] = []
  const processOutput = new Map<ChildProcess, string[]>()
  try {
    const api = await startOnAllocatedPort(
      (port) =>
        startProcess(
          "bun",
          ["run", "src/index.ts"],
          join(repoRoot, "packages/server"),
          {
            HOST: "127.0.0.1",
            PORT: String(port),
            WORKTABLE_WORKSPACE: workspace,
            WORKTABLE_APP_DIR: appDir,
          },
          children,
          processOutput
        ),
      (port) => `http://127.0.0.1:${port}/api/workspace`,
      processOutput,
      {
        readyOutput: /\[Worktable server\] running on /,
        // The workspace root is deliberately owner + same-origin only. Bun's
        // fetch identifies itself as a CORS request, so make this readiness
        // probe's same-origin provenance explicit before validating the root.
        sameOriginRequest: true,
        validateResponse: async (response) => {
          const body = (await response.json().catch(() => null)) as {
            root?: unknown
          } | null
          if (typeof body?.root !== "string") return false
          return (
            (await realpath(body.root).catch(() => null)) === canonicalWorkspace
          )
        },
      }
    )
    const apiPort = api.port
    const apiUrl = `http://127.0.0.1:${apiPort}`

    // Most browser suites exercise established-workspace behavior. Keep that
    // default explicit now that a genuinely new manifest starts onboarding;
    // the onboarding suite opts into the untouched pending state.
    if (options.onboarding !== "pending") {
      const completed = await fetch(`${apiUrl}/api/workspace`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboarding: { status: "complete" } }),
      })
      if (!completed.ok) {
        throw new Error(
          `Could not prepare completed onboarding state (${completed.status})`
        )
      }
    }

    const webUrl = apiUrl

    return {
      apiUrl,
      webUrl,
      workspacePath: (...parts) => join(workspace, ...parts),
      stop: async () => {
        await Promise.all(children.map(stopChild))
        // Keep the review workspace for the user.
      },
    }
  } catch (error) {
    await Promise.all(children.map(stopChild))
    // Keep the review workspace for the user.
    throw error
  }
}
