import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeDoc, writeSpace } from "./store.ts"
import {
  createAnnotation,
  listAnnotations,
  replyAnnotation,
  resolveAnnotation,
  updateAnnotation,
} from "./annotation-store.ts"
import { retireLintAnnotations } from "./lint-retirement.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { setAppDirOverride } from "./app-storage.ts"
import type { AnnotationAuthor, SpaceFile } from "@worktable/types"

const testDir = join(tmpdir(), `worktable-lint-retirement-test-${Date.now()}`)
const appDir = join(tmpdir(), `worktable-lint-retirement-app-${Date.now()}`)
const SPACE = "lint-retirement-space"
const LINT: AnnotationAuthor = {
  type: "system",
  id: "worktable-lint",
  name: "Worktable Lint",
}

function makeSpace(id: string): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

async function annotate(
  docPath: string,
  author: AnnotationAuthor,
  labels: string[]
): Promise<string> {
  const { annotation } = await createAnnotation(SPACE, {
    target: { type: "doc", docPath },
    category: "comment",
    title: "Finding",
    body: "Generated finding",
    author,
    labels,
  })
  return annotation.id
}

async function statusOf(id: string): Promise<string | undefined> {
  const { annotations } = await listAnnotations(SPACE, {
    includeResolved: true,
    limit: 1000,
  })
  return annotations.find((annotation) => annotation.id === id)?.status
}

describe("lint retirement", () => {
  beforeEach(async () => {
    setWorkspaceRootOverride(testDir)
    setAppDirOverride(appDir)
    ensureWorkspaceManifest()
    mkdirSync(join(testDir, "spaces"), { recursive: true })
    await writeSpace(makeSpace(SPACE))
    for (const path of ["orphan", "long", "notes", "kept"]) {
      await writeDoc(SPACE, path, `# ${path}`, {
        updatedBy: "test",
        source: "rest-api",
      })
    }
  })

  afterEach(() => {
    setWorkspaceRootOverride(null)
    setAppDirOverride(null)
    for (const dir of [testDir, appDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resolves generated findings and leaves engaged findings and human notes open", async () => {
    const orphan = await annotate("orphan", LINT, ["lint", "lint:orphan-doc"])
    const discussed = await annotate("long", LINT, ["lint", "lint:doc-too-long"])
    await replyAnnotation(SPACE, discussed, "Keeping this long on purpose.", {
      type: "user",
      id: "user",
    })
    const reopened = await annotate("kept", LINT, ["lint", "lint:orphan-doc"])
    await resolveAnnotation(SPACE, reopened, "Rule passes", LINT.id)
    await updateAnnotation(SPACE, reopened, { status: "open" }, "user")
    const human = await annotate("notes", { type: "user", id: "user" }, ["lint"])

    const [receipt] = await retireLintAnnotations()

    expect(receipt?.spaceId).toBe(SPACE)
    expect(receipt?.resolved).toEqual([orphan])
    expect(receipt?.keptWithFeedback.sort()).toEqual([discussed, reopened].sort())
    expect(receipt?.failed).toEqual([])
    expect(await statusOf(orphan)).toBe("resolved")
    expect(await statusOf(discussed)).toBe("open")
    expect(await statusOf(reopened)).toBe("open")
    expect(await statusOf(human)).toBe("open")

    // A later boot finds nothing new to resolve.
    const again = await retireLintAnnotations()
    expect(again.flatMap((r) => r.resolved)).toEqual([])
  })

  it("retires findings across pages while skipping the ones it keeps", async () => {
    const kept = await annotate("long", LINT, ["lint", "lint:doc-too-long"])
    await replyAnnotation(SPACE, kept, "Keep this.", { type: "user", id: "user" })
    const retired = [
      await annotate("orphan", LINT, ["lint", "lint:orphan-doc"]),
      await annotate("notes", LINT, ["lint", "lint:orphan-doc"]),
      await annotate("kept", LINT, ["lint", "lint:orphan-doc"]),
    ]

    const [receipt] = await retireLintAnnotations({ pageSize: 1 })

    expect(receipt?.resolved.sort()).toEqual([...retired].sort())
    expect(receipt?.keptWithFeedback).toEqual([kept])
  })
})
