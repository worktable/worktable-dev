import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { PersonalSetup } from "@worktable/types/setup"
import { recordActivity, setActivityObserver } from "./activity-log.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { trustedLocalIdentity } from "./auth.ts"
import {
  noteSpaceCreatedForSetup,
  observeActivityForSetup,
} from "./personal-setup.ts"
import { profileRouter } from "./routes/profile.ts"
import { workspaceRouter } from "./routes/workspace.ts"
import {
  prepareWorkspaceTarget,
  setWorkspaceRootOverride,
} from "./workspace.ts"

let root: string

function app(): Hono {
  const next = new Hono()
  next.use("/api/*", trustedLocalIdentity())
  next.route("/api/workspace", workspaceRouter)
  next.route("/api/profile", profileRouter)
  return next
}

async function setup(): Promise<PersonalSetup> {
  const response = await app().fetch(new Request("http://localhost/api/workspace"))
  return ((await response.json()) as { setup: PersonalSetup }).setup
}

/** Progress is saved off the write path; wait for it to land. */
async function eventually(check: (setup: PersonalSetup) => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = await setup()
    if (check(current)) return current
    await Bun.sleep(5)
  }
  return setup()
}

function choose(body: Record<string, unknown>) {
  return app().fetch(
    new Request("http://localhost/api/profile/setup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-setup-"))
  setAppDirOverride(join(root, "app"))
  setWorkspaceRootOverride(join(root, "workspace"))
  prepareWorkspaceTarget(join(root, "workspace"), "create")
  setActivityObserver(observeActivityForSetup)
})

afterEach(async () => {
  setActivityObserver(null)
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

it("completes the owner's steps from their agent's work, and shows setup what it made while it waits", async () => {
  expect(await setup()).toEqual({ items: {} })
  const started = await choose({ audience: "solo", watch: "start" })
  expect(started.status).toBe(200)
  expect((await setup()).audience).toBe("solo")

  // The person's own doc is not an agent's first task.
  recordActivity({
    spaceId: "atlas",
    action: "doc.created",
    actor: { kind: "person", id: "local:owner" },
    target: { kind: "doc", path: "notes" },
  })
  noteSpaceCreatedForSetup("atlas", true)
  recordActivity({
    spaceId: "atlas",
    action: "doc.created",
    actor: { kind: "agent", id: "local-token:codex" },
    target: { kind: "doc", path: "atlas-brief" },
  })
  recordActivity({
    spaceId: "atlas",
    action: "comment.created",
    actor: { kind: "agent", id: "local-token:codex" },
    target: { kind: "doc", path: "atlas-brief" },
  })

  const progressed = await eventually(
    (current) =>
      Boolean(
        current.items["first-task"] &&
          current.items["ask-review"] &&
          current.watch?.space &&
          current.watch.doc
      )
  )
  expect(progressed.items["first-task"]).toMatchObject({
    spaceId: "atlas",
    path: "atlas-brief",
  })
  expect(progressed.watch).toMatchObject({
    space: { spaceId: "atlas" },
    doc: { spaceId: "atlas", path: "atlas-brief" },
  })

  // Finishing setup stops watching; what was done stays done.
  expect((await choose({ watch: "stop", hidden: true })).status).toBe(200)
  const finished = await setup()
  expect(finished.watch).toBeUndefined()
  expect(finished.hidden).toBe(true)
  expect(finished.items["first-task"]).toBeDefined()

  expect((await choose({ items: {} })).status).toBe(400)
})
