import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { PersonalSetup } from "@worktable/types/setup"
import { recordActivity, setActivityObserver } from "./activity-log.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { trustedLocalIdentity } from "./auth.ts"
import { observeActivityForSetup } from "./personal-setup.ts"
import { parsePersonalSetup } from "./personal-setup-shape.ts"
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
    // test-policy: external-readiness-backoff (setup progress saves off the write path)
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

it("completes the owner's first task from their agent's work, not their own", async () => {
  expect(await setup()).toEqual({ items: {} })

  recordActivity({
    spaceId: "atlas",
    action: "doc.created",
    actor: { kind: "person", id: "local:owner" },
    target: { kind: "doc", path: "notes" },
  })
  recordActivity({
    spaceId: "atlas",
    action: "doc.created",
    actor: { kind: "agent", id: "local-token:codex" },
    target: { kind: "doc", path: "atlas-brief" },
  })

  const progressed = await eventually((current) =>
    Boolean(current.items["first-task"])
  )
  expect(progressed.items["first-task"]).toMatchObject({
    spaceId: "atlas",
    path: "atlas-brief",
  })

  // Unpinning Getting Started keeps what was done.
  expect((await choose({ hidden: true })).status).toBe(200)
  const hidden = await setup()
  expect(hidden.hidden).toBe(true)
  expect(hidden.items["first-task"]).toBeDefined()

  // Progress is the server's to record, except skipping an invite and
  // copying the instructions, which only the person's browser sees.
  expect((await choose({ items: {} })).status).toBe(400)
  expect((await choose({ done: "first-task" })).status).toBe(400)
  expect((await choose({ skip: "connect-agent" })).status).toBe(400)
  expect((await choose({ skip: "invite-team" })).status).toBe(200)
  expect((await choose({ done: "agent-instructions" })).status).toBe(200)
  const chosen = await setup()
  expect(chosen.items["invite-team"]).toMatchObject({ skipped: true })
  expect(chosen.items["agent-instructions"]).toBeDefined()
  expect(chosen.items["first-task"]).toMatchObject({ path: "atlas-brief" })
})

it("keeps stored progress when an earlier version listed other items", () => {
  const at = "2026-10-01T00:00:00.000Z"
  expect(
    parsePersonalSetup({
      audience: "team",
      items: { "connect-agent": { at }, "ask-review": { at } },
      watch: { since: at },
    })
  ).toEqual({ items: { "connect-agent": { at } } })
})
