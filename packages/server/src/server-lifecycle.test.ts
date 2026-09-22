import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import {
  setStarterSeedRequestWaitHookForTests,
  setStarterSeedScheduleHookForTests,
  setWorkspaceWatcherTestOptions,
  startServer,
} from "./index.ts"
import { getDocProvenance, readDoc, writeDoc } from "./store.ts"
import { buildWidgetFile } from "./widget-authoring.ts"
import { withWidgetWriteLock, writeWidget } from "./widget-store.ts"
import { listWidgetVersions } from "./widget-version-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import {
  notifyWorkspaceChange,
  notifyWorkspaceChangeAndWait,
  onWorkspaceChange,
} from "./workspace-events.ts"
import { notifyDocContentChanged } from "./content-events.ts"
import { beginLink } from "./linked-runtime.ts"
import { lintScheduler } from "./wiki-lint.ts"
import { withVersionKeyLock } from "./version-store.ts"
import { withWorkspaceExportSnapshot } from "./workspace-export-coordinator.ts"
import { yjsManager } from "./yjs-manager.ts"

const paragraph = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text, styles: {} }],
})

async function waitForWatcherEvent(
  event: Promise<void>,
  timeoutMessage: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), 2_000)
  })
  try {
    await Promise.race([event, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe("server lifecycle", () => {
  let appDir = ""
  let workspaceDir = ""
  let server: ReturnType<typeof startServer> | null = null

  beforeEach(() => {
    appDir = mkdtempSync(join(tmpdir(), "worktable-lifecycle-app-"))
    workspaceDir = mkdtempSync(join(tmpdir(), "worktable-lifecycle-ws-"))
    setAppDirOverride(appDir)
    setWorkspaceRootOverride(workspaceDir)
  })

  afterEach(async () => {
    await server?.stop(true)
    server = null
    setStarterSeedRequestWaitHookForTests(null)
    setStarterSeedScheduleHookForTests(null)
    setWorkspaceWatcherTestOptions(null)
    setWorkspaceRootOverride(null)
    setAppDirOverride(null)
    for (const dir of [workspaceDir, appDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  it("closes the listener while a linked enrollment is still draining", async () => {
    server = startServer(0, "127.0.0.1")
    const url = `http://127.0.0.1:${server.port}/api/linked`
    const realFetch = globalThis.fetch
    let release!: () => void
    let started!: () => void
    const requested = new Promise<void>((resolve) => {
      started = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider = spyOn(globalThis, "fetch").mockImplementation((async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      if (String(input).endsWith("/linked/enroll")) {
        started()
        await held
        return Response.json({
          url: "https://app.worktable.cloud/linked/approve?request=test",
        })
      }
      return realFetch(input, init)
    }) as typeof fetch)
    const enrollment = beginLink()
    let stopping: Promise<void> | undefined
    try {
      await requested
      stopping = server.stop(true)
      await expect(
        realFetch(url, { signal: AbortSignal.timeout(1000) })
      ).rejects.toThrow()
    } finally {
      release()
      await enrollment
      await stopping
      provider.mockRestore()
    }
  })

  it("drains in-flight handlers and stops filesystem events before resolving", async () => {
    server = startServer(0, "127.0.0.1")

    let release!: () => void
    let started!: () => void
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const observed: string[] = []
    const off = onWorkspaceChange(async (event) => {
      if (event.type !== "space") return
      observed.push(event.spaceId)
      if (event.spaceId === "held") {
        started()
        await released
      }
    })

    try {
      notifyWorkspaceChange({ type: "space", spaceId: "held" })
      await handlerStarted
      let stopped = false
      const stopping = server.stop(true).then(() => {
        stopped = true
      })
      await Promise.resolve()
      expect(stopped).toBe(false)
      expect(() => startServer(0, "127.0.0.1")).toThrow(/await server\.stop/i)

      release()
      await stopping
      expect(stopped).toBe(true)

      const afterDir = join(workspaceDir, "spaces", "after")
      mkdirSync(afterDir, { recursive: true })
      writeFileSync(
        join(afterDir, "space.json"),
        JSON.stringify({ id: "after", name: "After" })
      )
      const quietDeadline = Date.now() + 100
      while (Date.now() < quietDeadline) {
        if (observed.includes("after")) break
        // test-policy: external-readiness-backoff
        await Bun.sleep(5)
      }
      expect(observed).toEqual(["held"])

      server = startServer(0, "127.0.0.1")
      await server.stop(true)
    } finally {
      off()
    }
  })

  it("holds workspace requests until the first-run seed is published", async () => {
    const previousSkipSeed = process.env["WORKTABLE_SKIP_STARTER_SEED"]
    delete process.env["WORKTABLE_SKIP_STARTER_SEED"]

    let releaseSeed = () => {}
    let reportSeedStarted = () => {}
    const seedStarted = new Promise<void>((resolve) => {
      reportSeedStarted = resolve
    })
    const seedGate = new Promise<void>((resolve) => {
      releaseSeed = resolve
    })
    const waitingRequests = new Set<string>()
    let reportRequestsWaiting = () => {}
    const requestsWaiting = new Promise<void>((resolve) => {
      reportRequestsWaiting = resolve
    })
    setStarterSeedScheduleHookForTests(async () => {
      reportSeedStarted()
      await seedGate
    })
    setStarterSeedRequestWaitHookForTests((method, path) => {
      waitingRequests.add(`${method} ${path}`)
      if (waitingRequests.size === 2) reportRequestsWaiting()
    })

    try {
      server = startServer(0, "127.0.0.1")
      const origin = `http://127.0.0.1:${server.port}`
      await seedStarted

      // Desktop verifies this read-only identity endpoint inside its health
      // deadline before beginning the separate Welcome readiness wait.
      const identityResponse = await fetch(`${origin}/api/workspace`)
      expect(identityResponse.status).toBe(200)

      let listSettled = false
      let createSettled = false
      const listRequest = fetch(`${origin}/api/spaces`).finally(() => {
        listSettled = true
      })
      const createRequest = fetch(`${origin}/api/spaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Welcome" }),
      }).finally(() => {
        createSettled = true
      })

      await requestsWaiting
      expect(waitingRequests).toEqual(
        new Set(["GET /api/spaces", "POST /api/spaces"])
      )
      expect(listSettled).toBe(false)
      expect(createSettled).toBe(false)

      releaseSeed()
      const [listResponse, createResponse] = await Promise.all([
        listRequest,
        createRequest,
      ])
      expect(listResponse.status).toBe(200)
      expect(createResponse.status).toBe(201)
      expect(
        ((await listResponse.json()) as { spaces: Array<{ id: string }> }).spaces
          .map((space) => space.id)
          .includes("welcome")
      ).toBe(true)
      expect(
        (await createResponse.json()) as { spaceId: string }
      ).toEqual({ spaceId: "welcome-2" })
    } finally {
      releaseSeed()
      if (previousSkipSeed === undefined) {
        delete process.env["WORKTABLE_SKIP_STARTER_SEED"]
      } else {
        process.env["WORKTABLE_SKIP_STARTER_SEED"] = previousSkipSeed
      }
    }
  }, 15_000)

  it.each([1, 2])("flushes a V%s coalesced HTML version before stop without inverting write locks", async (version) => {
    server = startServer(0, "127.0.0.1")
    const written = await writeWidget(
      "meta",
      buildWidgetFile({ id: "status", name: "Status" }),
      "<!doctype html><html><body>Status</body></html>"
    )
    expect(written.error).toBeNull()
    written.release?.()
    if (version === 2) {
      const manifest = join(workspaceDir, "worktable.workspace.json")
      writeFileSync(manifest, JSON.stringify({
        ...JSON.parse(readFileSync(manifest, "utf8")), version: 2,
      }))
      rmSync(join(workspaceDir, "spaces", "meta", "widgets", "status"), { recursive: true })
      mkdirSync(join(workspaceDir, "spaces", "meta", "docs"), { recursive: true })
      writeFileSync(join(workspaceDir, "spaces", "meta", "docs", "status.html"), "<h1>Status</h1>")
    }

    let stopping!: Promise<void>
    await withDocPathLock("meta", async () => {
      notifyWorkspaceChange({
        type: "widget",
        spaceId: "meta",
        widgetId: "status",
      })
      stopping = server!.stop(true)
      // Allow the shutdown flush to queue behind this namespace transaction.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await waitForWatcherEvent(
        withWidgetWriteLock("meta", "status", async () => {}),
        "watcher took the widget lock before the document namespace lock"
      )
    })
    await stopping

    const versions = await listWidgetVersions("meta", "status", {
      checkpointsOnly: false,
    })
    expect(versions).toHaveLength(1)
    expect(versions[0]?.operation).toBe("create")
  })

  it("flushes a coalesced widget version before capturing an export", async () => {
    let reportPending!: () => void
    const watcherPending = new Promise<void>((resolve) => {
      reportPending = resolve
    })
    setWorkspaceWatcherTestOptions({
      debounceMs: 60_000,
      onPendingChange: (event) => {
        if (
          event &&
          "spaceId" in event &&
          event.spaceId === "meta" &&
          (event.type === "space" ||
            (event.type === "widget" && event.widgetId === "export-status"))
        ) {
          reportPending()
        }
      },
    })
    server = startServer(0, "127.0.0.1")
    const written = await writeWidget(
      "meta",
      buildWidgetFile({ id: "export-status", name: "Export status" }),
      "<!doctype html><html><body>Export status</body></html>"
    )
    expect(written.error).toBeNull()
    written.release?.()
    await waitForWatcherEvent(
      watcherPending,
      "filesystem watcher did not queue the HTML change"
    )
    const versionsAtCapture = await withWorkspaceExportSnapshot(() =>
      listWidgetVersions("meta", "export-status", {
        checkpointsOnly: false,
      })
    )

    expect(versionsAtCapture).toHaveLength(1)
    expect(versionsAtCapture[0]?.operation).toBe("create")
  })

  it("reconciles a queued external Rich Doc edit before export persistence", async () => {
    const docPath = "export-rich"
    ensureWorkspaceManifest()
    await writeDoc("meta", docPath, [paragraph("Initial")], {
      updatedBy: "user",
      source: "browser-yjs",
    })
    let reportPending!: () => void
    const watcherPending = new Promise<void>((resolve) => {
      reportPending = resolve
    })
    setWorkspaceWatcherTestOptions({
      debounceMs: 60_000,
      onPendingChange: (event) => {
        if (
          event?.type === "doc" &&
          event.spaceId === "meta" &&
          event.docPath === docPath
        ) {
          reportPending()
        }
      },
    })
    server = startServer(0, "127.0.0.1")
    await yjsManager.getOrCreateDoc("meta", docPath)

    const storedPath = join(
      workspaceDir,
      "spaces",
      "meta",
      "docs",
      `${docPath}.json`
    )
    const loadedStat = statSync(storedPath)
    writeFileSync(
      storedPath,
      JSON.stringify([paragraph("External")])
    )
    // Isolate the export ordering from Yjs's independent >500 ms mtime guard:
    // the unsafe old order must not get a second way to discover this edit.
    utimesSync(storedPath, loadedStat.atime, loadedStat.mtime)
    await waitForWatcherEvent(
      watcherPending,
      "filesystem watcher did not queue the Rich Doc edit"
    )

    const captured = await withWorkspaceExportSnapshot(async () => ({
      doc: await readDoc("meta", docPath),
      provenance: await getDocProvenance("meta", docPath),
    }))
    expect(captured.doc.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "paragraph",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "External" }),
          ]),
        }),
      ])
    )
    expect(captured.provenance?.source).toBe("filesystem")
  })

  it("holds replay ordering until external doc provenance is recorded", async () => {
    const docPath = "replay-order"
    const mdPath = join(workspaceDir, "spaces", "meta", "docs", `${docPath}.md`)
    ensureWorkspaceManifest()
    await writeDoc("meta", docPath, "# Initial\n", {
      updatedBy: "agent",
      source: "test",
    })
    writeFileSync(mdPath, "# External\n")
    server = startServer(0, "127.0.0.1")

    let releaseVersionLock!: () => void
    let reportVersionLock!: () => void
    const versionLockAcquired = new Promise<void>((resolve) => {
      reportVersionLock = resolve
    })
    const holdVersionLock = new Promise<void>((resolve) => {
      releaseVersionLock = resolve
    })
    const versionLock = withVersionKeyLock(
      "meta",
      "docs",
      docPath,
      async () => {
        reportVersionLock()
        await holdVersionLock
      }
    )
    await versionLockAcquired

    let reportDispatched!: () => void
    const dispatched = new Promise<void>((resolve) => {
      reportDispatched = resolve
    })
    const off = onWorkspaceChange((event) => {
      if (
        event.type === "doc" &&
        event.spaceId === "meta" &&
        event.docPath === docPath
      ) {
        reportDispatched()
      }
    })

    try {
      let replaySettled = false
      const replay = withDocPathLock("meta", async () => {
        await notifyWorkspaceChangeAndWait({
          type: "doc",
          spaceId: "meta",
          docPath,
        })
      }).then(() => {
        replaySettled = true
      })
      await dispatched
      await Promise.resolve()
      expect(replaySettled).toBe(false)
      expect(readFileSync(mdPath, "utf8")).toBe("# External\n")

      let newerWriteSettled = false
      const newerWrite = writeDoc("meta", docPath, "# Newer agent write\n", {
        updatedBy: "agent",
        source: "test",
      }).then(() => {
        newerWriteSettled = true
      })
      await Promise.resolve()
      expect(newerWriteSettled).toBe(false)
      expect(readFileSync(mdPath, "utf8")).toBe("# External\n")

      releaseVersionLock()
      await Promise.all([versionLock, replay, newerWrite])
      expect(readFileSync(mdPath, "utf8")).toBe("# Newer agent write\n")
      expect((await getDocProvenance("meta", docPath))?.updatedBy).toBe("agent")
    } finally {
      releaseVersionLock()
      off()
    }
  })

  it("closes owned WebSockets when the caller omits Bun's force flag", async () => {
    server = startServer(0, "127.0.0.1")
    const origin = `http://127.0.0.1:${server.port}`
    const socket = new WebSocket(
      `${origin.replace("http", "ws")}/ws?spaceId=meta`,
      { headers: { Origin: origin } } as unknown as string[]
    )
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("WebSocket did not open"))
    })

    const stopped = await Promise.race([
      server.stop().then(() => true),
      Bun.sleep(1_000).then(() => false),
    ])
    expect(stopped).toBe(true)
    server = null
  })

  it("removes startup listeners when Bun rejects the bind", async () => {
    const occupied = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("occupied"),
    })
    const previousSkip = process.env["WORKTABLE_SKIP_LINT_SWEEP"]
    const noteChanged = spyOn(lintScheduler, "noteDocChanged")
    delete process.env["WORKTABLE_SKIP_LINT_SWEEP"]
    try {
      expect(() => startServer(occupied.port, "127.0.0.1")).toThrow()
      server = startServer(0, "127.0.0.1")
      noteChanged.mockClear()

      notifyDocContentChanged("meta", "one-change")
      expect(noteChanged).toHaveBeenCalledTimes(1)
    } finally {
      if (previousSkip === undefined) {
        delete process.env["WORKTABLE_SKIP_LINT_SWEEP"]
      } else {
        process.env["WORKTABLE_SKIP_LINT_SWEEP"] = previousSkip
      }
      noteChanged.mockRestore()
      await occupied.stop(true)
    }
  })
})
