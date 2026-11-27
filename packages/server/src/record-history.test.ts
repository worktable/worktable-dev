import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { RecordChange } from "@worktable/types"
import { Hono } from "hono"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drainActivity, runAsActivityActor } from "./activity-log.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { ownerIdentity } from "./auth.ts"
import { pruneRecordHistories, recordHistoryPath } from "./record-history.ts"
import {
  batchRecordActivity,
  createRecord,
  readRecordChanges,
  updateRecord,
} from "./record-store.ts"
import { recordsRouter } from "./routes/records.ts"
import { spacesRouter } from "./routes/spaces.ts"
import type { RequestPrincipal } from "./token-store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

const DAY_MS = 24 * 60 * 60 * 1000

const agent: RequestPrincipal = {
  id: "local-token:codex",
  type: "agent",
  displayName: "Codex",
  authorizedBy: "local:owner",
}

let root = ""
let appDir = ""

/** The app as a signed-in person uses it. */
function app(): Hono {
  const server = new Hono()
  server.use("*", async (c, next) => {
    c.set("identity", ownerIdentity())
    return next()
  })
  server.use("*", (c, next) =>
    runAsActivityActor(c.get("identity").principal, next)
  )
  server.route("/api/spaces", spacesRouter)
  server.route("/api/spaces/:spaceId/records", recordsRouter)
  return server
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: T }> {
  const response = await app().fetch(
    new Request(`http://localhost${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }),
    })
  )
  return { status: response.status, json: (await response.json()) as T }
}

const queue = "/api/spaces/outreach/records/queue"

async function history(recordId: string): Promise<RecordChange[]> {
  const { json } = await request<{ changes: RecordChange[] }>(
    "GET",
    `${queue}/${recordId}/history`
  )
  return json.changes
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-record-history-"))
  appDir = await mkdtemp(join(tmpdir(), "worktable-record-history-app-"))
  setWorkspaceRootOverride(root)
  setAppDirOverride(appDir)
  ensureWorkspaceManifest()
  await request("POST", "/api/spaces", { name: "Outreach" })
  await request("POST", "/api/spaces/outreach/records", {
    id: "queue",
    name: "Queue",
    fields: {
      title: { type: "string" },
      status: { type: "string" },
      final_text: { type: "text" },
    },
  })
})

afterEach(async () => {
  await drainActivity()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ])
})

describe("record history", () => {
  it("keeps who changed what and what it replaced", async () => {
    // An agent drafts a reply.
    await runAsActivityActor(agent, () =>
      createRecord("outreach", "queue", {
        id: "reply-1",
        data: { title: "Reply to a thread", status: "pending" },
        createdBy: agent.id,
      })
    )
    // The person approves it on a page, with their own wording.
    await runAsActivityActor(ownerIdentity().principal, () =>
      updateRecord("outreach", "queue", "reply-1", {
        data: { status: "approved", final_text: "Written by hand" },
        updatedBy: "widget:board",
      })
    )
    // The agent writes over both, then saves the same values again.
    for (let pass = 0; pass < 2; pass += 1) {
      await runAsActivityActor(agent, () =>
        updateRecord("outreach", "queue", "reply-1", {
          data: { status: "pending", final_text: "Polished" },
          updatedBy: agent.id,
        })
      )
    }
    // The person archives it, saying why, and brings it back.
    await request("POST", `${queue}/reply-1/archive`, { reason: "Duplicate" })
    await request("POST", `${queue}/reply-1/restore`)

    const changes = await history("reply-1")
    expect(
      changes.map((change) => ({
        kind: change.kind,
        by: change.by.kind,
        ...(change.page ? { page: change.page } : {}),
        ...(change.reason ? { reason: change.reason } : {}),
        ...(change.fields ? { fields: change.fields } : {}),
      }))
    ).toEqual([
      { kind: "restored", by: "person" },
      { kind: "archived", by: "person", reason: "Duplicate" },
      {
        kind: "changed",
        by: "agent",
        fields: {
          status: { before: "approved", after: "pending" },
          final_text: { before: "Written by hand", after: "Polished" },
        },
      },
      {
        kind: "changed",
        by: "person",
        page: "board",
        // The title did not change; the text had no value before.
        fields: {
          status: { before: "pending", after: "approved" },
          final_text: { after: "Written by hand" },
        },
      },
      { kind: "added", by: "agent" },
    ])
    expect(changes[2]?.by).toMatchObject({ id: agent.id, name: "Codex" })

    // History is the record's: no record, no history, and a deleted record
    // takes its history with it.
    expect(
      (await request("GET", `${queue}/no-such-record/history`)).status
    ).toBe(404)
    const path = recordHistoryPath("outreach", "queue", "reply-1")!
    expect(existsSync(path)).toBe(true)
    await request("DELETE", `${queue}/reply-1`)
    expect(existsSync(path)).toBe(false)
  })

  it("marks the records one call changed, and holds history to the retention policy", async () => {
    const asAgent = <T>(work: () => Promise<T>) =>
      runAsActivityActor(agent, work)
    await asAgent(() =>
      batchRecordActivity(async () => {
        for (const id of ["a", "b"]) {
          await createRecord("outreach", "queue", {
            id,
            data: { title: id, status: "pending" },
            createdBy: agent.id,
          })
        }
      })
    )
    const read = async (id: string) =>
      (await readRecordChanges("outreach", "queue", id)).data ?? []
    const [a, b] = [await read("a"), await read("b")]
    expect(a[0]?.call).toBeTruthy()
    expect(b[0]?.call).toBe(a[0]?.call)

    for (const status of ["approved", "posted", "seen"]) {
      await asAgent(() =>
        updateRecord("outreach", "queue", "a", {
          data: { status },
          updatedBy: agent.id,
        })
      )
    }
    // A change made alone names no call.
    expect((await read("a"))[0]?.call).toBeUndefined()

    // Keeping the newest two per item.
    await pruneRecordHistories({ mode: "count", maxPerDoc: 2 })
    expect((await read("a")).map((change) => change.fields?.status?.after)).toEqual(
      ["seen", "posted"]
    )

    // Past the window, a record keeps how it came to be as it is, and what a
    // record that is gone left behind goes.
    await rm(join(root, "spaces", "outreach", "records", "queue", "b.yaml"))
    const later = Date.now() + 40 * DAY_MS
    const pruned = await pruneRecordHistories(
      { mode: "age", maxAgeDays: 30 },
      () => true,
      later
    )
    expect(pruned.changesRemoved).toBe(2)
    expect((await read("a")).map((change) => change.fields?.status?.after)).toEqual(
      ["seen"]
    )
    expect(existsSync(recordHistoryPath("outreach", "queue", "b")!)).toBe(false)
    // Nothing more to remove: a second pass changes nothing.
    expect(
      (await pruneRecordHistories({ mode: "age", maxAgeDays: 30 }, () => true, later))
        .changesRemoved
    ).toBe(0)
    // Keeping everything walks nothing.
    expect((await pruneRecordHistories({ mode: "all" })).changesRemoved).toBe(0)
  })
})
