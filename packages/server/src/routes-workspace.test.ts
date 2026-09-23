import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  type WorkspaceManifest,
} from "./workspace.ts"
import {
  setLegacyWorkspaceExportWaitMsForTests,
  workspaceRouter,
} from "./routes/workspace.ts"
import { systemRouter } from "./routes/system.ts"
import { trustedLocalIdentity } from "./auth.ts"
import { createToken } from "./token-store.ts"
import {
  setWorkspaceExportRunHookForTests,
  setWorkspaceImportRunHookForTests,
  waitForWorkspaceExportJob,
  waitForWorkspaceImportJob,
} from "./workspace-transfer-jobs.ts"
import { writeWorkspaceExportV2 } from "./workspace-transfer-v2.ts"
import { WORKSPACE_TRANSFER_CHUNK_BYTES } from "./workspace-transfer-jobs.ts"
import {
  invalidateServerSettingsCache,
} from "./settings-store.ts"

let appDir: string
let workspaceDir: string
const originalEnv = { ...process.env }

const base: WorkspaceManifest = {
  type: "worktable.workspace",
  version: 1,
  id: "ws_fixed",
  name: "Original",
  createdAt: "2026-01-01T00:00:00.000Z",
  cloud: { status: "unlinked" },
}

function manifestPath(): string {
  return join(workspaceDir, "worktable.workspace.json")
}

function seed(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    manifestPath(),
    `${JSON.stringify({ ...base, ...extra }, null, 2)}\n`
  )
}

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath(), "utf8")) as Record<
    string,
    unknown
  >
}

function app() {
  const a = new Hono()
  a.use("/api/*", trustedLocalIdentity())
  a.route("/api/workspace", workspaceRouter)
  a.route("/api/system", systemRouter)
  return a
}

