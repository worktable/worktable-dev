import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  createDocumentShare,
  createDocumentShareIfEligible,
  getDocumentShare,
  invalidateDocumentShares,
  invalidateDocumentSharesWithinLifecycle,
  resolveDocumentShare,
  stopDocumentShare,
  withDocumentShareLifecycle,
  withResolvedDocumentShare,
} from "./share-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import { notifyWorkspaceChangeAndWaitOrThrow } from "./workspace-events.ts"

let appDir: string
let workspaceDir: string

const doc = {
  kind: "doc" as const,
  spaceId: "spc_abcdefghijkl",
  artifactKey: "notes/launch-plan",
}

beforeEach(async () => {
  appDir = await mkdtemp(join(tmpdir(), "worktable-document-shares-app-"))
  workspaceDir = await mkdtemp(
    join(tmpdir(), "worktable-document-shares-workspace-")
  )
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
})

afterEach(async () => {
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await Promise.all([
    rm(appDir, { recursive: true, force: true }),
    rm(workspaceDir, { recursive: true, force: true }),
  ])
})

describe("document share store", () => {
  it("creates one owner-private capability and resolves only the exact token", async () => {
    const first = await createDocumentShare(doc)
    const second = await createDocumentShare(doc)

    expect(first).toEqual(second)
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await getDocumentShare(doc)).toEqual(first)
    expect(await resolveDocumentShare(first.token)).toEqual(first)
    const wrongToken = `${first.token.slice(0, -1)}${first.token.endsWith("A") ? "B" : "A"}`
    expect(await resolveDocumentShare(wrongToken)).toBeNull()
    expect(await resolveDocumentShare("short")).toBeNull()

    const path = join(appDir, "document-shares.json")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, "utf8")).toContain(first.token)
  })

  it("stopping then sharing again never revives the old URL", async () => {
    const first = await createDocumentShare(doc)
    expect(await stopDocumentShare(doc)).toBe(true)
    expect(await stopDocumentShare(doc)).toBe(false)
    expect(await resolveDocumentShare(first.token)).toBeNull()

    const second = await createDocumentShare(doc)
    expect(second.token).not.toBe(first.token)
    expect(await resolveDocumentShare(first.token)).toBeNull()
    expect(await resolveDocumentShare(second.token)).toEqual(second)
  })

  it("keeps document paths and HTML identities separate", async () => {
    const html = {
      kind: "html" as const,
      spaceId: doc.spaceId,
      artifactKey: doc.artifactKey,
    }
    const [docShare, htmlShare] = await Promise.all([
      createDocumentShare(doc),
      createDocumentShare(html),
    ])

    expect(docShare.token).not.toBe(htmlShare.token)
    expect(await getDocumentShare(doc)).toEqual(docShare)
    expect(await getDocumentShare(html)).toEqual(htmlShare)
  })

  it("orders eligibility checks with concurrent lifecycle invalidation", async () => {
    let eligibilityChecked!: () => void
    let releaseEligibility!: () => void
    const checked = new Promise<void>((resolve) => {
      eligibilityChecked = resolve
    })
    const eligibilityGate = new Promise<void>((resolve) => {
      releaseEligibility = resolve
    })

    const creating = createDocumentShareIfEligible(doc, async () => {
      eligibilityChecked()
      await eligibilityGate
      return true
    })
    await checked
    const invalidating = invalidateDocumentShares([doc])
    releaseEligibility()

    const share = await creating
    expect(share).not.toBeNull()
    expect(await invalidating).toBe(1)
    expect(await resolveDocumentShare(share!.token)).toBeNull()
  })

  it("keeps capability use on one side of concurrent revocation", async () => {
    const share = await createDocumentShare(doc)
    const order: string[] = []
    let readStarted!: () => void
    let finishRead!: () => void
    const started = new Promise<void>((resolve) => {
      readStarted = resolve
    })
    const readGate = new Promise<void>((resolve) => {
      finishRead = resolve
    })

    let reading: Promise<string | null> | undefined
    let revoking: Promise<number> | undefined
    try {
      reading = withResolvedDocumentShare(share.token, async (resolved) => {
        order.push("use-started")
        readStarted()
        await readGate
        order.push("use-finished")
        return resolved.artifactKey
      })
      await started
      revoking = withDocumentShareLifecycle(async () => {
        order.push("revocation-started")
        return invalidateDocumentSharesWithinLifecycle([doc])
      })

      finishRead()
      expect(await reading).toBe(doc.artifactKey)
      expect(await revoking).toBe(1)
      expect(order).toEqual([
        "use-started",
        "use-finished",
        "revocation-started",
      ])
      expect(await resolveDocumentShare(share.token)).toBeNull()
    } finally {
      finishRead()
      const pending: Promise<unknown>[] = []
      if (reading) pending.push(reading)
      if (revoking) pending.push(revoking)
      await Promise.allSettled(pending)
    }
  })

  it("invalidates every link across workspace replacement", async () => {
    const share = await createDocumentShare(doc)
    await notifyWorkspaceChangeAndWaitOrThrow({ type: "workspaceReset" })

    expect(await getDocumentShare(doc)).toBeNull()
    expect(await resolveDocumentShare(share.token)).toBeNull()
    expect(
      JSON.parse(await readFile(join(appDir, "document-shares.json"), "utf8"))
        .shares
    ).toEqual([])
  })

  it("fails closed when private registry state is malformed", async () => {
    await writeFile(join(appDir, "document-shares.json"), "{}\n", "utf8")
    await expect(resolveDocumentShare("A".repeat(43))).rejects.toThrow(
      "Invalid document share state"
    )
    await expect(createDocumentShare(doc)).rejects.toThrow(
      "Invalid document share state"
    )
  })
})
