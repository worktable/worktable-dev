import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeDoc, writeSpace } from "./store.ts"
import {
  createAnnotation,
  listAnnotations,
  replyAnnotation,
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
    for (const path of ["orphan", "long", "notes"]) {
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

  it("resolves generated findings and leaves replies and human notes open", async () => {
    const orphan = await annotate("orphan", LINT, ["lint", "lint:orphan-doc"])
    const discussed = await annotate("long", LINT, ["lint", "lint:doc-too-long"])
    await replyAnnotation(SPACE, discussed, "Keeping this long on purpose.", {
      type: "user",
      id: "user",
    })
    const human = await annotate("notes", { type: "user", id: "user" }, ["lint"])

    const [receipt] = await retireLintAnnotations()

    expect(receipt).toEqual({
      spaceId: SPACE,
      resolved: [orphan],
      keptWithReplies: [discussed],
    })
    expect(await statusOf(orphan)).toBe("resolved")
    expect(await statusOf(discussed)).toBe("open")
    expect(await statusOf(human)).toBe("open")

    // A later boot finds nothing new to resolve.
    const again = await retireLintAnnotations()
    expect(again.flatMap((r) => r.resolved)).toEqual([])
  })
})