function put(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/workspace", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "wt-ws-app-"))
  workspaceDir = mkdtempSync(join(tmpdir(), "wt-ws-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
  invalidateServerSettingsCache()
  setLegacyWorkspaceExportWaitMsForTests(null)
  setWorkspaceExportRunHookForTests(null)
  setWorkspaceImportRunHookForTests(null)
  delete process.env["WORKTABLE_REQUIRE_AUTH"]
  delete process.env["WORKTABLE_PUBLIC_URL"]
  delete process.env["HOST"]
})

afterEach(() => {
  setLegacyWorkspaceExportWaitMsForTests(null)
  setWorkspaceExportRunHookForTests(null)
  setWorkspaceImportRunHookForTests(null)
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  invalidateServerSettingsCache()
  rmSync(appDir, { recursive: true, force: true })
  rmSync(workspaceDir, { recursive: true, force: true })
  process.env = { ...originalEnv }
})

describe("PUT /api/workspace", () => {
  it("treats legacy workspaces as complete and persists first-run completion", async () => {
    seed()
    const before = await app().fetch(
      new Request("http://localhost/api/workspace")
    )
    expect(await before.json()).toMatchObject({
      onboarding: { status: "complete" },
    })

    seed({ onboarding: { version: 1, status: "pending" } })
    const completed = await app().fetch(
      put({ onboarding: { status: "complete" } })
    )
    expect(completed.status).toBe(200)
    expect(await completed.json()).toMatchObject({
      onboarding: { status: "complete" },
    })
    expect(readManifest()["onboarding"]).toMatchObject({
      version: 1,
      status: "complete",
      completedAt: expect.any(String),
    })
  })

  it("rejects attempts to write unsupported onboarding states", async () => {
    seed({ onboarding: { version: 1, status: "pending" } })
    const response = await app().fetch(
      put({ onboarding: { status: "pending" } })
    )
    expect(response.status).toBe(400)
    expect(readManifest()["onboarding"]).toEqual({
      version: 1,
      status: "pending",
    })
  })

  it.each([1, 2])(
    "renames a V%s workspace and reports its storage version",
    async (version) => {
      seed({ version })
      const res = await app().fetch(put({ name: "  Renamed  " }))
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        name: string
        storageVersion: number
      }
      expect(body.name).toBe("Renamed") // trimmed
      expect(body.storageVersion).toBe(version)
      const read = await app().fetch(
        new Request("http://localhost/api/workspace")
      )
      expect(await read.json()).toMatchObject({
        name: "Renamed",
        storageVersion: version,
      })
      expect(readManifest()["name"]).toBe("Renamed")
    }
  )

  it("rejects an empty name with 400", async () => {
    seed()
    const res = await app().fetch(put({ name: "   " }))
    expect(res.status).toBe(400)
  })

  it("rejects an over-long name with 400", async () => {
    seed()
    const res = await app().fetch(put({ name: "x".repeat(201) }))
    expect(res.status).toBe(400)
  })

  it("does not expose publicUrl in the response (it is machine-local now)", async () => {
    seed()
    const res = await app().fetch(new Request("http://localhost/api/workspace"))
    const body = (await res.json()) as Record<string, unknown>
    expect("publicUrl" in body).toBe(false)
  })

  it("ignores a publicUrl key in the PUT body (not read into the manifest)", async () => {
    seed()
    // The route only reads `name`; an unknown key is simply not read (200, and
    // publicUrl is never written by this route).
    const res = await app().fetch(
      put({ name: "Kept", publicUrl: "https://x.com" })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect("publicUrl" in body).toBe(false)
    expect(body["name"]).toBe("Kept")
    expect("publicUrl" in readManifest()).toBe(false)
  })

  it("preserves every other manifest field byte-identically", async () => {
    seed({
      provenance: {
        mode: "sandbox",
        source: { label: "Alex Daily" },
        disposable: true,
      },
    })
    const res = await app().fetch(put({ name: "New Name" }))
    expect(res.status).toBe(200)
    const m = readManifest()
    expect(m["id"]).toBe("ws_fixed")
    expect(m["createdAt"]).toBe("2026-01-01T00:00:00.000Z")
    expect(m["type"]).toBe("worktable.workspace")
    expect(m["version"]).toBe(1)
    expect(m["cloud"]).toEqual({ status: "unlinked" })
    expect(m["provenance"]).toEqual({
      mode: "sandbox",
      source: { label: "Alex Daily" },
      disposable: true,
    })
    expect(m["name"]).toBe("New Name")
  })

  it("carries a stale manifest publicUrl through untouched (back-compat, ignored)", async () => {
    // An earlier build of this branch wrote publicUrl into the manifest. It is no
    // longer a manifest field; a name-only PUT preserves the stale key harmlessly
    // (unknown keys don't invalidate the manifest and are never migrated).
    seed({ publicUrl: "https://old.example.com" })
    const res = await app().fetch(put({ name: "New Name" }))
    expect(res.status).toBe(200)
    expect(readManifest()["publicUrl"]).toBe("https://old.example.com")
  })

  it("forbids a non-owner (scoped token) with 403 and does not write", async () => {
    seed()
    const { token } = await createToken({ scopes: ["docs:read"] })
    const res = await app().fetch(
      put({ name: "Hacked" }, { Authorization: `Bearer ${token}` })
    )
    expect(res.status).toBe(403)
    expect(readManifest()["name"]).toBe("Original")
  })
})

describe("GET /api/workspace/export", () => {
  it("downloads the versioned bundle for a human principal", async () => {
    seed()
    const res = await app().fetch(
      new Request("http://localhost/api/workspace/export")
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Disposition")).toContain("attachment")
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.worktable.workspace+zip"
    )
    expect(res.headers.get("Content-Disposition")).toContain(".wtb")
    const bundle = new Uint8Array(await res.arrayBuffer())
    expect(bundle.subarray(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]))
  })

  it("returns an observable durable job before a legacy request can time out", async () => {
    seed()
    const { token } = await createToken({ scopes: ["workspace:export"] })
    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: "https://authorized-tool.example",
    }
    let releaseExport!: () => void
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseExport = resolve
    })
    setWorkspaceExportRunHookForTests(async () => {
      markEntered()
      await gate
    })
    setLegacyWorkspaceExportWaitMsForTests(1)

    const responsePromise = app().fetch(
      new Request("http://localhost/api/workspace/export", { headers })
    )
    await entered
    const response = await responsePromise
    const body = (await response.json()) as {
      id: string
      state: string
      statusUrl: string
      downloadUrl: string
    }

    expect(response.status).toBe(202)
    expect(response.headers.get("Location")).toBe(body.statusUrl)
    expect(response.headers.get("Retry-After")).toBe("1")
    expect(["queued", "running"]).toContain(body.state)
    expect(body.downloadUrl).toBe(`${body.statusUrl}/download`)

    releaseExport()
    await expect(waitForWorkspaceExportJob(body.id)).resolves.toMatchObject({
      state: "complete",
    })
    const status = await app().fetch(
      new Request(`http://localhost${body.statusUrl}`, { headers })
    )
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      id: body.id,
      state: "complete",
    })
    const download = await app().fetch(
      new Request(`http://localhost${body.downloadUrl}`, { headers })
    )
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer()).subarray(0, 2)).toEqual(
      new Uint8Array([0x50, 0x4b])
    )
  })

  it("keeps a browser navigation alive until a deferred export downloads", async () => {
    seed()
    let releaseExport!: () => void
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseExport = resolve
    })
    setWorkspaceExportRunHookForTests(async () => {
      markEntered()
      await gate
    })
    setLegacyWorkspaceExportWaitMsForTests(1)
    const navigationHeaders = {
      Accept: "text/html",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    }

    const responsePromise = app().fetch(
      new Request("http://localhost/api/workspace/export", {
        headers: navigationHeaders,
      })
    )
    await entered
    const response = await responsePromise
    const statusUrl = response.headers.get("Location")
    expect(response.status).toBe(202)
    expect(response.headers.get("Content-Type")).toContain("text/html")
    expect(statusUrl).toMatch(
      /^\/api\/workspace\/transfers\/exports\/wtx_[A-Za-z0-9_-]+$/
    )
    const downloadUrl = `${statusUrl}/download`
    expect(response.headers.get("Refresh")).toBe(`1; url=${downloadUrl}`)
    expect(await response.text()).toContain(
      `<meta http-equiv="refresh" content="1; url=${downloadUrl}">`
    )

    const stillPreparing = await app().fetch(
      new Request(`http://localhost${downloadUrl}`, {
        headers: navigationHeaders,
      })
    )
    expect(stillPreparing.status).toBe(202)
    expect(stillPreparing.headers.get("Refresh")).toBe(`1; url=${downloadUrl}`)

    releaseExport()
    const id = statusUrl!.slice(statusUrl!.lastIndexOf("/") + 1)
    await expect(waitForWorkspaceExportJob(id)).resolves.toMatchObject({
      state: "complete",
    })
    const download = await app().fetch(
      new Request(`http://localhost${downloadUrl}`, {
        headers: navigationHeaders,
      })
    )
    expect(download.status).toBe(200)
    expect(download.headers.get("Content-Disposition")).toContain("attachment")
    expect(new Uint8Array(await download.arrayBuffer()).subarray(0, 2)).toEqual(
      new Uint8Array([0x50, 0x4b])
    )
  })

  it("refuses a cross-origin browser using the implicit local owner", async () => {
    seed()
    const res = await app().fetch(
      new Request("http://localhost/api/workspace/export", {
        headers: { Origin: "https://attacker.example" },
      })
    )
    expect(res.status).toBe(401)
  })

  it("rejects cross-site browser navigations without Origin before creating export jobs", async () => {
    seed()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await app().fetch(
        new Request("http://localhost/api/workspace/export", {
          headers: {
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document",
          },
        })
      )
      expect(res.status).toBe(401)
    }
    expect(existsSync(join(appDir, "workspace-transfers", "jobs"))).toBe(false)
  })

  it("does not treat a non-Bearer authorization header as explicit tooling", async () => {
    seed()
    const res = await app().fetch(
      new Request("http://localhost/api/workspace/transfers/exports", {
        method: "POST",
        headers: {
          Authorization: "Basic ZmFrZTpmYWtl",
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    )
    expect(res.status).toBe(401)
  })

  it("allows the implicit local owner from the same browser origin", async () => {
    seed()
    const res = await app().fetch(
      new Request("http://localhost/api/workspace/export", {
        headers: { Origin: "http://localhost" },
      })
    )
    expect(res.status).toBe(200)
  })

  it("refuses an agent token from bulk-exporting the workspace", async () => {
    seed()
    const { token } = await createToken({
      scopes: ["docs:read"],
      agent: "claude",
    })
    const res = await app().fetch(
      new Request("http://localhost/api/workspace/export", {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
    expect(res.status).toBe(403)
  })

  it("refuses a narrow human token without workspace export authority", async () => {
    seed()
    const { token } = await createToken({ scopes: ["docs:read"] })
    const res = await app().fetch(
      new Request("http://localhost/api/workspace/export", {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
    expect(res.status).toBe(403)
  })

  it("allows a human token with explicit workspace export authority", async () => {
    seed()
    const { token } = await createToken({ scopes: ["workspace:export"] })
    const res = await app().fetch(
      new Request("http://localhost/api/workspace/export", {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://authorized-tool.example",
        },
      })
    )
    expect(res.status).toBe(200)
  })

  it("still refuses an agent that carries workspace export authority", async () => {
    seed()
    const { token } = await createToken({
      scopes: ["workspace:export"],
      agent: "claude",
    })
    const res = await app().fetch(
      new Request("http://localhost/api/workspace/export", {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
    expect(res.status).toBe(403)
  })

  it("exposes the durable export job and streaming download contract", async () => {
    seed()
    const created = await app().fetch(
      new Request("http://localhost/api/workspace/transfers/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: { mode: "none" } }),
      })
    )
    expect(created.status).toBe(202)
    const initial = (await created.json()) as { id: string; state: string }
    await waitForWorkspaceExportJob(initial.id)

    const current = await app().fetch(
      new Request("http://localhost/api/workspace/transfers/exports/current")
    )
    expect(await current.json()).toMatchObject({
      job: { id: initial.id, state: "complete" },
    })

    const status = await app().fetch(
      new Request(
        `http://localhost/api/workspace/transfers/exports/${initial.id}`
      )
    )
    expect(await status.json()).toMatchObject({
      id: initial.id,
      state: "complete",
      history: { mode: "none" },
      manifest: {
        source: { workspaceId: "ws_fixed" },
        history: { includedFiles: 0 },
      },
    })

    const download = await app().fetch(
      new Request(
        `http://localhost/api/workspace/transfers/exports/${initial.id}/download`
      )
    )
    expect(download.status).toBe(200)
    expect(download.headers.get("Content-Disposition")).toContain(".wtb")
    expect(new Uint8Array(await download.arrayBuffer()).subarray(0, 2)).toEqual(
      new Uint8Array([0x50, 0x4b])
    )
  })

  it("never lets an agent principal start owner transfer jobs", async () => {
    seed()
    const { token } = await createToken({
      scopes: ["*"],
      agent: "operator-shaped-agent",
    })
    const response = await app().fetch(
      new Request("http://localhost/api/workspace/transfers/exports", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ history: { mode: "all" } }),
      })
    )
    expect(response.status).toBe(403)
  })

  it("requires same-origin access across the implicit-owner transfer API", async () => {
    seed()
    const requests = [
      new Request("http://localhost/api/workspace/transfers/exports", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      new Request("http://localhost/api/workspace/transfers/exports/fake", {
        headers: { Origin: "https://attacker.example" },
      }),
      new Request("http://localhost/api/workspace/transfers/exports/current", {
        headers: { Origin: "https://attacker.example" },
      }),
      new Request(
        "http://localhost/api/workspace/transfers/exports/fake/download",
        { headers: { Origin: "https://attacker.example" } }
      ),
      new Request("http://localhost/api/workspace/transfers/imports", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      new Request(
        "http://localhost/api/workspace/transfers/imports/fake/content",
        {
          method: "PUT",
          headers: { Origin: "https://attacker.example" },
          body: new Uint8Array([1]),
        }
      ),
      new Request("http://localhost/api/workspace/transfers/imports/fake", {
        headers: { Origin: "https://attacker.example" },
      }),
      new Request("http://localhost/api/workspace/transfers/imports/current", {
        headers: { Origin: "https://attacker.example" },
      }),
      new Request(
        "http://localhost/api/workspace/transfers/imports/fake/prepare",
        {
          method: "POST",
          headers: { Origin: "https://attacker.example" },
          body: "{}",
        }
      ),
      new Request(
        "http://localhost/api/workspace/transfers/imports/fake/replace",
        {
          method: "POST",
          headers: { Origin: "https://attacker.example" },
          body: "{}",
        }
      ),
    ]

    for (const request of requests) {
      expect((await app().fetch(request)).status).toBe(401)
    }
  })

  it("rejects oversized and overlong chunk bodies without unbounded buffering", async () => {
    seed()
    const created = await app().fetch(
      new Request("http://localhost/api/workspace/transfers/imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "oversized.wtb",
          bytes: WORKSPACE_TRANSFER_CHUNK_BYTES + 1,
        }),
      })
    )
    const initial = (await created.json()) as { id: string }
    const oversized = await app().fetch(
      new Request(
        `http://localhost/api/workspace/transfers/imports/${initial.id}/content`,
        {
          method: "PUT",
          headers: {
            "Content-Range": `bytes 0-${WORKSPACE_TRANSFER_CHUNK_BYTES}/${WORKSPACE_TRANSFER_CHUNK_BYTES + 1}`,
          },
          body: new Uint8Array([1]),
        }
      )
    )
    expect(oversized.status).toBe(400)

    const overlong = await app().fetch(
      new Request(
        `http://localhost/api/workspace/transfers/imports/${initial.id}/content`,
        {
          method: "PUT",
          headers: {
            "Content-Range": `bytes 0-0/${WORKSPACE_TRANSFER_CHUNK_BYTES + 1}`,
          },
          body: new Uint8Array([1, 2]),
        }
      )
    )
    expect(overlong.status).toBe(400)
  })

  it("accepts a workspace package in resumable HTTP chunks and prepares review metadata", async () => {
    seed()
    const archive = await writeWorkspaceExportV2(join(appDir, "incoming"))
    const bytes = new Uint8Array(readFileSync(archive.destination))
    const created = await app().fetch(
      new Request("http://localhost/api/workspace/transfers/imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "incoming.wtb",
          bytes: bytes.byteLength,
          resumeFingerprint: "c".repeat(64),
          sha256: archive.sha256,
        }),
      })
    )
    expect(created.status).toBe(201)
    const initial = (await created.json()) as {
      id: string
      chunkBytes: number
    }
    const current = await app().fetch(
      new Request("http://localhost/api/workspace/transfers/imports/current")
    )
    expect(await current.json()).toMatchObject({
      job: {
        id: initial.id,
        state: "uploading",
        receivedBytes: 0,
        resumeFingerprint: "c".repeat(64),
        chunkBytes: WORKSPACE_TRANSFER_CHUNK_BYTES,
      },
    })
    const split = Math.floor(bytes.byteLength / 2)
    let verificationEntered!: () => void
    let releaseVerification!: () => void
    let preparationEntered!: () => void
    let releasePreparation!: () => void
    const verificationStarted = new Promise<void>((resolve) => {
      verificationEntered = resolve
    })
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve
    })
    const preparationStarted = new Promise<void>((resolve) => {
      preparationEntered = resolve
    })
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve
    })
    setWorkspaceImportRunHookForTests(async (phase) => {
      if (phase === "verifying") {
        verificationEntered()
        await verificationGate
      } else {
        preparationEntered()
        await preparationGate
      }
    })
    let uploadedState = ""
    for (const [start, body] of [
      [0, bytes.subarray(0, split)],
      [split, bytes.subarray(split)],
    ] as const) {
      const uploaded = await app().fetch(
        new Request(
          `http://localhost/api/workspace/transfers/imports/${initial.id}/content`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Range": `bytes ${start}-${start + body.byteLength - 1}/${bytes.byteLength}`,
            },
            body,
          }
        )
      )
      expect(uploaded.status).toBe(200)
      uploadedState = ((await uploaded.json()) as { state: string }).state
    }
    expect(uploadedState).toBe("verifying")
    await verificationStarted
    expect(
      (await (
        await app().fetch(
          new Request(
            `http://localhost/api/workspace/transfers/imports/${initial.id}`
          )
        )
      ).json()) as { state: string }
    ).toMatchObject({ state: "verifying" })
    releaseVerification()
    expect((await waitForWorkspaceImportJob(initial.id)).state).toBe("uploaded")

    const prepared = await app().fetch(
      new Request(
        `http://localhost/api/workspace/transfers/imports/${initial.id}/prepare`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }
      )
    )
    expect(await prepared.json()).toMatchObject({
      id: initial.id,
      state: "preparing",
    })
    await preparationStarted
    releasePreparation()
    expect(await waitForWorkspaceImportJob(initial.id)).toMatchObject({
      id: initial.id,
      state: "ready",
      prepared: {
        source: { workspaceId: "ws_fixed", workspaceName: "Original" },
      },
    })
  })
})

