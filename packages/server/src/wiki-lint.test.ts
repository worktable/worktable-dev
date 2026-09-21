import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeDoc, writeSpace, deleteDoc } from "./store.ts"
import { listAnnotations } from "./annotation-store.ts"
import {
  evaluateSpaceLint,
  applyLintFindings,
  runSpaceLint,
  lintIdempotencyKey,
  LintScheduler,
  LINT_AUTHOR,
} from "./wiki-lint.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { setAppDirOverride } from "./app-storage.ts"
import type { Annotation, SpaceFile } from "@worktable/types"

const testDir = join(tmpdir(), `worktable-wiki-lint-test-${Date.now()}`)
const appDir = join(tmpdir(), `worktable-wiki-lint-app-${Date.now()}`)
const spacesDir = join(testDir, "spaces")
// Unique space id: stray async writes leaking from other test files in Bun's
// shared process target "test-space"; a space nobody else uses keeps the
// exact-list assertions below immune to that (pre-existing) leak class.
const SPACE = "wiki-lint-space"

function makeSpace(
  id: string,
  settings: SpaceFile["settings"] = {}
): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings,
  }
}

const write = (path: string, md: string) =>
  writeDoc(SPACE, path, md, { updatedBy: "test", source: "rest-api" })

async function lintAnnotations(includeResolved = false): Promise<Annotation[]> {
  const { annotations } = await listAnnotations(SPACE, {
    labels: ["lint"],
    includeResolved,
    limit: 1000,
  })
  return annotations
}

