import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { recordIndex } from "./record-index.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import {
  seedStarterWorkspace,
  setStarterSeedBeforePublishHookForTests,
  starterWorkspaceReady,
} from "./seed.ts"
import {
  listSpaces,
  readDoc,
  setPreparedSpaceBeforeManifestHookForTests,
  writeSpace,
} from "./store.ts"
import { listWidgets, readWidget, readWidgetHtml } from "./widget-store.ts"
import { listRecords, readRecordCollectionSchema } from "./record-store.ts"
import {
  getBlockingWidgetIssue,
  validateWidgetHtml,
} from "./widget-authoring.ts"

let workspaceDir: string

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-seed-"))
  mkdirSync(join(workspaceDir, "spaces"), { recursive: true })
  setWorkspaceRootOverride(workspaceDir)
})

afterEach(() => {
  setStarterSeedBeforePublishHookForTests(null)
  setPreparedSpaceBeforeManifestHookForTests(null)
  setWorkspaceRootOverride(null)
  if (existsSync(workspaceDir))
    rmSync(workspaceDir, { recursive: true, force: true })
})

describe("starter workspace seeding", () => {
  it("seeds the complete Welcome to Worktable experience on an empty workspace", async () => {
    expect(await starterWorkspaceReady()).toBe(false)
    expect(await seedStarterWorkspace()).toBe(true)
    expect(await starterWorkspaceReady()).toBe(true)

    const spaces = await listSpaces()
    expect(spaces.map((s) => s.id)).toEqual(["welcome"])
    expect(spaces[0]).toMatchObject({
      name: "Welcome to Worktable",
      icon: "hand",
      group: "meta",
      settings: {
        docSort: "custom",
        docOrder: ["ways-to-work", "example-prompts"],
        starterSeedVersion: 1,
        starterSeedStatus: "complete",
      },
    })

    const ways = await readDoc("welcome", "ways-to-work")
    expect(ways.error).toBeNull()
    expect(ways.storedAs).toBe("json")
    expect(ways.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "mermaid",
          props: expect.objectContaining({
            title: "Choose the form that fits the work",
          }),
        }),
      ])
    )

    const prompts = await readDoc("welcome", "example-prompts")
    expect(prompts.error).toBeNull()
    expect(prompts.storedAs).toBe("md")
    expect(prompts.data).toContain("# Example Prompts")
    expect(prompts.data).toContain("Create a Records collection")

    const widgets = await listWidgets("welcome")
    expect(widgets.map((w) => w.id).sort()).toEqual([
      "onboarding-board",
      "welcome",
    ])
    expect(widgets.find((widget) => widget.id === "welcome")).toMatchObject({
      name: "Start Here",
      metadata: { journeyOrder: 1, purpose: "guided-welcome" },
    })
    expect(
      widgets.find((widget) => widget.id === "onboarding-board")
    ).toMatchObject({
      permissions: {
        records: { "onboarding-work": { read: true, update: true } },
      },
    })

    const schema = await readRecordCollectionSchema(
      "welcome",
      "onboarding-work"
    )
    expect(schema.error).toBeNull()
    expect(schema.data).toMatchObject({
      name: "Welcome Guide",
      fields: {
        title: { name: "Guide item", required: true },
        status: {
          values: ["Ready", "In progress", "Next", "Learned"],
        },
        outcome: { name: "User outcome", required: true },
        sequence: { name: "Order", required: true },
      },
    })
    const records = await listRecords("welcome", "onboarding-work", {
      orderBy: "sequence",
      order: "asc",
    })
    expect(records.map((record) => record.data)).toEqual([
      expect.objectContaining({
        sequence: 1,
        status: "Next",
        title: "Explain the building blocks",
      }),
      expect.objectContaining({
        sequence: 2,
        status: "Ready",
        title: "Show useful examples",
      }),
      expect.objectContaining({ sequence: 3, status: "Next" }),
      expect.objectContaining({ sequence: 4, status: "Next" }),
      expect.objectContaining({ sequence: 5, status: "Learned" }),
    ])
  })

  it("seeded HTML docs pass the widget authoring contract", async () => {
    await seedStarterWorkspace()
    const widgets = await listWidgets("welcome")
    for (const widget of widgets) {
      const html = await readWidgetHtml("welcome", widget.id)
      const issues = validateWidgetHtml(html.data!, widget.permissions)
      expect(getBlockingWidgetIssue(issues)).toBeUndefined()
      expect(issues.find((i) => i.code === "browser_storage")).toBeUndefined()
    }

    const startHere = await readWidgetHtml("welcome", "welcome")
    expect(startHere.data).toContain("<h1>Welcome to your Worktable</h1>")
    expect(startHere.data).not.toContain("Work Table")

    const storedBoard = await readWidget("welcome", "onboarding-board")
    expect(storedBoard.data?.description).toContain("Welcome Guide records")
  })

  it("never touches a workspace that already has spaces", async () => {
    const now = new Date().toISOString()
    await writeSpace({
      type: "worktable.space",
      version: 1,
      id: "existing",
      name: "Existing",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: {},
    })

    expect(await seedStarterWorkspace()).toBe(false)
    const spaces = await listSpaces()
    expect(spaces.map((s) => s.id)).toEqual(["existing"])
  })

  it("is idempotent: a second run after seeding is a no-op", async () => {
    expect(await seedStarterWorkspace()).toBe(true)
    expect(await seedStarterWorkspace()).toBe(false)
  })

  it("preserves a workspace populated externally during preparation", async () => {
    let reportReady = () => {}
    let releasePublish = () => {}
    const ready = new Promise<void>((resolve) => {
      reportReady = resolve
    })
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve
    })
    setStarterSeedBeforePublishHookForTests(async () => {
      reportReady()
      await publishGate
    })

    const seeding = seedStarterWorkspace()
    await ready
    const now = new Date().toISOString()
    await writeSpace({
      type: "worktable.space",
      version: 1,
      id: "notes",
      name: "User Notes",
      createdAt: now,
      updatedAt: now,
      createdBy: "user",
      settings: {},
    })
    releasePublish()

    expect(await seeding).toBe(false)
    expect(await listSpaces()).toEqual([
      expect.objectContaining({
        id: "notes",
        name: "User Notes",
        createdBy: "user",
      }),
    ])
    expect(existsSync(join(workspaceDir, "versions", "welcome"))).toBe(false)
  })

  it("does not replace an externally claimed empty welcome directory", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "worktable-seed-app-"))
    setAppDirOverride(appDir)
    recordIndex.start()
    await recordIndex.whenReady()
    let reportReady = () => {}
    let releasePublish = () => {}
    const ready = new Promise<void>((resolve) => {
      reportReady = resolve
    })
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve
    })
    setStarterSeedBeforePublishHookForTests(async () => {
      reportReady()
      await publishGate
    })

    try {
      const seeding = seedStarterWorkspace()
      await ready
      mkdirSync(join(workspaceDir, "spaces", "welcome"))
      releasePublish()

      expect(await seeding).toBe(false)
      expect(await listSpaces()).toEqual([])
      expect(
        existsSync(join(workspaceDir, "spaces", "welcome", "space.json"))
      ).toBe(false)
      expect(existsSync(join(workspaceDir, "versions", "welcome"))).toBe(false)
      expect(
        recordIndex
          .dumpRowsForTests()
          .some((row) => row.space_id.startsWith("welcome-seed-"))
      ).toBe(false)
    } finally {
      await recordIndex.whenIdle()
      recordIndex.stop()
      setAppDirOverride(null)
      if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true })
    }
  })

  it("removes only unchanged starter payload after a manifest collision", async () => {
    let reportPayloadMoved = () => {}
    let releaseManifest = () => {}
    const payloadMoved = new Promise<void>((resolve) => {
      reportPayloadMoved = resolve
    })
    const manifestGate = new Promise<void>((resolve) => {
      releaseManifest = resolve
    })
    setPreparedSpaceBeforeManifestHookForTests(async () => {
      reportPayloadMoved()
      await manifestGate
    })

    const seeding = seedStarterWorkspace()
    await payloadMoved
    const welcomeDir = join(workspaceDir, "spaces", "welcome")
    const now = new Date().toISOString()
    writeFileSync(
      join(welcomeDir, "space.json"),
      JSON.stringify({
        type: "worktable.space",
        version: 1,
        id: "welcome",
        name: "Synced Welcome",
        createdAt: now,
        updatedAt: now,
        createdBy: "sync",
        settings: {},
      })
    )
    writeFileSync(join(welcomeDir, "synced.txt"), "preserve me")
    const syncedDoc = [
      {
        id: "synced-note",
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "Synced content", styles: {} }],
        children: [],
      },
    ]
    writeFileSync(
      join(welcomeDir, "docs", "ways-to-work.json"),
      JSON.stringify(syncedDoc)
    )
    releaseManifest()

    expect(await seeding).toBe(false)
    expect(await listSpaces()).toEqual([
      expect.objectContaining({ id: "welcome", name: "Synced Welcome" }),
    ])
    expect(readFileSync(join(welcomeDir, "synced.txt"), "utf8")).toBe(
      "preserve me"
    )
    expect((await readDoc("welcome", "ways-to-work")).data).toEqual(syncedDoc)
    expect((await readDoc("welcome", "example-prompts")).data).toBeNull()
    expect(existsSync(join(welcomeDir, "widgets", "welcome"))).toBe(false)
    expect(existsSync(join(welcomeDir, "records", "onboarding-work"))).toBe(
      false
    )
  })
})