describe("workspace root exposure", () => {
  it("returns root for the implicit loopback owner", async () => {
    const res = await app().fetch(new Request("http://localhost/api/workspace"))
    const body = (await res.json()) as { root: string | null }
    expect(typeof body.root).toBe("string")
  })

  it("returns root for a same-origin browser request", async () => {
    const res = await app().fetch(
      new Request("http://localhost/api/workspace", {
        headers: { Origin: "http://localhost" },
      })
    )
    const body = (await res.json()) as { root: string | null }
    expect(typeof body.root).toBe("string")
  })

  it("returns root for an authenticated owner behind an HTTPS-terminating same-host proxy", async () => {
    const { token } = await createToken({ scopes: ["*"] })
    const res = await app().fetch(
      new Request("http://worktable.example.dev/api/workspace", {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://worktable.example.dev",
          "X-Forwarded-Host": "worktable.example.dev",
          "X-Forwarded-Proto": "https",
        },
      })
    )
    const body = (await res.json()) as { root: string | null }
    expect(typeof body.root).toBe("string")
  })

  it("rejects a cross-origin read before exposing workspace metadata", async () => {
    const res = await app().fetch(
      new Request("http://localhost/api/workspace", {
        headers: { Origin: "https://evil.example" },
      })
    )
    const body = (await res.json()) as { root: string | null }
    expect(res.status).toBe(401)
    expect(body).not.toHaveProperty("root")
  })

  it("omits root for a scoped bearer", async () => {
    const { token } = await createToken({ scopes: ["docs:read"] })
    const res = await app().fetch(
      new Request("http://localhost/api/workspace", {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
    const body = (await res.json()) as { root: string | null }
    expect(body.root).toBeNull()
  })
})

describe("concurrent manifest patches", () => {
  it("two simultaneous name PUTs both succeed and leave a valid manifest", async () => {
    seed({
      provenance: {
        mode: "sandbox",
        source: { label: "Alex" },
        disposable: true,
      },
    })
    const a = app().fetch(
      new Request("http://localhost/api/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Alpha" }),
      })
    )
    const b = app().fetch(
      new Request("http://localhost/api/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Beta" }),
      })
    )
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.status).toBe(200)
    expect(rb.status).toBe(200)
    const final = ensureWorkspaceManifest()
    // Last write wins; either name is acceptable, but the merge must not corrupt
    // the manifest or drop unrelated fields.
    expect(["Alpha", "Beta"]).toContain(final.name)
    expect(final.provenance).toEqual({
      mode: "sandbox",
      source: { label: "Alex" },
      disposable: true,
    })
  })
})

describe("workspace clear authorization", () => {
  it("rejects cross-origin browsers and agent tokens before creating a clear review", async () => {
    seed()
    const { token } = await createToken({
      scopes: ["docs:read"],
      agent: "claude",
    })
    for (const headers of [
      { Origin: "https://attacker.example" },
      { Authorization: `Bearer ${token}` },
    ] as Record<string, string>[]) {
      const response = await app().fetch(
        new Request("http://localhost/api/workspace/clear", {
          method: "POST",
          headers,
        })
      )
      expect([401, 403]).toContain(response.status)
    }
    expect(existsSync(join(appDir, "workspace-transfers", "jobs"))).toBe(false)
    expect(readManifest()).toMatchObject({ id: base.id, name: base.name })
  })
})
