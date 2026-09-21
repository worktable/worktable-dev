import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import {
  LOCAL_PROOF_HEADER,
  assertLocalWorkspaceReservationAvailable,
  clearLocalRuntime,
  createLocalRuntimeRecord,
  getLocalRuntimePath,
  getLocalWorkspaceRegistryPath,
  inspectLocalRuntime,
  inspectLocalRuntimeDetailed,
  localHostsSharePortSpace,
  localHttpOrigin,
  readLocalRuntime,
  readLocalWorkspaceRegistry,
  rememberLocalWorkspace,
  setLocalRuntimeLockWaitHookForTests,
  UnsupportedLocalRuntimeSchemaError,
  UnsupportedLocalWorkspaceRegistrySchemaError,
  writeLocalRuntime,
} from "./local-host.ts"
import { healthRouter } from "./routes/health.ts"

let appDir: string
let previousProof: string | undefined

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-local-host-"))
  setAppDirOverride(appDir)
  previousProof = process.env["WORKTABLE_LOCAL_PROOF_TOKEN"]
  delete process.env["WORKTABLE_LOCAL_PROOF_TOKEN"]
})

afterEach(() => {
  setLocalRuntimeLockWaitHookForTests(null)
  setAppDirOverride(null)
  if (previousProof === undefined)
    delete process.env["WORKTABLE_LOCAL_PROOF_TOKEN"]
  else process.env["WORKTABLE_LOCAL_PROOF_TOKEN"] = previousProof
  rmSync(appDir, { recursive: true, force: true })
})

