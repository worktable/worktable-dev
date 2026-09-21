import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  claimThreadDelivery,
  failThreadDelivery,
  getThreadActivity,
  queueThreadDelivery,
  reconcileThreadDeliveries,
} from "./thread-delivery-store.ts"
import { notifyWorkspaceChangeAndWaitOrThrow } from "./workspace-events.ts"
import { setWorkspaceRootOverride, workspaceCacheKey } from "./workspace.ts"

let appDir: string
let workspaceDir: string
let deliveryFile: string

beforeEach(async () => {
  appDir = await mkdtemp(join(tmpdir(), "worktable-delivery-v2-app-"))
  workspaceDir = await mkdtemp(join(tmpdir(), "worktable-delivery-v2-work-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
  const directory = join(appDir, "thread-deliveries")
  await mkdir(directory, { recursive: true })
  deliveryFile = join(directory, `${workspaceCacheKey()}.json`)
})

afterEach(async () => {
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await Promise.all([
    rm(appDir, { recursive: true, force: true }),
    rm(workspaceDir, { recursive: true, force: true }),
  ])
})

describe("thread delivery state versions", () => {
  it("loads a V1 Space record and rewrites it with locations and identities on mutation", async () => {
    const now = new Date().toISOString()
    await writeFile(
      deliveryFile,
      `${JSON.stringify({
        type: "worktable.thread-deliveries",
        version: 1,
        deliveries: [
          {
            messageId: "msg_legacydelivery",
            threadId: "thr_legacydelivery",
            spaceId: "legacy-space",
            authorId: "ptc_legacy_author",
            participantId: "ptc_legacy_agent",
            state: "queued",
            revision: 0,
            attempts: 0,
            createdAt: now,
            updatedAt: now,
          },
        ],
      })}\n`,
      "utf8"
    )

    expect(
      await getThreadActivity(
        { kind: "space", spaceId: "legacy-space" },
        "thr_legacydelivery",
        "msg_legacydelivery"
      )
    ).toMatchObject({ state: "queued" })

    await queueThreadDelivery({
      location: { kind: "worktable" },
      threadId: "thr_rootdelivery",
      messageId: "msg_rootdelivery",
      authorId: "ptc_root_author",
      participantId: "ptc_root_agent",
      threadRevision: 1,
    })

    const migrated = JSON.parse(await readFile(deliveryFile, "utf8")) as {
      version: number
      deliveries: Array<{
        location?: unknown
        spaceId?: unknown
      }>
    }
    expect(migrated.version).toBe(4)
    expect(migrated.deliveries).toHaveLength(2)
    expect(migrated.deliveries[0]).toMatchObject({
      location: { kind: "space", spaceId: "legacy-space" },
    })
    expect(migrated.deliveries[0]).not.toHaveProperty("spaceId")
    expect(migrated.deliveries[1]).toMatchObject({
      location: { kind: "worktable" },
    })
  })

  it("does not let an older scan revive a retired assignment", async () => {
    const location = { kind: "worktable" } as const
    const delivery = {
      location,
      threadId: "thr_ordered_delivery",
      messageId: "msg_ordered_delivery",
      authorId: "ptc_author",
      participantId: "ptc_agent",
      identityId: "idt_agent",
      replied: false,
      createdAt: new Date().toISOString(),
    }

    await reconcileThreadDeliveries(
      "ptc_agent",
      [{ ...delivery, threadRevision: 1 }],
      {
        threads: [{ location, threadId: delivery.threadId, revision: 1 }],
      }
    )
    await reconcileThreadDeliveries("ptc_agent", [], {
      threads: [{ location, threadId: delivery.threadId, revision: 2 }],
    })
    await reconcileThreadDeliveries(
      "ptc_agent",
      [{ ...delivery, threadRevision: 1 }],
      {
        threads: [{ location, threadId: delivery.threadId, revision: 1 }],
      }
    )

    expect(
      await getThreadActivity(
        location,
        delivery.threadId,
        delivery.messageId,
        delivery.identityId
      )
    ).toMatchObject({
      state: "failed",
      error: { code: "DELIVERY_RETIRED" },
    })

    await reconcileThreadDeliveries(
      "ptc_agent",
      [{ ...delivery, threadRevision: 3 }],
      {
        threads: [{ location, threadId: delivery.threadId, revision: 3 }],
      }
    )
    expect(
      await getThreadActivity(
        location,
        delivery.threadId,
        delivery.messageId,
        delivery.identityId
      )
    ).toMatchObject({ state: "queued" })

    const claim = await claimThreadDelivery("ptc_agent")
    expect(claim).not.toBeNull()
    await failThreadDelivery({
      messageId: delivery.messageId,
      leaseId: claim!.leaseId,
      participantId: delivery.participantId,
      canonicalThreadRevision: 4,
      retryable: false,
      code: "DELIVERY_RETIRED",
      message: "The assignment changed while the delivery was claimed.",
    })
    await reconcileThreadDeliveries(
      "ptc_agent",
      [{ ...delivery, threadRevision: 3 }],
      {
        threads: [{ location, threadId: delivery.threadId, revision: 3 }],
      }
    )
    expect(
      await getThreadActivity(
        location,
        delivery.threadId,
        delivery.messageId,
        delivery.identityId
      )
    ).toMatchObject({
      state: "failed",
      error: { code: "DELIVERY_RETIRED" },
    })

    await reconcileThreadDeliveries(
      "ptc_agent",
      [{ ...delivery, threadRevision: 5 }],
      {
        threads: [{ location, threadId: delivery.threadId, revision: 5 }],
      }
    )
    expect(
      await getThreadActivity(
        location,
        delivery.threadId,
        delivery.messageId,
        delivery.identityId
      )
    ).toMatchObject({ state: "queued" })
  })

  it("schedules separate conversation identities independently", async () => {
    const location = { kind: "worktable" } as const
    for (const [index, identityId] of [
      "idt_researcher001",
      "idt_reviewer00001",
    ].entries()) {
      await queueThreadDelivery({
        location,
        threadId: "thr_concurrent_identity",
        messageId: `msg_concurrent000${index}`,
        authorId: "ptc_author",
        participantId: "ptc_agent",
        identityId,
        threadRevision: index + 1,
      })
    }

    const first = await claimThreadDelivery("ptc_agent")
    const second = await claimThreadDelivery("ptc_agent")
    expect([first?.identityId, second?.identityId]).toEqual([
      "idt_researcher001",
      "idt_reviewer00001",
    ])
  })

  it("accepts restored revisions after a workspace reset", async () => {
    const location = { kind: "worktable" } as const
    const delivery = {
      location,
      threadId: "thr_restored_delivery",
      messageId: "msg_restored_delivery",
      authorId: "ptc_author",
      participantId: "ptc_agent",
      identityId: "idt_agent",
      replied: false,
      createdAt: new Date().toISOString(),
    }
    await reconcileThreadDeliveries(
      "ptc_agent",
      [{ ...delivery, threadRevision: 8 }],
      {
        threads: [{ location, threadId: delivery.threadId, revision: 8 }],
      }
    )

    await notifyWorkspaceChangeAndWaitOrThrow({ type: "workspaceReset" })
    await reconcileThreadDeliveries(
      "ptc_agent",
      [{ ...delivery, threadRevision: 1 }],
      {
        threads: [{ location, threadId: delivery.threadId, revision: 1 }],
      }
    )

    expect(
      await getThreadActivity(
        location,
        delivery.threadId,
        delivery.messageId,
        delivery.identityId
      )
    ).toMatchObject({ state: "queued" })
  })
})
