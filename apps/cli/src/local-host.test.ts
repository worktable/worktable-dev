import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { LOCAL_PROOF_HEADER } from "@worktable/server/runtime"
import { cliTestEnvironment, createCliTestWorker } from "./cli-test-harness.ts"

const cliEntry = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts")
const workerHome = mkdtempSync(join(tmpdir(), "worktable-local-host-worker-"))
const cliTestWorker = createCliTestWorker(workerHome)
let root: string
let appDir: string
let environment: Record<string, string>

setDefaultTimeout(30_000)
const LOCAL_TEST_READINESS_TIMEOUT_MS = 12_000

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "worktable-local-authority-cli-"))
  appDir = join(root, "app")
  environment = cliTestEnvironment(join(root, "home"), {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    WORKTABLE_APP_DIR: appDir,
    WORKTABLE_SERVICE_BACKEND: "unsupported",
    WORKTABLE_NO_UPDATE_CHECK: "1",
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

afterAll(async () => {
  await cliTestWorker.close()
  rmSync(workerHome, { recursive: true, force: true })
})

async function runCli(args: string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  if (environment.WORKTABLE_SERVICE_BACKEND === "process") {
    return runCliSubprocess(args)
  }
  return cliTestWorker.runAsync(args, environment)
}

async function runCliSubprocess(args: string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const child = Bun.spawn([process.execPath, cliEntry, ...args], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function prepare(path: string): Promise<void> {
  const result = await runCli([
    "workspace",
    "prepare",
    path,
    "--intent",
    "create",
    "--json",
  ])
  expect(result.exitCode).toBe(0)
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const port = server.port!
  server.stop(true)
  return port
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + LOCAL_TEST_READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    // test-policy: external-readiness-backoff
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function waitForFileRemoval(path: string): Promise<void> {
  const deadline = Date.now() + LOCAL_TEST_READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!existsSync(path)) return
    // test-policy: external-readiness-backoff
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${path} to be removed`)
}

async function waitForWorktableHealth(
  port: number,
  proofToken?: string
): Promise<void> {
  const deadline = Date.now() + LOCAL_TEST_READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        ...(proofToken
          ? { headers: { [LOCAL_PROOF_HEADER]: proofToken } }
          : {}),
      })
      if (response.ok) {
        const health = (await response.json()) as { service?: unknown }
        if (
          health.service === "worktable" &&
          (!proofToken ||
            response.headers.get(LOCAL_PROOF_HEADER) === "verified")
        ) {
          return
        }
      }
    } catch {
      // The foreground host may still be binding its endpoint.
    }
    // test-policy: external-readiness-backoff
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for Worktable health on port ${port}`)
}

describe("local-authority state model and command integration", () => {
  it("types corrupt config and recreates it through shared setup", async () => {
    const workspace = join(root, "corrupt-config-repair")
    await prepare(workspace)
    expect(
      (
        await runCli([
          "setup",
          "--yes",
          "--skip-mcp",
          "--foreground",
          "--no-launch",
          "--workspace",
          workspace,
        ])
      ).exitCode
    ).toBe(0)
    const configPath = join(appDir, "config.json")
    writeFileSync(configPath, "{ not valid json\n")
    rmSync(`${configPath}.bak`, { force: true })

    const inspection = await runCli(["local-host", "inspect", "--json"])
    expect(inspection.exitCode).toBe(1)
    expect(JSON.parse(inspection.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { code: "CONFIG_CORRUPT" },
    })

    const repaired = await runCli([
      "setup",
      "--yes",
      "--skip-mcp",
      "--foreground",
      "--no-launch",
      "--workspace",
      workspace,
    ])
    expect(repaired.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(configPath, "utf8")).workspace).toBe(
      workspace
    )
    expect(readFileSync(`${configPath}.corrupt`, "utf8")).toBe(
      "{ not valid json\n"
    )
  })

  it("keeps stable distinct endpoints and emits secret-free JSON", async () => {
    const first = join(root, "first")
    const second = join(root, "second")
    await prepare(first)
    await prepare(second)
    const firstPort = await freePort()

    const activatedFirst = await runCli([
      "local-host",
      "activate",
      first,
      "--port",
      String(firstPort),
      "--json",
    ])
    expect(activatedFirst.exitCode).toBe(0)
    const firstResult = JSON.parse(activatedFirst.stdout)
    expect(firstResult).toMatchObject({
      schemaVersion: 1,
      ok: true,
      action: "start-owned",
      port: firstPort,
    })

    const activatedSecond = await runCli([
      "local-host",
      "activate",
      second,
      "--json",
    ])
    expect(activatedSecond.exitCode).toBe(0)
    const secondResult = JSON.parse(activatedSecond.stdout)
    expect(secondResult.port).not.toBe(firstPort)

    const inspection = await runCli(["local-host", "inspect", "--json"])
    expect(inspection.exitCode).toBe(0)
    expect(inspection.stdout.trim().split("\n")).toHaveLength(1)
    const inspected = JSON.parse(inspection.stdout)
    expect(inspected.workspaces).toHaveLength(2)
    expect(inspected.activeWorkspace.path).toBe(second)
    expect(inspected.runtime).toBeNull()
    expect(inspection.stdout).not.toContain("proofToken")
    expect(inspection.stdout).not.toContain("WORKTABLE_LOCAL_PROOF_TOKEN")
  })

  it("reuses the registered host and port when returning to a known workspace", async () => {
    const first = join(root, "known-loopback")
    const second = join(root, "known-reachable")
    await prepare(first)
    await prepare(second)
    const firstPort = await freePort()
    const firstActivation = await runCli([
      "local-host",
      "activate",
      first,
      "--port",
      String(firstPort),
      "--json",
    ])
    expect(firstActivation.exitCode).toBe(0)
    expect(JSON.parse(firstActivation.stdout)).toMatchObject({
      host: "127.0.0.1",
      port: firstPort,
    })

    const configPath = join(appDir, "config.json")
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    config.service.host = "0.0.0.0"
    config.service.reachable = true
    config.service.exposureAcknowledged = true
    config.mcp.endpoint = `http://127.0.0.1:${config.service.port}/mcp`
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")

    const secondActivation = await runCli([
      "local-host",
      "activate",
      second,
      "--json",
    ])
    expect(secondActivation.exitCode).toBe(0)
    expect(JSON.parse(secondActivation.stdout).host).toBe("0.0.0.0")

    const returned = await runCli(["local-host", "activate", first, "--json"])
    expect(returned.exitCode).toBe(0)
    expect(JSON.parse(returned.stdout)).toMatchObject({
      host: "127.0.0.1",
      port: firstPort,
    })
    const registry = JSON.parse(
      readFileSync(join(appDir, "local-workspaces.json"), "utf8")
    )
    expect(
      registry.workspaces.find(
        (entry: { path: string }) => entry.path === first
      )
    ).toMatchObject({ host: "127.0.0.1", port: firstPort })
  })

  it("reuses a registered endpoint when the same workspace identity moves", async () => {
    const original = join(root, "workspace-before-move")
    const moved = join(root, "workspace-after-move")
    await prepare(original)
    const port = await freePort()
    const configured = await runCli([
      "setup",
      "--yes",
      "--skip-mcp",
      "--no-launch",
      "--workspace",
      original,
      "--port",
      String(port),
    ])
    expect(configured.exitCode).toBe(0)
    const manifest = JSON.parse(
      readFileSync(join(original, "worktable.workspace.json"), "utf8")
    ) as { id: string }

    renameSync(original, moved)
    const relocated = await runCli([
      "setup",
      "--yes",
      "--skip-mcp",
      "--no-launch",
      "--workspace",
      moved,
    ])
    expect(relocated.exitCode).toBe(0)
    expect(
      JSON.parse(readFileSync(join(appDir, "config.json"), "utf8"))
    ).toMatchObject({
      workspace: moved,
      service: { host: "127.0.0.1", port },
    })
    const registry = JSON.parse(
      readFileSync(join(appDir, "local-workspaces.json"), "utf8")
    ) as {
      workspaces: Array<{
        workspaceId: string
        path: string
        host: string
        port: number
      }>
    }
    expect(
      registry.workspaces.find((entry) => entry.workspaceId === manifest.id)
    ).toMatchObject({ path: moved, host: "127.0.0.1", port })
  })

  it("restores a known workspace endpoint through setup and launch", async () => {
    const first = join(root, "ordinary-return-loopback")
    const second = join(root, "ordinary-return-reachable")
    await prepare(first)
    await prepare(second)
    const firstPort = await freePort()
    expect(
      (
        await runCli([
          "local-host",
          "activate",
          first,
          "--port",
          String(firstPort),
          "--json",
        ])
      ).exitCode
    ).toBe(0)

    const configPath = join(appDir, "config.json")
    const makeCurrentWorkspaceReachable = (): void => {
      const config = JSON.parse(readFileSync(configPath, "utf8"))
      config.service.host = "0.0.0.0"
      config.service.reachable = true
      config.service.exposureAcknowledged = true
      config.mcp.endpoint = `http://127.0.0.1:${config.service.port}/mcp`
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
    }
    makeCurrentWorkspaceReachable()
    expect(
      (await runCli(["local-host", "activate", second, "--json"])).exitCode
    ).toBe(0)

    const setup = await runCli([
      "setup",
      "--yes",
      "--skip-mcp",
      "--no-launch",
      "--workspace",
      first,
    ])
    expect(setup.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      workspace: first,
      service: { host: "127.0.0.1", port: firstPort },
    })

    expect(
      (await runCli(["local-host", "activate", second, "--json"])).exitCode
    ).toBe(0)
    const launched = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "launch",
        "--foreground",
        "--no-browser",
        "--workspace",
        first,
      ],
      {
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    try {
      const runtimePath = join(appDir, "local-runtime.json")
      await waitForFile(runtimePath)
      expect(JSON.parse(readFileSync(runtimePath, "utf8"))).toMatchObject({
        workspacePath: first,
        host: "127.0.0.1",
        port: firstPort,
      })
    } finally {
      launched.kill("SIGTERM")
      await launched.exited
    }
  }, 30_000)

  it("does not infer exposure acknowledgement from a registered host", async () => {
    const first = join(root, "unacknowledged-reachable")
    const second = join(root, "current-loopback")
    await prepare(first)
    await prepare(second)
    expect(
      (await runCli(["local-host", "activate", first, "--json"])).exitCode
    ).toBe(0)

    const registryPath = join(appDir, "local-workspaces.json")
    const registry = JSON.parse(readFileSync(registryPath, "utf8"))
    const registeredFirst = registry.workspaces.find(
      (entry: { path: string }) => entry.path === first
    )
    registeredFirst.host = "0.0.0.0"
    writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n")

    expect(
      (await runCli(["local-host", "activate", second, "--json"])).exitCode
    ).toBe(0)
    const returned = await runCli(["local-host", "activate", first, "--json"])
    expect(returned.exitCode).toBe(0)
    expect(JSON.parse(returned.stdout).host).toBe("0.0.0.0")
    expect(
      JSON.parse(readFileSync(join(appDir, "config.json"), "utf8"))
    ).toMatchObject({
      workspace: first,
      service: {
        host: "0.0.0.0",
        reachable: true,
        exposureAcknowledged: false,
      },
    })
  })

  it("refuses to attach a copied workspace identity to the original live path", async () => {
    const original = join(root, "original")
    const copied = join(root, "copied")
    await prepare(original)
    cpSync(original, copied, { recursive: true })
    const port = await freePort()
    const owner = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "launch",
        "--foreground",
        "--no-browser",
        "--workspace",
        original,
        "--port",
        String(port),
      ],
      { env: environment, stdout: "pipe", stderr: "pipe" }
    )
    try {
      await waitForFile(join(appDir, "local-runtime.json"))
      // Simulate a pre-authority-lock foreground host that still carries a valid,
      // endpoint-proven runtime lease. The workspace path remains authoritative
      // even when a copied manifest retains the same workspace ID.
      rmSync(join(appDir, "local-authority.lock"), { force: true })
      const configPath = join(appDir, "config.json")
      const registryPath = join(appDir, "local-workspaces.json")
      const beforeConfig = readFileSync(configPath, "utf8")
      const beforeRegistry = readFileSync(registryPath, "utf8")

      const refused = await runCli(["local-host", "activate", copied, "--json"])
      expect(refused.exitCode).toBe(1)
      expect(JSON.parse(refused.stdout)).toMatchObject({
        ok: false,
        error: { code: "ACTIVATION_FAILED" },
      })
      expect(refused.stdout).toContain(original)
      expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
      expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)
    } finally {
      owner.kill("SIGTERM")
      await owner.exited
    }
  })

  it("refuses a health-only Worktable listener without reserving its endpoint", async () => {
    const workspace = join(root, "unproven-listener")
    await prepare(workspace)
    const port = await freePort()
    expect(
      (
        await runCli([
          "local-host",
          "activate",
          workspace,
          "--port",
          String(port),
          "--json",
        ])
      ).exitCode
    ).toBe(0)
    const configPath = join(appDir, "config.json")
    const registryPath = join(appDir, "local-workspaces.json")
    const beforeConfig = readFileSync(configPath, "utf8")
    const beforeRegistry = readFileSync(registryPath, "utf8")
    const listener = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(JSON.stringify({ ok: true, service: "worktable" }), {
          headers: { "Content-Type": "application/json" },
        }),
    })
    try {
      const refused = await runCli(["launch", "--no-browser"])
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr).toContain(
        "has not proven the requested workspace and endpoint ownership"
      )
      expect(refused.stdout).not.toContain("already running")
      expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
      expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)
    } finally {
      listener.stop(true)
    }
  })

  it("recognizes a legacy launchd service that predates the owner marker", async () => {
    const workspace = join(root, "legacy-service")
    await prepare(workspace)
    const port = await freePort()
    const service = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "launch",
        "--foreground",
        "--no-browser",
        "--workspace",
        workspace,
        "--port",
        String(port),
      ],
      {
        env: { ...environment, XPC_SERVICE_NAME: "dev.worktable.local" },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    try {
      await waitForFile(join(appDir, "local-runtime.json"))
      await waitForWorktableHealth(port)
      expect(
        JSON.parse(readFileSync(join(appDir, "local-runtime.json"), "utf8"))
      ).toMatchObject({ owner: "service", workspacePath: workspace, port })
    } finally {
      service.kill("SIGTERM")
      await service.exited
    }
    expect(existsSync(join(appDir, "local-runtime.json"))).toBe(false)
  })

  it("rolls back config and registry when a committed endpoint collides", async () => {
    const first = join(root, "first")
    const second = join(root, "second")
    await prepare(first)
    await prepare(second)
    const firstPort = await freePort()
    const activated = await runCli([
      "local-host",
      "activate",
      first,
      "--port",
      String(firstPort),
      "--json",
    ])
    expect(activated.exitCode).toBe(0)
    const configPath = join(appDir, "config.json")
    const registryPath = join(appDir, "local-workspaces.json")
    const beforeConfig = readFileSync(configPath, "utf8")
    const beforeRegistry = readFileSync(registryPath, "utf8")

    const refused = await runCli([
      "local-host",
      "activate",
      second,
      "--port",
      String(firstPort),
      "--json",
    ])
    expect(refused.exitCode).toBe(1)
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      error: { code: "ACTIVATION_FAILED" },
    })

    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
    expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)
    expect(existsSync(join(appDir, "local-activation.json"))).toBe(false)
  })

  it("restores config when a direct launch cannot reserve its pinned endpoint", async () => {
    const first = join(root, "first")
    const second = join(root, "second")
    await prepare(first)
    await prepare(second)
    const firstPort = await freePort()
    expect(
      (
        await runCli([
          "local-host",
          "activate",
          first,
          "--port",
          String(firstPort),
          "--json",
        ])
      ).exitCode
    ).toBe(0)
    const configPath = join(appDir, "config.json")
    const registryPath = join(appDir, "local-workspaces.json")
    const beforeConfig = readFileSync(configPath, "utf8")
    const beforeRegistry = readFileSync(registryPath, "utf8")

    const refused = await runCli([
      "launch",
      "--foreground",
      "--no-browser",
      "--workspace",
      second,
      "--port",
      String(firstPort),
    ])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("belongs to")
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
    expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)
  })

  it("reserves wildcard and loopback aliases from the same stable port space", async () => {
    const first = join(root, "first")
    const second = join(root, "second")
    await prepare(first)
    await prepare(second)
    const firstPort = await freePort()
    expect(
      (
        await runCli([
          "local-host",
          "activate",
          first,
          "--port",
          String(firstPort),
          "--json",
        ])
      ).exitCode
    ).toBe(0)
    const configPath = join(appDir, "config.json")
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    config.service.host = "0.0.0.0"
    config.service.reachable = true
    config.service.exposureAcknowledged = true
    config.mcp.endpoint = `http://127.0.0.1:${firstPort}/mcp`
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")

    const activated = await runCli(["local-host", "activate", second, "--json"])
    expect(activated.exitCode).toBe(0)
    expect(JSON.parse(activated.stdout).port).not.toBe(firstPort)
  })

  it("adopts a proven live endpoint with starter seed enabled when config and registry drift", async () => {
    const workspace = join(root, "workspace")
    await prepare(workspace)
    const runningPort = await freePort()
    const driftedPort =
      runningPort === 65_535 ? runningPort - 1 : runningPort + 1
    const owner = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "launch",
        "--foreground",
        "--no-browser",
        "--workspace",
        workspace,
        "--port",
        String(runningPort),
      ],
      {
        env: { ...environment, WORKTABLE_SKIP_STARTER_SEED: "0" },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    let ownerStopped = false
    try {
      await waitForFile(join(appDir, "local-runtime.json"))
      // The lease is published just before the foreground launch commits its
      // transition by releasing this lock. Exercise attach after that boundary.
      await waitForFileRemoval(join(appDir, "local-authority.lock"))
      const { proofToken } = JSON.parse(
        readFileSync(join(appDir, "local-runtime.json"), "utf8")
      ) as { proofToken: string }
      await waitForWorktableHealth(runningPort, proofToken)
      const configPath = join(appDir, "config.json")
      const registryPath = join(appDir, "local-workspaces.json")
      const config = JSON.parse(readFileSync(configPath, "utf8"))
      config.service.port = driftedPort
      config.mcp.endpoint = `http://127.0.0.1:${driftedPort}/mcp`
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
      const registry = JSON.parse(readFileSync(registryPath, "utf8"))
      registry.workspaces[0].port = driftedPort
      writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n")

      const attached = await runCli([
        "local-host",
        "activate",
        workspace,
        "--wait-for-welcome",
        "--json",
      ])
      if (attached.exitCode !== 0) {
        owner.kill("SIGTERM")
        const [ownerExitCode, ownerStdout, ownerStderr] = await Promise.all([
          owner.exited,
          new Response(owner.stdout).text(),
          new Response(owner.stderr).text(),
        ])
        ownerStopped = true
        throw new Error(
          `activate exited ${attached.exitCode}\nstdout:\n${attached.stdout || "(empty)"}\nstderr:\n${attached.stderr || "(empty)"}\nowner exited ${ownerExitCode}\nowner stdout tail:\n${ownerStdout.slice(-4_000) || "(empty)"}\nowner stderr tail:\n${ownerStderr.slice(-4_000) || "(empty)"}`
        )
      }
      expect(JSON.parse(attached.stdout)).toMatchObject({
        ok: true,
        action: "attach",
        owner: "cli",
        port: runningPort,
      })
      expect(JSON.parse(readFileSync(configPath, "utf8")).service.port).toBe(
        runningPort
      )
      expect(
        JSON.parse(readFileSync(registryPath, "utf8")).workspaces[0].port
      ).toBe(runningPort)
      expect(
        existsSync(
          join(
            workspace,
            "spaces",
            "welcome",
            "widgets",
            "welcome",
            "index.html"
          )
        )
      ).toBe(true)
    } finally {
      if (!ownerStopped) {
        owner.kill("SIGTERM")
        await owner.exited
      }
    }
  }, 30_000)

  it("rolls back a failed live-endpoint reconciliation", async () => {
    const first = join(root, "first")
    const second = join(root, "second")
    await prepare(first)
    await prepare(second)
    const runningPort = await freePort()
    const driftedPort =
      runningPort === 65_535 ? runningPort - 1 : runningPort + 1
    const owner = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "launch",
        "--foreground",
        "--no-browser",
        "--workspace",
        first,
        "--port",
        String(runningPort),
      ],
      { env: environment, stdout: "pipe", stderr: "pipe" }
    )
    try {
      await waitForFile(join(appDir, "local-runtime.json"))
      const configPath = join(appDir, "config.json")
      const registryPath = join(appDir, "local-workspaces.json")
      const config = JSON.parse(readFileSync(configPath, "utf8"))
      config.service.port = driftedPort
      config.mcp.endpoint = `http://127.0.0.1:${driftedPort}/mcp`
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
      const registry = JSON.parse(readFileSync(registryPath, "utf8"))
      registry.workspaces[0].port = driftedPort
      const secondManifest = JSON.parse(
        readFileSync(join(second, "worktable.workspace.json"), "utf8")
      )
      registry.workspaces.push({
        workspaceId: secondManifest.id,
        name: secondManifest.name,
        path: second,
        host: "127.0.0.1",
        port: runningPort,
        lastUsedAt: new Date().toISOString(),
      })
      writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n")
      const beforeConfig = JSON.parse(readFileSync(configPath, "utf8"))
      const beforeRegistry = JSON.parse(readFileSync(registryPath, "utf8"))

      const refused = await runCli(["local-host", "activate", first, "--json"])
      expect(refused.exitCode).toBe(1)
      expect(JSON.parse(refused.stdout)).toMatchObject({
        ok: false,
        error: { code: "ACTIVATION_FAILED" },
      })
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(beforeConfig)
      expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual(
        beforeRegistry
      )
      expect(existsSync(join(appDir, "local-activation.json"))).toBe(false)
    } finally {
      owner.kill("SIGTERM")
      await owner.exited
    }
  })

  it("retries an unreachable live lease but blocks a rejected proof", async () => {
    const first = join(root, "first")
    const second = join(root, "second")
    await prepare(first)
    await prepare(second)
    expect(
      (await runCli(["local-host", "activate", first, "--json"])).exitCode
    ).toBe(0)
    const configPath = join(appDir, "config.json")
    const registryPath = join(appDir, "local-workspaces.json")
    const manifest = JSON.parse(
      readFileSync(join(first, "worktable.workspace.json"), "utf8")
    )
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    const proofToken = "unverified-runtime-proof-token-that-is-long-enough"
    writeFileSync(
      join(appDir, "local-runtime.json"),
      JSON.stringify({
        schemaVersion: 1,
        owner: "desktop",
        pid: process.pid,
        installId: "test-install",
        workspaceId: manifest.id,
        workspacePath: first,
        host: config.service.host,
        port: config.service.port,
        nonce: "unverified-runtime-nonce",
        proofToken,
        startedAt: new Date().toISOString(),
      }) + "\n"
    )
    let proofRequests = 0
    let rejectProof = false
    let releaseFirstProof = (): void => {}
    const verifiedResponse = () =>
      Response.json(
        { ok: true, service: "worktable" },
        { headers: { [LOCAL_PROOF_HEADER]: "verified" } }
      )
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: config.service.port,
      fetch() {
        proofRequests += 1
        if (!rejectProof && proofRequests === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirstProof = () => resolve(verifiedResponse())
          })
        }
        releaseFirstProof()
        return rejectProof
          ? Response.json({ ok: true, service: "worktable" })
          : verifiedResponse()
      },
    })
    try {
      const attached = await runCli(["local-host", "activate", first, "--json"])
      expect(
        attached.exitCode,
        `stdout:\n${attached.stdout || "(empty)"}\nstderr:\n${attached.stderr || "(empty)"}`
      ).toBe(0)
      expect(proofRequests).toBeGreaterThanOrEqual(2)

      rejectProof = true
      const beforeConfig = readFileSync(configPath, "utf8")
      const beforeRegistry = readFileSync(registryPath, "utf8")
      const refused = await runCli(["local-host", "activate", second, "--json"])
      expect(refused.exitCode).toBe(1)
      expect(JSON.parse(refused.stdout)).toMatchObject({
        ok: false,
        error: { code: "ACTIVATION_FAILED" },
      })
      expect(refused.stdout).toContain("did not answer its ownership proof")
      expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
      expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)

      const repair = await runCli(["local-host", "recover", "--json"])
      expect(repair.exitCode).toBe(1)
      expect(JSON.parse(repair.stdout)).toMatchObject({
        ok: false,
        error: { code: "RECOVERY_FAILED" },
      })
      expect(existsSync(join(appDir, "local-runtime.json"))).toBe(true)
    } finally {
      releaseFirstProof()
      listener.stop(true)
    }
  })

  it("repairs dead and corrupt runtime leases without touching workspace state", async () => {
    const workspace = join(root, "workspace")
    await prepare(workspace)
    expect(
      (await runCli(["local-host", "activate", workspace, "--json"])).exitCode
    ).toBe(0)
    const configPath = join(appDir, "config.json")
    const registryPath = join(appDir, "local-workspaces.json")
    const runtimePath = join(appDir, "local-runtime.json")
    const beforeConfig = readFileSync(configPath, "utf8")
    const beforeRegistry = readFileSync(registryPath, "utf8")
    const manifest = JSON.parse(
      readFileSync(join(workspace, "worktable.workspace.json"), "utf8")
    )
    const config = JSON.parse(beforeConfig)
    writeFileSync(
      runtimePath,
      JSON.stringify({
        schemaVersion: 1,
        owner: "desktop",
        pid: 2_147_483_647,
        installId: "test-install",
        workspaceId: manifest.id,
        workspacePath: workspace,
        host: config.service.host,
        port: config.service.port,
        nonce: "stale-runtime-nonce",
        proofToken: "stale-runtime-proof-token-that-is-long-enough",
        startedAt: new Date().toISOString(),
      }) + "\n"
    )
    const cleared = await runCli(["local-host", "recover", "--json"])
    expect(cleared.exitCode).toBe(0)
    expect(JSON.parse(cleared.stdout)).toMatchObject({
      ok: true,
      action: "repaired",
      runtimeRepair: "cleared-stale-runtime",
    })
    expect(existsSync(runtimePath)).toBe(false)

    writeFileSync(runtimePath, "{not-json\n")
    const inspection = await runCli(["local-host", "inspect", "--json"])
    expect(inspection.exitCode).toBe(0)
    const inspected = JSON.parse(inspection.stdout)
    expect(inspected).toMatchObject({
      ok: true,
      runtime: null,
    })
    expect(typeof inspected.runtimeError).toBe("string")
    expect(inspected.runtimeErrorCode).toBeNull()
    const quarantined = await runCli(["local-host", "recover", "--json"])
    expect(quarantined.exitCode).toBe(0)
    expect(JSON.parse(quarantined.stdout)).toMatchObject({
      ok: true,
      action: "repaired",
      runtimeRepair: "quarantined-corrupt-runtime",
    })
    expect(existsSync(runtimePath)).toBe(false)
    expect(
      readdirSync(appDir).some((name) =>
        name.startsWith("local-runtime.corrupt-")
      )
    ).toBe(true)
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
    expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)

    writeFileSync(registryPath, "{not-json\n")
    const registryInspection = await runCli(["local-host", "inspect", "--json"])
    expect(registryInspection.exitCode).toBe(0)
    const inspectedRegistry = JSON.parse(registryInspection.stdout)
    expect(inspectedRegistry).toMatchObject({
      ok: true,
      activeWorkspace: null,
      workspaces: [],
    })
    expect(typeof inspectedRegistry.registryError).toBe("string")
    expect(inspectedRegistry.registryErrorCode).toBeNull()
    const rebuilt = await runCli(["local-host", "recover", "--json"])
    expect(rebuilt.exitCode).toBe(0)
    expect(JSON.parse(rebuilt.stdout)).toMatchObject({
      ok: true,
      action: "repaired",
      registryRepair: "rebuilt-corrupt-registry",
    })
    const repairedRegistry = JSON.parse(readFileSync(registryPath, "utf8"))
    expect(repairedRegistry.activeWorkspaceId).toBe(manifest.id)
    expect(repairedRegistry.workspaces).toHaveLength(1)
    expect(repairedRegistry.workspaces[0]).toMatchObject({
      workspaceId: manifest.id,
      path: workspace,
      port: config.service.port,
    })
    expect(
      readdirSync(appDir).some((name) =>
        name.startsWith("local-workspaces.corrupt-")
      )
    ).toBe(true)
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
  })

  it("leaves a newer runtime lease untouched during recovery", async () => {
    const workspace = join(root, "newer-runtime")
    await prepare(workspace)
    expect(
      (await runCli(["local-host", "activate", workspace, "--json"])).exitCode
    ).toBe(0)
    const runtimePath = join(appDir, "local-runtime.json")
    const newerRuntime =
      JSON.stringify({ schemaVersion: 2, owner: "desktop" }, null, 2) + "\n"
    writeFileSync(runtimePath, newerRuntime)

    const inspection = await runCli(["local-host", "inspect", "--json"])
    expect(inspection.exitCode).toBe(0)
    expect(JSON.parse(inspection.stdout)).toMatchObject({
      runtimeErrorCode: "LOCAL_RUNTIME_SCHEMA_UNSUPPORTED",
    })

    const recovered = await runCli(["local-host", "recover", "--json"])
    expect(recovered.exitCode).toBe(1)
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      ok: false,
      error: { code: "RECOVERY_FAILED" },
    })
    expect(recovered.stdout).toContain("Upgrade Worktable")
    expect(readFileSync(runtimePath, "utf8")).toBe(newerRuntime)
    expect(
      readdirSync(appDir).some((name) =>
        name.startsWith("local-runtime.corrupt-")
      )
    ).toBe(false)
  })

  it("leaves a newer workspace registry untouched during recovery", async () => {
    const workspace = join(root, "newer-registry")
    await prepare(workspace)
    expect(
      (await runCli(["local-host", "activate", workspace, "--json"])).exitCode
    ).toBe(0)
    const registryPath = join(appDir, "local-workspaces.json")
    const newerRegistry =
      JSON.stringify(
        {
          schemaVersion: 2,
          activeWorkspaceId: "ws_future",
          workspaces: [{ future: "preserve-me" }],
        },
        null,
        2
      ) + "\n"
    writeFileSync(registryPath, newerRegistry)

    const inspection = await runCli(["local-host", "inspect", "--json"])
    expect(inspection.exitCode).toBe(0)
    expect(JSON.parse(inspection.stdout)).toMatchObject({
      registryErrorCode: "LOCAL_REGISTRY_SCHEMA_UNSUPPORTED",
    })

    const recovered = await runCli(["local-host", "recover", "--json"])
    expect(recovered.exitCode).toBe(1)
    expect(recovered.stdout).toContain("Upgrade Worktable")
    expect(readFileSync(registryPath, "utf8")).toBe(newerRegistry)
    expect(
      readdirSync(appDir).some((name) =>
        name.startsWith("local-workspaces.corrupt-")
      )
    ).toBe(false)
  })

  it("doctor requires endpoint proof before reporting a live lease as an owner", async () => {
    const workspace = join(root, "unverified-doctor")
    await prepare(workspace)
    expect(
      (await runCli(["local-host", "activate", workspace, "--json"])).exitCode
    ).toBe(0)
    const manifest = JSON.parse(
      readFileSync(join(workspace, "worktable.workspace.json"), "utf8")
    )
    writeFileSync(
      join(appDir, "local-runtime.json"),
      JSON.stringify({
        schemaVersion: 1,
        owner: "desktop",
        pid: process.pid,
        installId: "test-install",
        workspaceId: manifest.id,
        workspacePath: workspace,
        host: "127.0.0.1",
        port: await freePort(),
        nonce: "unverified-doctor-runtime-nonce",
        proofToken: "unverified-doctor-proof-token-that-is-long-enough",
        startedAt: new Date().toISOString(),
      }) + "\n"
    )

    const doctor = await runCli(["doctor", "--check"])
    expect(doctor.exitCode).toBe(1)
    expect(doctor.stdout).toContain("Local host owner:      none")
    expect(doctor.stdout).toContain("Authority warning:")
    expect(doctor.stdout).toContain("did not prove ownership")
  })

  it("serializes transitions and recovers a dead owner's lock", async () => {
    const workspace = join(root, "locked")
    await prepare(workspace)
    const lockPath = join(appDir, "local-authority.lock")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      lockPath,
      JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: "live" })
    )

    const refused = await runCli([
      "launch",
      "--background",
      "--no-browser",
      "--workspace",
      workspace,
    ])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("transition is already running")
    expect(existsSync(lockPath)).toBe(true)

    writeFileSync(
      lockPath,
      JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, nonce: "dead" })
    )
    const recovered = await runCli([
      "local-host",
      "activate",
      workspace,
      "--json",
    ])
    expect(recovered.exitCode).toBe(0)
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      ok: true,
      action: "start-owned",
    })
    expect(existsSync(lockPath)).toBe(false)
  })

  it("never removes an incomplete authority lock from another publisher", async () => {
    const workspace = join(root, "incomplete-lock")
    await prepare(workspace)
    const lockPath = join(appDir, "local-authority.lock")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(lockPath, "")

    const refused = await runCli([
      "local-host",
      "activate",
      workspace,
      "--json",
    ])
    expect(refused.exitCode).toBe(1)
    expect(refused.stdout).toContain("incomplete local transition lock")
    expect(existsSync(lockPath)).toBe(true)
  })

  it("recovers an interrupted stale authority recovery claim", async () => {
    const workspace = join(root, "stale-recovery-claim")
    await prepare(workspace)
    const recoveryPath = join(appDir, "local-authority.recovery")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      recoveryPath,
      JSON.stringify({
        schemaVersion: 2,
        pid: 2_147_483_647,
        nonce: "dead-authority-recovery-claim",
        ownerIdentity: null,
      }) + "\n"
    )

    const recovered = await runCli([
      "local-host",
      "activate",
      workspace,
      "--json",
    ])
    expect(recovered.exitCode).toBe(0)
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      ok: true,
      action: "start-owned",
    })
    expect(existsSync(recoveryPath)).toBe(false)
  })

  it("recovers a stale authority lock after its PID is reused", async () => {
    const workspace = join(root, "recycled-lock")
    await prepare(workspace)
    const lockPath = join(appDir, "local-authority.lock")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 2,
        pid: process.pid,
        nonce: "stale-recycled-process-lock",
        ownerIdentity: "not-the-current-process-start",
      })
    )

    const recovered = await runCli([
      "local-host",
      "activate",
      workspace,
      "--json",
    ])
    expect(recovered.exitCode).toBe(0)
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      ok: true,
      action: "start-owned",
    })
    expect(existsSync(lockPath)).toBe(false)
  })

  it("requires standalone service children to acquire the transition lock", async () => {
    const workspace = join(root, "service-lock")
    await prepare(workspace)
    const lockPath = join(appDir, "local-authority.lock")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        nonce: "live-service-transition-owner",
      })
    )
    environment.WORKTABLE_LOCAL_OWNER = "service"
    const refused = await runCli([
      "launch",
      "--foreground",
      "--no-browser",
      "--workspace",
      workspace,
      "--port",
      String(await freePort()),
    ])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("transition is already running")
    expect(existsSync(join(appDir, "local-runtime.json"))).toBe(false)
    expect(existsSync(lockPath)).toBe(true)
  })

  it("does not expose a background-update handoff to ordinary CLI commands", async () => {
    const workspace = join(root, "update-handoff-is-service-only")
    await prepare(workspace)
    const lockPath = join(appDir, "local-authority.lock")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        nonce: "live-background-update-owner",
      })
    )
    writeFileSync(
      join(appDir, "update-status.json"),
      JSON.stringify({
        state: "restarting",
        from: "0.0.1",
        to: "0.0.2",
        pid: process.pid,
      })
    )

    const refused = await runCli([
      "local-host",
      "activate",
      workspace,
      "--json",
    ])
    expect(refused.exitCode).toBe(1)
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      error: { code: "ACTIVATION_FAILED" },
    })
    expect(existsSync(lockPath)).toBe(true)
  })

  it("rejects a service update handoff whose live PID owns a different nonce", async () => {
    const workspace = join(root, "update-handoff-exact-nonce")
    await prepare(workspace)
    const lockPath = join(appDir, "local-authority.lock")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        nonce: "live-background-update-owner",
      })
    )
    writeFileSync(
      join(appDir, "update-status.json"),
      JSON.stringify({
        state: "restarting",
        from: "0.0.1",
        to: "0.0.2",
        pid: process.pid,
        authorityNonce: "different-live-update-nonce",
      })
    )
    environment.WORKTABLE_LOCAL_OWNER = "service"

    const refused = await runCli([
      "launch",
      "--foreground",
      "--no-browser",
      "--workspace",
      workspace,
      "--port",
      String(await freePort()),
    ])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("transition is already running")
    expect(existsSync(join(appDir, "local-runtime.json"))).toBe(false)
    expect(existsSync(lockPath)).toBe(true)
  })

  it("accepts a service child handoff only while its parent owns the exact lock", async () => {
    const workspace = join(root, "service-handoff")
    await prepare(workspace)
    const port = await freePort()
    const lockPath = join(appDir, "local-authority.lock")
    const nonce = "live-service-handoff-nonce"
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      lockPath,
      JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce })
    )
    const service = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "launch",
        "--foreground",
        "--no-browser",
        "--workspace",
        workspace,
        "--port",
        String(port),
      ],
      {
        env: {
          ...environment,
          WORKTABLE_LOCAL_OWNER: "service",
          WORKTABLE_LOCAL_AUTHORITY_HANDOFF: JSON.stringify({
            pid: process.pid,
            nonce,
          }),
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    try {
      await waitForFile(join(appDir, "local-runtime.json"))
      await waitForWorktableHealth(port)
      expect(
        JSON.parse(readFileSync(join(appDir, "local-runtime.json"), "utf8"))
      ).toMatchObject({ owner: "service", workspacePath: workspace, port })
      expect(existsSync(lockPath)).toBe(true)
    } finally {
      service.kill("SIGTERM")
      await service.exited
    }
    expect(existsSync(join(appDir, "local-runtime.json"))).toBe(false)
  })

  it("setup refuses a health-only Worktable listener without a proven lease", async () => {
    const workspace = join(root, "setup-unproven-listener")
    await prepare(workspace)
    const port = await freePort()
    expect(
      (
        await runCli([
          "local-host",
          "activate",
          workspace,
          "--port",
          String(port),
          "--json",
        ])
      ).exitCode
    ).toBe(0)
    const configPath = join(appDir, "config.json")
    const registryPath = join(appDir, "local-workspaces.json")
    const beforeConfig = readFileSync(configPath, "utf8")
    const beforeRegistry = readFileSync(registryPath, "utf8")
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ ok: true, service: "worktable" }),
    })
    try {
      const refused = await runCli([
        "setup",
        "--yes",
        "--skip-mcp",
        "--no-launch",
        "--workspace",
        workspace,
        "--port",
        String(port),
      ])
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr).toContain("did not prove ownership")
      expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
      expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)
    } finally {
      listener.stop(true)
    }
  })

  it("setup rejects a stale snapshot after local state changes", async () => {
    const workspace = join(root, "setup-stale-snapshot")
    await prepare(workspace)
    expect(
      (await runCli(["local-host", "activate", workspace, "--json"])).exitCode
    ).toBe(0)
    const configPath = join(appDir, "config.json")
    const registryPath = join(appDir, "local-workspaces.json")
    const beforeRegistry = readFileSync(registryPath, "utf8")
    const port = await freePort()
    let mutatedConfig: string | null = null
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => {
        if (mutatedConfig === null) {
          mutatedConfig = `${readFileSync(configPath, "utf8")}\n`
          writeFileSync(configPath, mutatedConfig)
        }
        return Response.json({ ok: true, service: "worktable" })
      },
    })
    try {
      const refused = await runCli([
        "setup",
        "--yes",
        "--skip-mcp",
        "--no-launch",
        "--workspace",
        workspace,
        "--port",
        String(port),
      ])
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr).toContain(
        "changed while this command was waiting for input"
      )
      if (mutatedConfig === null) throw new Error("listener was not probed")
      expect(readFileSync(configPath, "utf8")).toBe(mutatedConfig)
      expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)
    } finally {
      listener.stop(true)
    }
  })

  it("uninstall refuses a live Desktop owner before removing shared state", async () => {
    const workspace = join(root, "desktop-owned-uninstall")
    await prepare(workspace)
    const port = await freePort()
    const owner = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "launch",
        "--foreground",
        "--no-browser",
        "--workspace",
        workspace,
        "--port",
        String(port),
      ],
      {
        env: { ...environment, WORKTABLE_LOCAL_OWNER: "desktop" },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    try {
      const runtimePath = join(appDir, "local-runtime.json")
      await waitForFile(runtimePath)
      // Simulate a host from before the long-lived authority lock existed. The
      // proven runtime lease must still prevent destructive uninstall.
      rmSync(join(appDir, "local-authority.lock"), { force: true })
      const configPath = join(appDir, "config.json")
      const beforeConfig = readFileSync(configPath, "utf8")

      const refused = await runCli(["uninstall", "--yes"])
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr).toContain(
        "Quit Worktable Desktop before uninstalling"
      )
      expect(existsSync(appDir)).toBe(true)
      expect(existsSync(runtimePath)).toBe(true)
      expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
    } finally {
      owner.kill("SIGTERM")
      await owner.exited
    }
  })

  it("setup refuses a proven service owner with no installed service artifact", async () => {
    const first = join(root, "unmanaged-service-first")
    const second = join(root, "unmanaged-service-second")
    await prepare(first)
    await prepare(second)
    const port = await freePort()
    const service = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "launch",
        "--foreground",
        "--no-browser",
        "--workspace",
        first,
        "--port",
        String(port),
      ],
      {
        env: { ...environment, WORKTABLE_LOCAL_OWNER: "service" },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    try {
      await waitForFile(join(appDir, "local-runtime.json"))
      // Exercise ownership after startup commits, not its transient lock.
      await waitForFileRemoval(join(appDir, "local-authority.lock"))
      const configPath = join(appDir, "config.json")
      const registryPath = join(appDir, "local-workspaces.json")
      const beforeConfig = readFileSync(configPath, "utf8")
      const beforeRegistry = readFileSync(registryPath, "utf8")

      const refused = await runCli([
        "setup",
        "--yes",
        "--skip-mcp",
        "--no-launch",
        "--workspace",
        second,
      ])
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr).toContain("An unmanaged Worktable service process")
      expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
      expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)

      const refusedLaunch = await runCli([
        "launch",
        "--background",
        "--no-browser",
        "--workspace",
        second,
      ])
      expect(refusedLaunch.exitCode).toBe(1)
      expect(refusedLaunch.stderr).toContain(
        "An unmanaged Worktable service process"
      )
      expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
      expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)
    } finally {
      service.kill("SIGTERM")
      await service.exited
    }
  })

  it("does not treat an installed artifact as proof of a managed service owner", async () => {
    const first = join(root, "stopped-service-artifact-first")
    await prepare(first)
    const isolatedBin = join(root, "isolated-service-bin")
    mkdirSync(isolatedBin)
    environment = {
      ...environment,
      PATH: isolatedBin,
      WORKTABLE_SERVICE_BACKEND: "process",
    }
    const service = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "launch",
        "--foreground",
        "--no-browser",
        "--workspace",
        first,
        "--port",
        String(await freePort()),
      ],
      {
        env: { ...environment, WORKTABLE_LOCAL_OWNER: "service" },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    try {
      await waitForFile(join(appDir, "local-runtime.json"))
      // Exercise ownership after startup commits, not its transient lock.
      await waitForFileRemoval(join(appDir, "local-authority.lock"))
      // The marker makes the process backend appear installed, but with no
      // manager-owned PID its state is stopped. A manually labelled process must
      // not gain service migration authority from the inert artifact.
      writeFileSync(join(appDir, "managed-service.json"), "{}\n")

      // Every lifecycle entry point shares prepareServiceStart. One command
      // proves the real process/manager-identity boundary; repeating install and
      // restart here would only re-enter the same guard in fresh Bun processes.
      const refusedStart = await runCli(["service", "start"])
      expect(refusedStart.exitCode).toBe(1)
      expect(refusedStart.stderr).toContain(
        "An unmanaged Worktable service process"
      )
    } finally {
      service.kill("SIGTERM")
      await service.exited
    }
  })

  it("setup does not reuse a managed service port for a different unregistered workspace", async () => {
    const first = join(root, "managed-proof-first")
    const second = join(root, "managed-proof-second")
    await prepare(first)
    await prepare(second)
    const port = await freePort()
    const launcher = join(appDir, "worktable-test-launcher.sh")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliEntry)} "$@"\n`,
      { mode: 0o755 }
    )
    const isolatedBin = join(root, "managed-proof-bin")
    mkdirSync(isolatedBin)
    environment = {
      ...environment,
      PATH: isolatedBin,
      WORKTABLE_SERVICE_BACKEND: "process",
      WORKTABLE_LAUNCHER: launcher,
    }

    expect(
      (
        await runCli([
          "setup",
          "--yes",
          "--skip-mcp",
          "--background",
          "--no-launch",
          "--workspace",
          first,
          "--port",
          String(port),
        ])
      ).exitCode
    ).toBe(0)
    expect(
      (await runCli(["launch", "--background", "--no-browser"])).exitCode
    ).toBe(0)
    try {
      await waitForFile(join(appDir, "local-runtime.json"))
      const configPath = join(appDir, "config.json")
      const beforeConfig = readFileSync(configPath, "utf8")
      rmSync(join(appDir, "local-workspaces.json"), { force: true })

      const refused = await runCli([
        "setup",
        "--yes",
        "--skip-mcp",
        "--no-launch",
        "--workspace",
        second,
        "--port",
        String(port),
      ])
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr).toContain(
        "did not prove ownership of the shared local runtime lease"
      )
      expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)

      // A loaded/running manager is not enough proof by itself. Model an orphan
      // overwriting the lease with its own live PID while the real managed child
      // remains healthy; lifecycle operations must match the manager's exact PID.
      const runtimePath = join(appDir, "local-runtime.json")
      const orphanedRuntime = JSON.parse(readFileSync(runtimePath, "utf8"))
      orphanedRuntime.pid = process.pid
      delete orphanedRuntime.ownerIdentity
      writeFileSync(
        runtimePath,
        JSON.stringify(orphanedRuntime, null, 2) + "\n"
      )
      const refusedActivation = await runCli([
        "local-host",
        "activate",
        second,
        "--json",
      ])
      expect(refusedActivation.exitCode).toBe(1)
      expect(JSON.parse(refusedActivation.stdout).error.message).toContain(
        "unmanaged service process"
      )
      const refusedRestart = await runCliSubprocess(["service", "restart"])
      expect(refusedRestart.exitCode).toBe(1)
      expect(refusedRestart.stderr).toContain(
        "An unmanaged Worktable service process"
      )
    } finally {
      await runCli(["service", "stop"])
    }
  }, 30_000)

  it("rolls back an interrupted activation journal", async () => {
    const first = join(root, "first")
    const second = join(root, "second")
    await prepare(first)
    await prepare(second)
    expect(
      (await runCli(["local-host", "activate", first, "--json"])).exitCode
    ).toBe(0)
    const configPath = join(appDir, "config.json")
    const registryPath = join(appDir, "local-workspaces.json")
    const beforeConfig = JSON.parse(readFileSync(configPath, "utf8"))
    const beforeRegistry = JSON.parse(readFileSync(registryPath, "utf8"))

    expect(
      (await runCli(["local-host", "activate", second, "--json"])).exitCode
    ).toBe(0)
    writeFileSync(
      join(appDir, "local-activation.json"),
      JSON.stringify({
        schemaVersion: 1,
        operationId: "test-interruption",
        startedAt: new Date().toISOString(),
        targetWorkspace: second,
        configExisted: true,
        registryExisted: true,
        beforeConfig,
        beforeRegistry,
        serviceInstalled: false,
        serviceWasRunning: false,
      })
    )

    const recovered = await runCli(["local-host", "recover", "--json"])
    expect(recovered.exitCode).toBe(0)
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      ok: true,
      action: "rolled-back",
      workspace: first,
    })
    expect(JSON.parse(readFileSync(configPath, "utf8")).workspace).toBe(first)
    expect(
      JSON.parse(readFileSync(registryPath, "utf8")).activeWorkspaceId
    ).toBe(beforeRegistry.activeWorkspaceId)
    expect(existsSync(join(appDir, "local-activation.json"))).toBe(false)
  })

  it("reconciles an interrupted activation to its still-proven runtime", async () => {
    const first = join(root, "recover-proven-first")
    const second = join(root, "recover-proven-second")
    await prepare(first)
    await prepare(second)
    expect(
      (await runCli(["local-host", "activate", first, "--json"])).exitCode
    ).toBe(0)
    const configPath = join(appDir, "config.json")
    const registryPath = join(appDir, "local-workspaces.json")
    const beforeConfig = JSON.parse(readFileSync(configPath, "utf8"))
    const beforeRegistry = JSON.parse(readFileSync(registryPath, "utf8"))

    const port = await freePort()
    expect(
      (
        await runCli([
          "local-host",
          "activate",
          second,
          "--port",
          String(port),
          "--json",
        ])
      ).exitCode
    ).toBe(0)
    const owner = Bun.spawn(
      [process.execPath, cliEntry, "launch", "--foreground", "--no-browser"],
      { env: environment, stdout: "pipe", stderr: "pipe" }
    )
    try {
      await waitForFile(join(appDir, "local-runtime.json"))
      // Model a journal written by the pre-fix attach path. The proven host is
      // deliberately allowed to outlive the transition lock for this recovery
      // regression, as older Desktop builds did. Restoring the old registry also
      // models an interruption between the attach path's config and registry
      // writes; recovery must safely finish that reconciliation.
      rmSync(join(appDir, "local-authority.lock"), { force: true })
      writeFileSync(
        registryPath,
        JSON.stringify(beforeRegistry, null, 2) + "\n"
      )
      writeFileSync(
        join(appDir, "local-activation.json"),
        JSON.stringify({
          schemaVersion: 1,
          operationId: "test-proven-interruption",
          startedAt: new Date().toISOString(),
          targetWorkspace: second,
          configExisted: true,
          registryExisted: true,
          beforeConfig,
          beforeRegistry,
          serviceInstalled: false,
          serviceWasRunning: false,
        })
      )

      const recovered = await runCli(["local-host", "recover", "--json"])
      expect(recovered.exitCode).toBe(0)
      expect(JSON.parse(recovered.stdout)).toMatchObject({
        ok: true,
        action: "repaired",
        workspace: second,
        runtimeRepair: "reconciled-proven-runtime",
      })
      expect(JSON.parse(readFileSync(configPath, "utf8")).workspace).toBe(
        second
      )
      expect(
        JSON.parse(readFileSync(registryPath, "utf8")).activeWorkspaceId
      ).not.toBe(beforeRegistry.activeWorkspaceId)
      expect(existsSync(join(appDir, "local-activation.json"))).toBe(false)
    } finally {
      owner.kill("SIGTERM")
      await owner.exited
    }
  })

  it("blocks ordinary launches while an activation journal is pending", async () => {
    const workspace = join(root, "journal-blocks-launch")
    await prepare(workspace)
    expect(
      (await runCli(["local-host", "activate", workspace, "--json"])).exitCode
    ).toBe(0)
    const configPath = join(appDir, "config.json")
    const beforeConfig = readFileSync(configPath, "utf8")
    const journalPath = join(appDir, "local-activation.json")
    writeFileSync(journalPath, "{}\n")

    const refused = await runCli(["launch", "--foreground", "--no-browser"])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain(
      "previous local workspace activation did not finish"
    )
    expect(existsSync(join(appDir, "local-runtime.json"))).toBe(false)
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
    expect(existsSync(journalPath)).toBe(true)
  })

  it("blocks setup while an activation journal is pending", async () => {
    const first = join(root, "journal-blocks-setup-first")
    const second = join(root, "journal-blocks-setup-second")
    await prepare(first)
    await prepare(second)
    expect(
      (
        await runCli([
          "setup",
          "--yes",
          "--skip-mcp",
          "--no-launch",
          "--workspace",
          first,
        ])
      ).exitCode
    ).toBe(0)
    const configPath = join(appDir, "config.json")
    const registryPath = join(appDir, "local-workspaces.json")
    const beforeConfig = readFileSync(configPath, "utf8")
    const beforeRegistry = readFileSync(registryPath, "utf8")
    const journalPath = join(appDir, "local-activation.json")
    writeFileSync(journalPath, "{}\n")

    const refused = await runCli([
      "setup",
      "--yes",
      "--skip-mcp",
      "--no-launch",
      "--workspace",
      second,
    ])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain(
      "previous local workspace activation did not finish"
    )
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
    expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)
    expect(existsSync(journalPath)).toBe(true)

    for (const args of [
      ["service", "start"],
      ["service", "restart"],
      ["local-host", "restart", "--json"],
    ]) {
      const refusedStart = await runCli(args)
      expect(refusedStart.exitCode).toBe(1)
      expect(refusedStart.stderr || refusedStart.stdout).toContain(
        "previous local workspace activation did not finish"
      )
      expect(existsSync(journalPath)).toBe(true)
    }
  })

  it("refuses a second foreground owner before changing durable workspace state", async () => {
    const first = join(root, "first")
    const second = join(root, "second")
    await prepare(first)
    await prepare(second)
    const firstPort = await freePort()
    const secondPort = firstPort === 65_535 ? firstPort - 1 : firstPort + 1
    const owner = Bun.spawn(
      [
        process.execPath,
        cliEntry,
        "launch",
        "--foreground",
        "--no-browser",
        "--workspace",
        first,
        "--port",
        String(firstPort),
      ],
      { env: environment, stdout: "pipe", stderr: "pipe" }
    )
    try {
      await waitForFile(join(appDir, "local-runtime.json"))
      await waitForWorktableHealth(firstPort)
      const beforeConfig = readFileSync(join(appDir, "config.json"), "utf8")
      const refused = await runCli([
        "launch",
        "--foreground",
        "--no-browser",
        "--workspace",
        second,
        "--port",
        String(secondPort),
      ])
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr).toContain("already owns")
      expect(readFileSync(join(appDir, "config.json"), "utf8")).toBe(
        beforeConfig
      )

      const refusedPostureChange = await runCli([
        "launch",
        "--reachable",
        "--owner-password",
        "isolated-test-password",
        "--no-browser",
      ])
      expect(refusedPostureChange.exitCode).toBe(1)
      expect(refusedPostureChange.stderr).toContain("already owns")
      expect(readFileSync(join(appDir, "config.json"), "utf8")).toBe(
        beforeConfig
      )
    } finally {
      owner.kill("SIGTERM")
      await owner.exited
    }
    expect(existsSync(join(appDir, "local-runtime.json"))).toBe(false)
  })
})