describe("local workspace authority", () => {
  it("distinguishes a newer runtime schema from corrupt state", async () => {
    writeFileSync(
      getLocalRuntimePath(),
      JSON.stringify({ schemaVersion: 2, owner: "desktop" }) + "\n"
    )
    expect(() => readLocalRuntime()).toThrow(UnsupportedLocalRuntimeSchemaError)
    await expect(inspectLocalRuntime()).rejects.toBeInstanceOf(
      UnsupportedLocalRuntimeSchemaError
    )
  })

  it("distinguishes a newer workspace registry schema from corrupt state", () => {
    writeFileSync(
      getLocalWorkspaceRegistryPath(),
      JSON.stringify({
        schemaVersion: 2,
        activeWorkspaceId: null,
        workspaces: [],
      }) + "\n"
    )
    expect(() => readLocalWorkspaceRegistry()).toThrow(
      UnsupportedLocalWorkspaceRegistrySchemaError
    )
  })

  it("persists stable private workspace ownership", () => {
    rememberLocalWorkspace({
      workspaceId: "ws_alpha",
      name: "Alpha",
      path: join(appDir, "alpha"),
      host: "127.0.0.1",
      port: 17480,
      now: "2026-07-18T00:00:00.000Z",
    })
    const registry = readLocalWorkspaceRegistry()
    expect(registry.activeWorkspaceId).toBe("ws_alpha")
    expect(registry.workspaces).toEqual([
      {
        workspaceId: "ws_alpha",
        name: "Alpha",
        path: join(appDir, "alpha"),
        host: "127.0.0.1",
        port: 17480,
        lastUsedAt: "2026-07-18T00:00:00.000Z",
      },
    ])
    expect(statSync(getLocalWorkspaceRegistryPath()).mode & 0o777).toBe(0o600)
  })

  it("refuses path and endpoint ownership collisions", () => {
    rememberLocalWorkspace({
      workspaceId: "ws_alpha",
      name: "Alpha",
      path: join(appDir, "alpha"),
      host: "127.0.0.1",
      port: 17480,
    })
    expect(() =>
      assertLocalWorkspaceReservationAvailable({
        workspaceId: "ws_beta",
        path: join(appDir, "beta"),
        host: "127.0.0.1",
        port: 17480,
      })
    ).toThrow("belongs to Alpha")
    expect(() =>
      rememberLocalWorkspace({
        workspaceId: "ws_beta",
        name: "Beta",
        path: join(appDir, "beta"),
        host: "127.0.0.1",
        port: 17480,
      })
    ).toThrow("belongs to Alpha")
    expect(() =>
      rememberLocalWorkspace({
        workspaceId: "ws_beta",
        name: "Beta",
        path: join(appDir, "alpha"),
        host: "127.0.0.1",
        port: 17481,
      })
    ).toThrow("already registered to ws_alpha")
  })

  it("treats wildcard and loopback aliases as one reserved local port space", () => {
    expect(localHostsSharePortSpace("127.0.0.1", "localhost")).toBe(true)
    expect(localHostsSharePortSpace("::1", "0.0.0.0")).toBe(true)
    expect(localHostsSharePortSpace("192.168.1.20", "0.0.0.0")).toBe(true)
    expect(localHostsSharePortSpace("192.168.1.20", "192.168.1.21")).toBe(false)
    rememberLocalWorkspace({
      workspaceId: "ws_alpha",
      name: "Alpha",
      path: join(appDir, "alpha"),
      host: "127.0.0.1",
      port: 17480,
    })
    expect(() =>
      rememberLocalWorkspace({
        workspaceId: "ws_beta",
        name: "Beta",
        path: join(appDir, "beta"),
        host: "0.0.0.0",
        port: 17480,
      })
    ).toThrow("belongs to Alpha")
  })

  it("formats IPv6 runtime probes as valid bracketed HTTP origins", () => {
    expect(localHttpOrigin("::1", 17480)).toBe("http://[::1]:17480")
    expect(localHttpOrigin("[::1]", 17480)).toBe("http://[::1]:17480")
    expect(localHttpOrigin("::", 17480)).toBe("http://127.0.0.1:17480")
  })

  it("verifies a live IPv6 loopback runtime", async () => {
    const proofToken = "ipv6-proof-token-that-is-long-enough-for-runtime"
    process.env["WORKTABLE_LOCAL_PROOF_TOKEN"] = proofToken
    const app = new Hono()
    app.route("/health", healthRouter)
    const server = Bun.serve({ hostname: "::1", port: 0, fetch: app.fetch })
    try {
      writeLocalRuntime(
        createLocalRuntimeRecord({
          owner: "cli",
          installId: "ins_ipv6",
          workspaceId: "ws_ipv6",
          workspacePath: join(appDir, "ipv6"),
          host: "::1",
          port: server.port!,
          proofToken,
        })
      )
      expect(await inspectLocalRuntime()).toMatchObject({
        host: "::1",
        processAlive: true,
        endpointVerified: true,
      })
    } finally {
      server.stop(true)
    }
  })

  it("publishes a verified runtime view without exposing its proof", async () => {
    const proofToken = "proof-token-that-is-long-enough-for-the-runtime-record"
    process.env["WORKTABLE_LOCAL_PROOF_TOKEN"] = proofToken
    const app = new Hono()
    app.route("/health", healthRouter)
    const server = Bun.serve({
      port: 0,
      fetch: app.fetch,
    })
    try {
      const runtime = createLocalRuntimeRecord({
        owner: "desktop",
        installId: "ins_test",
        workspaceId: "ws_alpha",
        workspacePath: join(appDir, "alpha"),
        host: "127.0.0.1",
        port: server.port!,
        proofToken,
      })
      writeLocalRuntime(runtime)
      expect(statSync(getLocalRuntimePath()).mode & 0o777).toBe(0o600)

      const inspected = await inspectLocalRuntime()
      expect(inspected).toMatchObject({
        owner: "desktop",
        pid: process.pid,
        workspaceId: "ws_alpha",
        processAlive: true,
        endpointVerified: true,
      })
      expect(inspected).not.toHaveProperty("proofToken")
      expect(inspected).not.toHaveProperty("ownerIdentity")
      expect(inspected).not.toHaveProperty("endpointState")
      expect(JSON.stringify(inspected)).not.toContain(proofToken)

      expect(clearLocalRuntime("not-the-runtime-nonce")).toBe(false)
      expect(existsSync(getLocalRuntimePath())).toBe(true)
      expect(clearLocalRuntime(runtime.nonce)).toBe(true)
      expect(readLocalRuntime()).toBeNull()
    } finally {
      server.stop(true)
    }
  })

  it("distinguishes a transient proof timeout from an explicit rejection", async () => {
    const proofToken = "readiness-proof-token-that-is-long-enough-for-runtime"
    process.env["WORKTABLE_LOCAL_PROOF_TOKEN"] = proofToken
    const app = new Hono()
    app.route("/health", healthRouter)
    let mode: "delay" | "verify" | "reject" | "null" = "delay"
    let releaseDelayedResponse = (): void => {}
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const requestMode = mode
        if (requestMode === "delay") {
          return new Promise<Response>((resolve) => {
            releaseDelayedResponse = () =>
              resolve(Response.json({ ok: true, service: "worktable" }))
          })
        }
        if (requestMode === "reject") {
          return Response.json({ ok: true, service: "worktable" })
        }
        if (requestMode === "null") return Response.json(null)
        return app.fetch(request)
      },
    })
    try {
      writeLocalRuntime(
        createLocalRuntimeRecord({
          owner: "service",
          installId: "ins_readiness",
          workspaceId: "ws_readiness",
          workspacePath: join(appDir, "readiness"),
          host: "127.0.0.1",
          port: server.port!,
          proofToken,
        })
      )

      expect(await inspectLocalRuntimeDetailed(10)).toMatchObject({
        endpointState: "unreachable",
        endpointVerified: false,
      })
      releaseDelayedResponse()
      mode = "verify"
      expect(await inspectLocalRuntimeDetailed(250)).toMatchObject({
        endpointState: "verified",
        endpointVerified: true,
      })
      mode = "reject"
      expect(await inspectLocalRuntimeDetailed(250)).toMatchObject({
        endpointState: "rejected",
        endpointVerified: false,
      })
      mode = "null"
      expect(await inspectLocalRuntimeDetailed(250)).toMatchObject({
        endpointState: "rejected",
        endpointVerified: false,
      })
    } finally {
      server.stop(true)
    }
  })

  it("treats a live recycled PID as a stale runtime lease", async () => {
    const runtime = createLocalRuntimeRecord({
      owner: "desktop",
      installId: "ins_recycled",
      workspaceId: "ws_recycled",
      workspacePath: join(appDir, "recycled"),
      host: "127.0.0.1",
      port: 17480,
      ownerIdentity: "not-the-current-process-start",
    })
    writeLocalRuntime(runtime)

    expect(await inspectLocalRuntime()).toMatchObject({
      pid: process.pid,
      processAlive: false,
      endpointVerified: false,
    })
  })

  it("does not clear a replacement lease published while the old owner exits", async () => {
    const runtime = createLocalRuntimeRecord({
      owner: "cli",
      installId: "ins_old",
      workspaceId: "ws_old",
      workspacePath: join(appDir, "old"),
      host: "127.0.0.1",
      port: 17480,
    })
    writeLocalRuntime(runtime)

    // Hold the same filesystem lock a replacement publisher uses, replace the
    // lease in a child process, then release it. clearLocalRuntime must wait and
    // re-check under the lock rather than unlinking the replacement it never read.
    const lockPath = join(appDir, "local-runtime.lock")
    const waiterPath = join(appDir, "local-runtime-waiter-ready")
    mkdirSync(lockPath, { mode: 0o700 })
    setLocalRuntimeLockWaitHookForTests(() => {
      writeFileSync(waiterPath, "ready")
    })
    const replacement = { ...runtime, nonce: "replacement-runtime-nonce" }
    const publisher = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          const fs = require("node:fs");
          while (!fs.existsSync(process.env.WAITER_PATH)) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
          const replacement = JSON.parse(process.env.REPLACEMENT_RUNTIME);
          replacement.pid = process.pid;
          delete replacement.ownerIdentity;
          const temporary = process.env.RUNTIME_PATH + ".replacement.tmp";
          fs.writeFileSync(temporary, JSON.stringify(replacement) + "\\n", { mode: 0o600 });
          fs.renameSync(temporary, process.env.RUNTIME_PATH);
          fs.rmSync(process.env.RUNTIME_LOCK_PATH, { recursive: true, force: true });
        `,
      ],
      {
        env: {
          ...process.env,
          REPLACEMENT_RUNTIME: JSON.stringify(replacement),
          RUNTIME_PATH: getLocalRuntimePath(),
          RUNTIME_LOCK_PATH: lockPath,
          WAITER_PATH: waiterPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    )

    expect(clearLocalRuntime(runtime.nonce)).toBe(false)
    const [exitCode, stderr] = await Promise.all([
      publisher.exited,
      new Response(publisher.stderr).text(),
    ])
    expect(exitCode, stderr).toBe(0)
    expect(readLocalRuntime()).toMatchObject({
      nonce: "replacement-runtime-nonce",
      workspaceId: "ws_old",
    })
  })

  it("returns proof only for the exact request credential", async () => {
    const proofToken = "another-proof-token-that-is-safely-long-enough"
    process.env["WORKTABLE_LOCAL_PROOF_TOKEN"] = proofToken
    const absent = await healthRouter.request("/")
    const wrong = await healthRouter.request("/", {
      headers: { [LOCAL_PROOF_HEADER]: `${proofToken}-wrong` },
    })
    const exact = await healthRouter.request("/", {
      headers: { [LOCAL_PROOF_HEADER]: proofToken },
    })
    expect(absent.headers.get(LOCAL_PROOF_HEADER)).toBeNull()
    expect(wrong.headers.get(LOCAL_PROOF_HEADER)).toBeNull()
    expect(exact.headers.get(LOCAL_PROOF_HEADER)).toBe("verified")
    expect(await exact.text()).not.toContain(proofToken)
  })
})
