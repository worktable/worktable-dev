import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fc from "fast-check"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { mkdir, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import { getVersionsDir, setWorkspaceRootOverride } from "./workspace.ts"
import {
  versionKeyDir,
  whenAnyVersionKeyLockDepthForTests,
  whenVersionKeyLockDepthForTests,
  withVersionKeyLock,
} from "./version-store.ts"
import {
  invalidateServerSettingsCache,
  updateServerSettings,
  updateServerSettingsWithResult,
  type RetentionPolicy,
} from "./settings-store.ts"
import {
  ProvenanceProtectionCache,
  pruneDocKeyForCount,
  pruneDocumentGenerationsForCountV2,
  runRetentionSweep,
} from "./version-retention.ts"
import {
  getDocProvenance,
  getDocVersion,
  listDocVersions,
  writeDoc,
  writeSpace,
} from "./store.ts"
import { systemRouter } from "./routes/system.ts"
import { trustedLocalIdentity } from "./auth.ts"
import type { DocumentId, SpaceFile } from "@worktable/types"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import {
  listDocumentGenerationsV2,
  writeDocumentGenerationV2,
} from "./document-version-store-v2.ts"

let appDir: string
let workspaceDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "wt-retain-app-"))
  workspaceDir = mkdtempSync(join(tmpdir(), "wt-retain-ws-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
  invalidateServerSettingsCache()
  delete process.env["WORKTABLE_REQUIRE_AUTH"]
  delete process.env["HOST"]
})

afterEach(() => {
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  invalidateServerSettingsCache()
  rmSync(appDir, { recursive: true, force: true })
  rmSync(workspaceDir, { recursive: true, force: true })
  process.env = { ...originalEnv }
})

// Mirror mintVersionId's format: an ISO timestamp with `:`/`.` → `-`, then a
// suffix. `versionIdTimestamp` reverses exactly this, so ordering + age come
// from the encoded time — no Date mocking.
function vid(date: Date, suffix: string): string {
  return `${date.toISOString().replace(/[:.]/g, "-")}-${suffix}`
}