describe("wiki lint", () => {
  beforeEach(async () => {
    setWorkspaceRootOverride(testDir)
    setAppDirOverride(appDir)
    ensureWorkspaceManifest()
    mkdirSync(spacesDir, { recursive: true })
    await writeSpace(makeSpace(SPACE))
  })

  afterEach(() => {
    setWorkspaceRootOverride(null)
    setAppDirOverride(null)
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
    if (existsSync(appDir)) {
      rmSync(appDir, { recursive: true, force: true })
    }
  })

  it("broken-links finding carries exact key, labels, and system author", async () => {
    // hub↔a cycle keeps the orphan rule quiet; only the broken link fires.
    await write("hub", "# Hub\n\n[a](/a) and [gone](/never-written)")
    await write("a", "# A\n\n[hub](/hub)")
    await runSpaceLint(SPACE)

    const open = await lintAnnotations()
    expect(open).toHaveLength(1)
    const finding = open[0]!
    expect(finding.idempotencyKey).toBe(
      lintIdempotencyKey("broken-links", "hub")
    )
    expect(finding.labels).toEqual(["lint", "lint:broken-links"])
    expect(finding.author).toEqual(LINT_AUTHOR)
    expect(finding.category).toBe("comment")
    expect(finding.body).toContain("/never-written")
    expect(finding.target).toEqual({ type: "doc", docPath: "hub" })
  })

  it("second run is a no-op (no duplicates, no churn)", async () => {
    await write("hub", "# Hub\n\n[gone](/never-written)")
    await write("a", "# A\n\n[hub](/hub)")
    await runSpaceLint(SPACE)
    const first = await lintAnnotations()
    await runSpaceLint(SPACE)
    const second = await lintAnnotations()

    expect(second.map((a) => a.id).sort()).toEqual(
      first.map((a) => a.id).sort()
    )
    const firstById = new Map(first.map((a) => [a.id, a.updatedAt]))
    for (const annotation of second) {
      expect(annotation.updatedAt).toBe(firstById.get(annotation.id)!)
    }
  })

  it("fixing the doc auto-resolves; re-breaking reopens the SAME annotation", async () => {
    await write("hub", "# Hub\n\n[other](/other) [gone](/never-written)")
    await write("other", "# Other\n\n[hub](/hub)")
    await runSpaceLint(SPACE)
    const [finding] = await lintAnnotations()
    expect(finding?.status).toBe("open")
    expect(finding?.idempotencyKey).toBe(
      lintIdempotencyKey("broken-links", "hub")
    )

    await write("hub", "# Hub\n\n[other](/other)")
    await runSpaceLint(SPACE)
    expect(await lintAnnotations()).toHaveLength(0)
    const resolved = (await lintAnnotations(true)).find(
      (a) => a.id === finding!.id
    )
    expect(resolved?.status).toBe("resolved")

    await write("hub", "# Hub\n\n[other](/other) [gone](/never-written)")
    await runSpaceLint(SPACE)
    const reopened = await lintAnnotations()
    expect(reopened).toHaveLength(1)
    expect(reopened[0]!.id).toBe(finding!.id)
    expect(reopened[0]!.status).toBe("open")
  })

  it("orphan rule stays silent in spaces that do not use links", async () => {
    await write("a", "# A\n\nplain doc")
    await write("b", "# B\n\nplain doc")
    const findings = await evaluateSpaceLint(SPACE)
    expect(findings.filter((f) => f.rule === "orphan-doc")).toHaveLength(0)
  })

  it("orphan rule flags unlinked docs once linking is in use, but never a sole doc", async () => {
    await write("hub", "# Hub\n\n[a](/a)")
    await write("a", "# A")
    await write("loner", "# Loner")
    const findings = await evaluateSpaceLint(SPACE)
    const orphans = findings
      .filter((f) => f.rule === "orphan-doc")
      .map((f) => f.docPath)
      .sort()
    // hub has no inbound links either — both hub and loner are orphans.
    expect(orphans).toEqual(["hub", "loner"])

    // Sole doc in a space: never an orphan (guarded by activePaths.size > 1;
    // also inbound is empty so the rule is inactive anyway).
    const soleSpace = "sole-space"
    await writeSpace(makeSpace(soleSpace))
    await writeDoc(soleSpace, "only", "# Only", {
      updatedBy: "test",
      source: "rest-api",
    })
    expect(await evaluateSpaceLint(soleSpace)).toHaveLength(0)
  })

  it("doc-too-long respects per-space settings override", async () => {
    await writeSpace(makeSpace(SPACE, { wiki: { docLengthBudgetLines: 3 } }))
    await write("long-doc", "# Long\n\nline\nline\nline\nline")
    const findings = await evaluateSpaceLint(SPACE)
    const tooLong = findings.find((f) => f.rule === "doc-too-long")
    expect(tooLong?.docPath).toBe("long-doc")
    expect(tooLong?.body).toContain("budget 3")
  })

  it("body updates only when the finding changes", async () => {
    const key = lintIdempotencyKey("broken-links", "hub")
    await write("hub", "# Hub\n\n[other](/other) [gone](/never-written)")
    await write("other", "# Other\n\n[hub](/hub)")
    await runSpaceLint(SPACE)
    const before = (await lintAnnotations()).find(
      (a) => a.idempotencyKey === key
    )

    await write(
      "hub",
      "# Hub\n\n[other](/other) [gone](/never-written) [also-gone](/also-missing)"
    )
    await runSpaceLint(SPACE)
    const after = (await lintAnnotations()).find(
      (a) => a.idempotencyKey === key
    )
    expect(after!.id).toBe(before!.id)
    expect(after!.body).toContain("/also-missing")
    expect(after!.updatedAt).not.toBe(before!.updatedAt)
  })

  it("deleting a doc removes its findings and exposes newly broken links", async () => {
    const hubKey = lintIdempotencyKey("broken-links", "hub")
    await write("hub", "# Hub\n\n[other](/other) [gone](/never-written)")
    await write("other", "# Other\n\n[hub](/hub)")
    await runSpaceLint(SPACE)
    expect((await lintAnnotations()).map((a) => a.idempotencyKey)).toEqual([
      hubKey,
    ])

    await deleteDoc(SPACE, "hub")
    await runSpaceLint(SPACE)
    const open = await lintAnnotations()
    // hub's finding resolved with the doc; other's link to hub is now broken.
    expect(open.map((a) => a.idempotencyKey)).toEqual([
      lintIdempotencyKey("broken-links", "other"),
    ])
    expect(
      (await lintAnnotations(true)).some(
        (a) => a.idempotencyKey === hubKey
      )
    ).toBe(false)
  })

  it("archiving a doc resolves its findings and notifies the change listeners", async () => {
    const { setDocArchived } = await import("./store.ts")
    const { onDocContentChanged } = await import("./content-events.ts")
    await write("hub", "# Hub\n\n[other](/other) [gone](/never-written)")
    await write("other", "# Other\n\n[hub](/hub)")
    await runSpaceLint(SPACE)
    expect(await lintAnnotations()).toHaveLength(1)

    const notified: string[] = []
    const unsubscribe = onDocContentChanged((_spaceId, docPath) =>
      notified.push(docPath)
    )
    await setDocArchived(SPACE, "hub", true)
    unsubscribe()
    // Archive-state changes must reach the same listeners as content writes —
    // this is what lets the scheduler react instead of waiting for the sweep.
    expect(notified).toContain("hub")

    await runSpaceLint(SPACE)
    // hub's finding resolves with the archive. other's link to hub is NOT
    // broken — archived is not missing — so no new finding appears either.
    expect(await lintAnnotations()).toHaveLength(0)
    const hubResolved = (await lintAnnotations(true)).find(
      (a) => a.idempotencyKey === lintIdempotencyKey("broken-links", "hub")
    )
    expect(hubResolved?.status).toBe("resolved")
  })

  it("scheduler collapses a burst of changes into one run per space", async () => {
    const runs: string[] = []
    const scheduled = new Map<number, () => void>()
    let nextTimer = 0
    const scheduler = new LintScheduler({
      runner: async (spaceId) => {
        runs.push(spaceId)
      },
      debounceMs: 20,
      schedule: (callback) => {
        nextTimer += 1
        scheduled.set(nextTimer, callback)
        return nextTimer as unknown as ReturnType<typeof setTimeout>
      },
      cancel: (timer) => {
        scheduled.delete(timer as unknown as number)
      },
    })

    for (let i = 0; i < 10; i++) scheduler.noteDocChanged(SPACE, `doc-${i}`)
    scheduler.noteDocChanged("other-space", "doc")
    for (const callback of [...scheduled.values()]) callback()
    await scheduler.stop()

    expect(runs.filter((s) => s === SPACE)).toHaveLength(1)
    expect(runs.filter((s) => s === "other-space")).toHaveLength(1)
  })

  it("does not accept new work after its lifecycle is stopped", async () => {
    const runs: string[] = []
    const scheduler = new LintScheduler({
      runner: async (spaceId) => {
        runs.push(spaceId)
      },
      debounceMs: 5,
    })

    await scheduler.stop()
    scheduler.noteDocChanged(SPACE, "late-doc")

    expect(runs).toEqual([])
  })
})