async function writeVersionFile(
  spaceId: string,
  docPath: string,
  versionId: string,
  mtime?: Date
): Promise<string> {
  const dir = versionKeyDir(spaceId, "docs", docPath)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${versionId}.json`)
  await writeFile(
    path,
    JSON.stringify({
      type: "worktable.doc-version",
      version: 1,
      id: versionId,
      spaceId,
      createdAt: new Date().toISOString(),
      after: { format: "md", storedAs: "md", contentHash: "x", content: "x" },
    })
  )
  if (mtime) await utimes(path, mtime, mtime)
  return path
}

function remainingIds(spaceId: string, docPath: string): string[] {
  const dir = versionKeyDir(spaceId, "docs", docPath)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.replace(/\.json$/, ""))
}

const DAY = 24 * 60 * 60 * 1000

async function writeTestSpace(spaceId: string): Promise<void> {
  const now = new Date().toISOString()
  const space: SpaceFile = {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: spaceId,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
  await writeSpace(space)
}

async function writeV2Generation(
  spaceId: string,
  documentId: DocumentId,
  createdAt: string,
  suffix: string,
  meaningful = false
): Promise<void> {
  await writeDocumentGenerationV2({
    workspaceRoot: workspaceDir,
    spaceId,
    documentId,
    generationId: vid(new Date(createdAt), suffix),
    logicalPath: `notes/${documentId}`,
    format: { id: BUILTIN_DOCUMENT_FORMATS.markdown, sourceVersion: 1 },
    operation: meaningful ? "checkpoint" : "update",
    createdAt,
    createdBy: "test",
    source: "retention-test",
    ...(meaningful
      ? { checkpoint: { meaningful: true, kind: "manual" as const } }
      : {}),
    authoredSource: {
      kind: "file",
      entries: [{ path: "document.md", bytes: Buffer.from(suffix) }],
    },
  })
}

// ============================================================
// Property-based invariants
// ============================================================

describe("runRetentionSweep — property invariants", () => {
  // Per-doc: distinct second-offsets back from a fixed base, so every snapshot
  // has a unique, unambiguous timestamp (no tie-break edge cases in the oracle).
  const docArb = fc.record({
    name: fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
    offsets: fc.uniqueArray(fc.integer({ min: 0, max: 400 }), {
      minLength: 1,
      maxLength: 8,
    }),
  })

  const policyArb: fc.Arbitrary<RetentionPolicy> = fc.oneof(
    fc.constant<RetentionPolicy>({ mode: "all" }),
    fc
      .integer({ min: 1, max: 365 })
      .map((d) => ({ mode: "age", maxAgeDays: d }) as const),
    fc
      .integer({ min: 1, max: 6 })
      .map((n) => ({ mode: "count", maxPerDoc: n }) as const)
  )

  it("holds all five invariants across random docs × timestamps × policies", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(docArb, {
          minLength: 1,
          maxLength: 4,
          selector: (d) => d.name,
        }),
        policyArb,
        async (docs, policy) => {
          // Fresh versions tree per run.
          rmSync(getVersionsDir(), { recursive: true, force: true })
          const base = Date.now()
          const spaceId = "sp"

          // A sentinel OUTSIDE the versions dir — invariant 2 (only files under
          // getVersionsDir() are touched) means it must survive every sweep.
          const sentinel = join(workspaceDir, "sentinel.json")
          await writeFile(sentinel, "keep")

          const created = new Map<string, string[]>() // doc → ids (any order)
          const tsById = new Map<string, number>()
          for (const doc of docs) {
            const ids: string[] = []
            for (const off of doc.offsets) {
              const t = base - off * 1000
              const id = vid(new Date(t), `${off}`)
              await writeVersionFile(spaceId, doc.name, id)
              ids.push(id)
              tsById.set(id, t)
            }
            created.set(doc.name, ids)
          }

          await runRetentionSweep(policy)

          // Sentinel untouched (invariant 2).
          expect(existsSync(sentinel)).toBe(true)

          for (const [name, ids] of created) {
            const survivors = remainingIds(spaceId, name)
            const sortedNewestFirst = [...ids].sort(
              (a, b) => tsById.get(b)! - tsById.get(a)!
            )
            const newest = sortedNewestFirst[0]!

            // (1) newest always present.
            expect(survivors).toContain(newest)
            // survivors ⊆ original.
            for (const s of survivors) expect(ids).toContain(s)

            if (policy.mode === "all") {
              // (4) hard no-op.
              expect(new Set(survivors)).toEqual(new Set(ids))
            } else if (policy.mode === "count") {
              const expected = sortedNewestFirst.slice(0, policy.maxPerDoc)
              expect(new Set(survivors)).toEqual(new Set(expected))
            }
            // age exactness is covered by the integration tests (boundary-safe
            // timestamps); here we assert the universal guarantees only.
          }

          // (5) idempotent — a second sweep changes nothing.
          const before = docs.map((d) => remainingIds(spaceId, d.name).sort())
          await runRetentionSweep(policy)
          const after = docs.map((d) => remainingIds(spaceId, d.name).sort())
          expect(after).toEqual(before)

          return true
        }
      ),
      { numRuns: 80 }
    )
  }, 30_000)
})

// ============================================================
// Integration — age / count / all
// ============================================================

describe("runRetentionSweep — integration", () => {
  const SP = "space1"

  it("all mode touches nothing", async () => {
    for (let i = 0; i < 5; i++) {
      await writeVersionFile(
        SP,
        "doc",
        vid(new Date(Date.now() - i * DAY), `v${i}`)
      )
    }
    const res = await runRetentionSweep({ mode: "all" })
    expect(res.filesDeleted).toBe(0)
    expect(remainingIds(SP, "doc")).toHaveLength(5)
  })

  it("age mode deletes only out-of-window versions (via naming scheme)", async () => {
    const now = Date.now()
    // In-window (< 30d): kept. Out-of-window (> 30d): deleted, except newest.
    await writeVersionFile(SP, "doc", vid(new Date(now - 1 * DAY), "d1")) // newest, in
    await writeVersionFile(SP, "doc", vid(new Date(now - 10 * DAY), "d10")) // in
    await writeVersionFile(SP, "doc", vid(new Date(now - 40 * DAY), "d40")) // out
    await writeVersionFile(SP, "doc", vid(new Date(now - 90 * DAY), "d90")) // out

    const res = await runRetentionSweep({ mode: "age", maxAgeDays: 30 })
    expect(res.filesDeleted).toBe(2)
    const ids = remainingIds(SP, "doc")
    expect(ids).toHaveLength(2)
    expect(ids.some((i) => i.endsWith("-d1"))).toBe(true)
    expect(ids.some((i) => i.endsWith("-d10"))).toBe(true)
  })

  it("age mode keeps the newest even when it is itself out of window", async () => {
    const now = Date.now()
    await writeVersionFile(SP, "old", vid(new Date(now - 100 * DAY), "a"))
    await writeVersionFile(SP, "old", vid(new Date(now - 200 * DAY), "b"))
    await runRetentionSweep({ mode: "age", maxAgeDays: 30 })
    const ids = remainingIds(SP, "old")
    expect(ids).toHaveLength(1)
    expect(ids[0]!.endsWith("-a")).toBe(true) // the newest survives
  })

  it("age mode uses file mtime when the filename has no encoded timestamp", async () => {
    const now = Date.now()
    // Non-parseable version ids → pruner falls back to mtime.
    await writeVersionFile(
      SP,
      "legacy",
      "legacy-newest",
      new Date(now - 2 * DAY)
    )
    await writeVersionFile(SP, "legacy", "legacy-old", new Date(now - 90 * DAY))
    const res = await runRetentionSweep({ mode: "age", maxAgeDays: 30 })
    expect(res.filesDeleted).toBe(1)
    const ids = remainingIds(SP, "legacy")
    expect(ids).toEqual(["legacy-newest"])
  })

  it("count mode keeps exactly the N newest", async () => {
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      await writeVersionFile(SP, "doc", vid(new Date(now - i * DAY), `v${i}`))
    }
    const res = await runRetentionSweep({ mode: "count", maxPerDoc: 3 })
    expect(res.filesDeleted).toBe(7)
    const ids = remainingIds(SP, "doc")
    expect(ids).toHaveLength(3)
    // The three newest are offsets 0,1,2.
    expect(ids.some((i) => i.endsWith("-v0"))).toBe(true)
    expect(ids.some((i) => i.endsWith("-v1"))).toBe(true)
    expect(ids.some((i) => i.endsWith("-v2"))).toBe(true)
  })

  it("applies count and age policies to active V2 generations", async () => {
    const countDocument = "doc_AAAAAAAAAAAAAAAAAAAAAA" as DocumentId
    const ageDocument = "doc_BBBBBBBBBBBBBBBBBBBBBB" as DocumentId
    const now = Date.now()
    for (let index = 0; index < 3; index += 1) {
      await writeV2Generation(
        SP,
        countDocument,
        new Date(now - index * DAY).toISOString(),
        `count-${index}`,
        index === 2
      )
    }

    await runRetentionSweep({ mode: "count", maxPerDoc: 1 })
    expect(
      await listDocumentGenerationsV2({
        workspaceRoot: workspaceDir,
        spaceId: SP,
        documentId: countDocument,
      })
    ).toHaveLength(2)

    await writeV2Generation(
      SP,
      ageDocument,
      new Date(now - DAY).toISOString(),
      "age-recent"
    )
    await writeV2Generation(
      SP,
      ageDocument,
      new Date(now - 60 * DAY).toISOString(),
      "age-old"
    )
    await runRetentionSweep({ mode: "age", maxAgeDays: 30 })
    const ageVersions = await listDocumentGenerationsV2({
      workspaceRoot: workspaceDir,
      spaceId: SP,
      documentId: ageDocument,
    })
    expect(ageVersions).toHaveLength(1)
    expect(ageVersions[0]?.reason).toBeUndefined()
    expect(ageVersions[0]?.createdAt).toBe(new Date(now - DAY).toISOString())
  })

  it("count mode does not let checkpoint rewrite mtime beat same-ms ids", async () => {
    const stamp = "2026-07-09T10-00-00-000Z"
    const older = `${stamp}-000000-aaaaaa00`
    const latest = `${stamp}-000001-bbbbbb00`
    const oldPath = await writeVersionFile(SP, "same-ms", older)
    const latestPath = await writeVersionFile(SP, "same-ms", latest)
    const now = Date.now()
    await utimes(oldPath, new Date(now), new Date(now))
    await utimes(latestPath, new Date(now - 5000), new Date(now - 5000))

    await runRetentionSweep({ mode: "count", maxPerDoc: 1 })

    expect(remainingIds(SP, "same-ms")).toEqual([latest])
  })

  it("treats a deleted doc's history identically (no doc/space needed)", async () => {
    // No space file, no live doc — just orphaned version snapshots on disk.
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      await writeVersionFile(
        SP,
        "ghost/nested",
        vid(new Date(now - i * DAY), `v${i}`)
      )
    }
    await runRetentionSweep({ mode: "count", maxPerDoc: 2 })
    expect(remainingIds(SP, "ghost/nested")).toHaveLength(2)
  })

  it("prunes across multiple docs and reports a summary", async () => {
    const now = Date.now()
    for (let i = 0; i < 4; i++)
      await writeVersionFile(SP, "a", vid(new Date(now - i * DAY), `a${i}`))
    for (let i = 0; i < 4; i++)
      await writeVersionFile(SP, "b", vid(new Date(now - i * DAY), `b${i}`))
    const res = await runRetentionSweep({ mode: "count", maxPerDoc: 1 })
    expect(res.docsTouched).toBe(2)
    expect(res.filesDeleted).toBe(6)
    expect(remainingIds(SP, "a")).toHaveLength(1)
    expect(remainingIds(SP, "b")).toHaveLength(1)
  })

  it("boot-style sweep reads the policy from settings", async () => {
    const now = Date.now()
    for (let i = 0; i < 6; i++) {
      await writeVersionFile(SP, "doc", vid(new Date(now - i * DAY), `v${i}`))
    }
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 2 } },
    })
    // No policy arg → reads settings, exactly as the boot/interval trigger does.
    const res = await runRetentionSweep()
    expect(res.filesDeleted).toBe(4)
    expect(remainingIds(SP, "doc")).toHaveLength(2)
  })

  it("skips a policy-change sweep after its serialized generation is superseded", async () => {
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      await writeVersionFile(
        SP,
        "superseded",
        vid(new Date(now - i * DAY), `v${i}`)
      )
    }
    const tightened = await updateServerSettingsWithResult({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })
    await updateServerSettings({ history: { retention: { mode: "all" } } })

    const res = await runRetentionSweep(tightened.settings.history.retention, {
      expectedRetentionGeneration: tightened.retentionGeneration,
    })

    expect(res.filesDeleted).toBe(0)
    expect(remainingIds(SP, "superseded")).toHaveLength(5)
  })
})

// ============================================================
// Count-mode post-record trigger
// ============================================================

describe("pruneDocKeyForCount", () => {
  const SP = "space1"

  it("is a no-op unless the policy is count", async () => {
    const now = Date.now()
    for (let i = 0; i < 4; i++)
      await writeVersionFile(SP, "doc", vid(new Date(now - i * DAY), `v${i}`))
    await updateServerSettings({
      history: { retention: { mode: "age", maxAgeDays: 30 } },
    })
    await pruneDocKeyForCount(SP, "doc")
    expect(remainingIds(SP, "doc")).toHaveLength(4)
  })

  it("trims a single over-limit doc to N newest", async () => {
    const now = Date.now()
    for (let i = 0; i < 5; i++)
      await writeVersionFile(SP, "doc", vid(new Date(now - i * DAY), `v${i}`))
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 2 } },
    })
    await pruneDocKeyForCount(SP, "doc")
    expect(remainingIds(SP, "doc")).toHaveLength(2)
  })

  it("keeps every V2 generation in all mode and applies count mode", async () => {
    const documentId = "doc_CCCCCCCCCCCCCCCCCCCCCC" as DocumentId
    const now = Date.now()
    for (let index = 0; index < 3; index += 1) {
      await writeV2Generation(
        SP,
        documentId,
        new Date(now - index * DAY).toISOString(),
        `post-${index}`
      )
    }

    expect(await pruneDocumentGenerationsForCountV2(SP, documentId)).toBe(0)
    expect(
      await listDocumentGenerationsV2({
        workspaceRoot: workspaceDir,
        spaceId: SP,
        documentId,
      })
    ).toHaveLength(3)

    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })
    expect(await pruneDocumentGenerationsForCountV2(SP, documentId)).toBe(2)
    expect(
      await listDocumentGenerationsV2({
        workspaceRoot: workspaceDir,
        spaceId: SP,
        documentId,
      })
    ).toHaveLength(1)
  })
})

// ============================================================
// PUT /api/system/settings — policy-change sweep
// ============================================================

describe("PUT /api/system/settings triggers a sweep", () => {
  const SP = "space1"
  function app() {
    const a = new Hono()
    a.use("/api/*", trustedLocalIdentity())
    a.route("/api/system", systemRouter)
    return a
  }

  it("prunes immediately when the retention policy tightens", async () => {
    const now = Date.now()
    for (let i = 0; i < 8; i++) {
      await writeVersionFile(SP, "doc", vid(new Date(now - i * DAY), `v${i}`))
    }
    const res = await app().fetch(
      new Request("http://localhost/api/system/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          history: { retention: { mode: "count", maxPerDoc: 3 } },
        }),
      })
    )
    expect(res.status).toBe(200)
    // The sweep is awaited inside the route, so state is consistent here.
    expect(remainingIds(SP, "doc")).toHaveLength(3)
  })

  it("does not sweep when the policy is unchanged", async () => {
    const now = Date.now()
    for (let i = 0; i < 4; i++) {
      await writeVersionFile(SP, "doc", vid(new Date(now - i * DAY), `v${i}`))
    }
    // A non-history patch leaves retention at the default "all" → no prune.
    const res = await app().fetch(
      new Request("http://localhost/api/system/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editor: { spellcheck: true } }),
      })
    )
    expect(res.status).toBe(200)
    expect(remainingIds(SP, "doc")).toHaveLength(4)
  })
})

// ============================================================
// Concurrency — recordDocVersion (via writeDoc) racing a sweep
// ============================================================

describe("concurrency: writes interleaved with a sweep", () => {
  const SP = "space1"

  async function makeSpace(): Promise<void> {
    const now = new Date().toISOString()
    const space: SpaceFile = {
      type: "worktable.space",
      version: 1,
      id: SP,
      name: "Space 1",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: {},
    }
    await writeSpace(space)
  }

  it("never loses the newest snapshot and does not crash", async () => {
    await makeSpace()
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 2 } },
    })

    // Seed several real versions through the store.
    for (let i = 0; i < 4; i++) {
      await writeDoc(SP, "note", `line ${i}`, {
        updatedBy: "human",
        source: "test",
      })
    }

    // Hammer writes while sweeps run concurrently on the same doc.
    const work: Promise<unknown>[] = []
    for (let i = 0; i < 6; i++) {
      work.push(
        writeDoc(SP, "note", `content ${i} ${Math.random()}`, {
          updatedBy: "human",
          source: "test",
        })
      )
      work.push(runRetentionSweep({ mode: "count", maxPerDoc: 2 }))
    }
    await Promise.all(work)

    // The live doc's current version must still be listable and readable — the
    // newest snapshot was never pruned out from under a concurrent write.
    const versions = await listDocVersions(SP, "note", {
      checkpointsOnly: false,
    })
    expect(versions.length).toBeGreaterThanOrEqual(1)
    const newest = versions[0]!
    const snapshot = await getDocVersion(SP, "note", newest.id)
    expect(snapshot).not.toBeNull()
    // Survivor count is bounded and sane (never fewer than the newest).
    expect(versions.length).toBeGreaterThanOrEqual(1)
    expect(versions.length).toBeLessThanOrEqual(8)
  })
})

describe("review round 2 hardening", () => {
  it("refuses to prune through a symlinked key dir (P1 boundary)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wt-retention-outside-"))
    try {
      // Three prunable-looking snapshots living OUTSIDE the versions tree.
      for (const stamp of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
        writeFileSync(
          join(outside, `${stamp}T00-00-00-000Z-aaaaaa00.json`),
          "{}"
        )
      }
      const docsRoot = join(getVersionsDir(), "sp", "docs")
      mkdirSync(docsRoot, { recursive: true })
      symlinkSync(outside, join(docsRoot, "linked"), "dir")

      const result = await runRetentionSweep({ mode: "count", maxPerDoc: 1 })
      expect(result.filesDeleted).toBe(0)
      expect(readdirSync(outside)).toHaveLength(3)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("post-write prune protects the just-written version on a same-ms tie", async () => {
    const dir = join(getVersionsDir(), "sp", "docs", "tied")
    mkdirSync(dir, { recursive: true })
    // Identical millisecond prefix, and mtimes forced so the OTHER file sorts
    // newer — the pathological ordering where, without protection, the
    // just-written "aaaa" version (which provenance now points at) would be
    // the deletion candidate under maxPerDoc: 1.
    const stamp = "2026-07-09T10-00-00-000Z"
    const zzz = join(dir, `${stamp}-zzzzzz00.json`)
    const aaa = join(dir, `${stamp}-aaaaaa00.json`)
    writeFileSync(zzz, "{}")
    writeFileSync(aaa, "{}")
    const now = Date.now()
    await utimes(zzz, new Date(now), new Date(now))
    await utimes(aaa, new Date(now - 5000), new Date(now - 5000))
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })
    await pruneDocKeyForCount("sp", "tied", {
      protectVersionId: `${stamp}-aaaaaa00`,
    })
    // The only candidate was the protected version: nothing may be deleted
    // (keeping one extra beats deleting the live doc's current version).
    expect(readdirSync(dir).sort()).toEqual(
      [`${stamp}-aaaaaa00.json`, `${stamp}-zzzzzz00.json`].sort()
    )
    // Sanity: without protection the pathological order really does select it.
    await pruneDocKeyForCount("sp", "tied")
    const after = readdirSync(dir)
    expect(after).toEqual([`${stamp}-zzzzzz00.json`])
  })

  it("prune is best-effort: a broken versions key path resolves instead of rejecting", async () => {
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })
    // A FILE where the key dir should be: readdir throws ENOTDIR inside the
    // prune. The post-write path must swallow that (the content write already
    // succeeded), so the contract is: resolve, never reject.
    const dir = versionKeyDir("sp2", "docs", "resilient")
    mkdirSync(join(getVersionsDir(), "sp2", "docs"), { recursive: true })
    writeFileSync(dir, "not a dir")
    await expect(
      pruneDocKeyForCount("sp2", "resilient")
    ).resolves.toBeUndefined()
  })
})

describe("stale-policy sweeps", () => {
  it("a sweep stops when a later settings write supersedes its policy", async () => {
    // Two docs, each with one prunable old snapshot beside a newer one.
    for (const sp of ["swa", "swb"]) {
      const dir = join(getVersionsDir(), sp, "docs", "note")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "2026-01-01T00-00-00-000Z-aaaaaa00.json"), "{}")
      writeFileSync(join(dir, "2026-07-01T00-00-00-000Z-bbbbbb00.json"), "{}")
    }
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })

    // Hold both docs' per-key locks so the sweep blocks on its first dir,
    // then land a later settings write before releasing — deterministic
    // stand-in for an owner relaxing the policy mid-walk.
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const held = Promise.all([
      withVersionKeyLock("swa", "docs", "note", () => gate),
      withVersionKeyLock("swb", "docs", "note", () => gate),
    ])
    const sweep = runRetentionSweep()
    await whenAnyVersionKeyLockDepthForTests([
      { spaceId: "swa", kind: "docs", key: "note", minimum: 2 },
      { spaceId: "swb", kind: "docs", key: "note", minimum: 2 },
    ])
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 5 } },
    })
    release()
    await held
    const result = await sweep

    // The dir already past its generation check is the bounded residual (its
    // deletion still honored the per-doc lock); every later dir must be left
    // alone for the superseding policy's own sweep.
    expect(result.docsTouched).toBeLessThanOrEqual(1)
    const survivors = ["swa", "swb"].map(
      (sp) => readdirSync(join(getVersionsDir(), sp, "docs", "note")).length
    )
    expect(Math.max(...survivors)).toBe(2) // at least one dir untouched
  })

  it("an unrelated settings write does NOT abort a sweep", async () => {
    for (const sp of ["swc", "swd"]) {
      const dir = join(getVersionsDir(), sp, "docs", "note")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "2026-01-01T00-00-00-000Z-aaaaaa00.json"), "{}")
      writeFileSync(join(dir, "2026-07-01T00-00-00-000Z-bbbbbb00.json"), "{}")
    }
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const held = Promise.all([
      withVersionKeyLock("swc", "docs", "note", () => gate),
      withVersionKeyLock("swd", "docs", "note", () => gate),
    ])
    const sweep = runRetentionSweep()
    await whenAnyVersionKeyLockDepthForTests([
      { spaceId: "swc", kind: "docs", key: "note", minimum: 2 },
      { spaceId: "swd", kind: "docs", key: "note", minimum: 2 },
    ])
    await updateServerSettings({ editor: { spellcheck: true } }) // not a policy change
    release()
    await held
    const result = await sweep

    // Only a retention-policy change launches a replacement sweep, so an
    // unrelated toggle must not cut this one short.
    expect(result.docsTouched).toBe(2)
  })
})

describe("provenance protection", () => {
  it("does not cache a provenance scan when generation changes mid-read", async () => {
    let generation = 1
    let reads = 0
    const cache = new ProvenanceProtectionCache({
      readGeneration: () => generation,
      readIds: async () => {
        reads += 1
        if (reads === 1) {
          generation += 1
          return new Set(["stale"])
        }
        return new Set(["fresh"])
      },
    })

    const ids = await cache.get("swp")

    expect(reads).toBe(2)
    expect(ids.has("fresh")).toBe(true)
    expect(ids.has("stale")).toBe(false)
  })

  it("a full sweep never deletes a version some doc's provenance points at", async () => {
    // Same-ms tie where a checkpoint rewrite handed the OTHER snapshot the
    // newer mtime, so ordering alone would keep it and delete the version the
    // live doc points at. docs.meta.json marks the provenance version; the
    // sweep must protect it with no protectVersionId in hand.
    const dir = join(getVersionsDir(), "swp", "docs", "note")
    mkdirSync(dir, { recursive: true })
    const stamp = "2026-07-09T10-00-00-000Z"
    const current = `${stamp}-aaaaaa00` // provenance-pointed
    const rewritten = `${stamp}-zzzzzz00` // checkpoint-rewritten sibling
    writeFileSync(join(dir, `${current}.json`), "{}")
    writeFileSync(join(dir, `${rewritten}.json`), "{}")
    const now = Date.now()
    await utimes(
      join(dir, `${current}.json`),
      new Date(now - 5000),
      new Date(now - 5000)
    )
    await utimes(join(dir, `${rewritten}.json`), new Date(now), new Date(now))

    mkdirSync(join(workspaceDir, "spaces", "swp"), { recursive: true })
    writeFileSync(
      join(workspaceDir, "spaces", "swp", "docs.meta.json"),
      JSON.stringify({
        version: 1,
        docs: { note: { provenance: { versionId: current } } },
      })
    )

    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })
    await runRetentionSweep()

    const left = readdirSync(dir)
    expect(left).toContain(`${current}.json`)
  })
})

describe("lock key aliasing", () => {
  it("redundant separators lock the same key dir", async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const first = withVersionKeyLock("sp", "docs", "notes//draft", async () => {
      order.push("first-start")
      await gate
      order.push("first-end")
    })
    const second = withVersionKeyLock("sp", "docs", "notes/draft", async () => {
      order.push("second")
    })
    await whenVersionKeyLockDepthForTests("sp", "docs", "notes/draft", 2)
    release()
    await Promise.all([first, second])
    // The alias must have waited for the canonical key's lock.
    expect(order).toEqual(["first-start", "first-end", "second"])
  })
})

describe("round 5 hardening", () => {
  it("a nested .json-named doc directory is never a snapshot candidate", async () => {
    const parent = join(getVersionsDir(), "swn", "docs", "parent")
    const nested = join(parent, "child.json") // docPath "parent/child.json"
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(parent, "2026-01-01T00-00-00-000Z-aaaaaa00.json"), "{}")
    writeFileSync(join(parent, "2026-07-01T00-00-00-000Z-bbbbbb00.json"), "{}")
    writeFileSync(join(nested, "2026-06-01T00-00-00-000Z-cccccc00.json"), "{}")
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })
    await runRetentionSweep()
    const left = readdirSync(parent).sort()
    // The real newest snapshot survives; the directory was not "the newest".
    expect(left).toContain("2026-07-01T00-00-00-000Z-bbbbbb00.json")
    expect(left).toContain("child.json") // the nested doc's dir is untouched
    expect(left).not.toContain("2026-01-01T00-00-00-000Z-aaaaaa00.json")
    // The nested doc's own single snapshot is its protected newest.
    expect(readdirSync(nested)).toHaveLength(1)
  })

  it("a symlinked docs root is not walked", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wt-retention-outside2-"))
    try {
      writeFileSync(
        join(outside, "2026-01-01T00-00-00-000Z-aaaaaa00.json"),
        "{}"
      )
      writeFileSync(
        join(outside, "2026-07-01T00-00-00-000Z-bbbbbb00.json"),
        "{}"
      )
      const spaceDir = join(getVersionsDir(), "swl")
      mkdirSync(spaceDir, { recursive: true })
      symlinkSync(outside, join(spaceDir, "docs"), "dir")
      await updateServerSettings({
        history: { retention: { mode: "count", maxPerDoc: 1 } },
      })
      const result = await runRetentionSweep()
      expect(result.filesDeleted).toBe(0)
      expect(readdirSync(outside)).toHaveLength(2)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("a symlinked versions root is not walked", async () => {
    const externalVersions = join(appDir, "external-versions")
    const externalKeyDir = join(externalVersions, "swv", "docs", "note")
    mkdirSync(externalKeyDir, { recursive: true })
    writeFileSync(
      join(externalKeyDir, "2026-01-01T00-00-00-000Z-aaaaaa00.json"),
      "{}"
    )
    writeFileSync(
      join(externalKeyDir, "2026-07-01T00-00-00-000Z-bbbbbb00.json"),
      "{}"
    )
    rmSync(getVersionsDir(), { recursive: true, force: true })
    symlinkSync(externalVersions, getVersionsDir(), "dir")

    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })
    const result = await runRetentionSweep()

    expect(result.filesDeleted).toBe(0)
    expect(readdirSync(externalKeyDir)).toHaveLength(2)
  })

  it("post-write prune skips a symlinked versions root", async () => {
    const externalVersions = join(appDir, "external-versions-write")
    const externalKeyDir = join(externalVersions, "swx", "docs", "note")
    mkdirSync(externalKeyDir, { recursive: true })
    writeFileSync(
      join(externalKeyDir, "2026-01-01T00-00-00-000Z-aaaaaa00.json"),
      "{}"
    )
    writeFileSync(
      join(externalKeyDir, "2026-07-01T00-00-00-000Z-bbbbbb00.json"),
      "{}"
    )
    rmSync(getVersionsDir(), { recursive: true, force: true })
    symlinkSync(externalVersions, getVersionsDir(), "dir")
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })

    await pruneDocKeyForCount("swx", "note")

    expect(readdirSync(externalKeyDir)).toHaveLength(2)
  })

  it("a queued post-write prune re-reads the policy under the lock", async () => {
    const dir = join(getVersionsDir(), "swq", "docs", "note")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z-aaaaaa00.json"), "{}")
    writeFileSync(join(dir, "2026-07-01T00-00-00-000Z-bbbbbb00.json"), "{}")
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const held = withVersionKeyLock("swq", "docs", "note", () => gate)
    const prune = pruneDocKeyForCount("swq", "note") // queues behind the lock
    await whenVersionKeyLockDepthForTests("swq", "docs", "note", 2)
    await updateServerSettings({ history: { retention: { mode: "all" } } })
    release()
    await held
    await prune
    // The relaxed policy won: nothing was deleted by the stale queued prune.
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it("a sweep queued behind a lock sees provenance recorded while it waited", async () => {
    const dir = join(getVersionsDir(), "swr", "docs", "note")
    mkdirSync(dir, { recursive: true })
    const stamp = "2026-07-09T10-00-00-000Z"
    const current = `${stamp}-aaaaaa00`
    const rewritten = `${stamp}-zzzzzz00`
    writeFileSync(join(dir, `${current}.json`), "{}")
    writeFileSync(join(dir, `${rewritten}.json`), "{}")
    const now = Date.now()
    await utimes(
      join(dir, `${current}.json`),
      new Date(now - 5000),
      new Date(now - 5000)
    )
    await utimes(join(dir, `${rewritten}.json`), new Date(now), new Date(now))
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const held = withVersionKeyLock("swr", "docs", "note", () => gate)
    const sweep = runRetentionSweep() // queues behind the lock for this doc
    await whenVersionKeyLockDepthForTests("swr", "docs", "note", 2)
    // Provenance lands while the sweep waits — as if a write just finished.
    mkdirSync(join(workspaceDir, "spaces", "swr"), { recursive: true })
    writeFileSync(
      join(workspaceDir, "spaces", "swr", "docs.meta.json"),
      JSON.stringify({
        version: 1,
        docs: { note: { provenance: { versionId: current } } },
      })
    )
    release()
    await held
    await sweep
    // The under-lock provenance read protected the newly-pointed version.
    expect(readdirSync(dir)).toContain(`${current}.json`)
  })

  it("a raced-away version key dir does not abort a queued sweep", async () => {
    const dir = join(getVersionsDir(), "swv", "docs", "gone")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "2026-07-09T10-00-00-000Z-a.json"), "{}")
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const held = withVersionKeyLock("swv", "docs", "gone", () => gate)
    const sweep = runRetentionSweep() // queues behind the lock for this doc
    await whenVersionKeyLockDepthForTests("swv", "docs", "gone", 2)

    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, "moved while sweep waited")
    release()
    await held
    await expect(sweep).resolves.toMatchObject({
      filesDeleted: 0,
      docsTouched: 0,
    })
  })

  it("a sweep queued behind the real write path keeps the new provenance version", async () => {
    const spaceId = "sww"
    await writeTestSpace(spaceId)
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })

    await writeDoc(spaceId, "note", "first", {
      updatedBy: "agent",
      source: "agent",
    })

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const held = withVersionKeyLock(spaceId, "docs", "note", () => gate)
    const write = writeDoc(spaceId, "note", "second", {
      updatedBy: "human",
      source: "manual",
    })
    await whenVersionKeyLockDepthForTests(spaceId, "docs", "note", 2)
    const sweep = runRetentionSweep() // queues behind the same doc lock
    await whenVersionKeyLockDepthForTests(spaceId, "docs", "note", 3)

    release()
    await held
    await write
    await sweep

    const provenance = await getDocProvenance(spaceId, "note")
    expect(provenance?.versionId).toBeDefined()
    const snapshot = await getDocVersion(spaceId, "note", provenance!.versionId)
    expect(snapshot).not.toBeNull()
  })
})
