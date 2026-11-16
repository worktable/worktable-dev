import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { PersonalSetup } from "@worktable/types/setup"
import { recordActivity, setActivityObserver } from "./activity-log.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { trustedLocalIdentity } from "./auth.ts"
import {
  completeSetupItem,
  observeActivityForSetup,
  OWNER_SETUP_KEY,
} from "./personal-setup.ts"
import { parsePersonalSetup } from "./personal-setup-shape.ts"
import { createHtmlDocument } from "./html-document-create.ts"
import { profileRouter } from "./routes/profile.ts"
import { writeSpace } from "./store.ts"
import { wsManager } from "./ws.ts"
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

it("completes the owner's first task from their agent's work in their own Space", async () => {
  expect(await setup()).toEqual({ items: {} })
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "welcome",
    name: "Getting Started",
    createdAt: now,
    updatedAt: now,
    createdBy: "worktable",
    settings: { gettingStarted: true },
  })

  // Neither the owner's own doc nor an agent's edit to a guide counts.
  recordActivity({
    spaceId: "welcome",
    action: "doc.edited",
    actor: { kind: "agent", id: "local-token:codex" },
    target: { kind: "doc", path: "prompts-to-try" },
  })
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

  // Someone joining later completes the skipped step for real.
  await completeSetupItem(OWNER_SETUP_KEY, "invite-team")
  expect((await setup()).items["invite-team"]?.skipped).toBeUndefined()
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

function help(body: Record<string, unknown>) {
  return app().fetch(
    new Request("http://localhost/api/profile/help", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

it("remembers each tip a person met, and finishes help from what happens", async () => {
  // A tip shown twice, then closed, keeps its count; a rewrite starts over.
  // Only the window it was in needs to know, and it gets the result back.
  const notices = spyOn(wsManager, "sendToPeople")
  expect((await help({ id: "records-meet", event: "shown", version: 1 })).status).toBe(200)
  expect((await help({ id: "records-meet", event: "shown", version: 1 })).status).toBe(200)
  expect((await help({ id: "records-meet", event: "closed" })).status).toBe(200)
  let current = await setup()
  expect(current.help?.["records-meet"]).toMatchObject({ shown: 2, version: 1 })
  expect(current.help?.["records-meet"]?.closedAt).toBeDefined()
  await help({ id: "records-meet", event: "shown", version: 2 })
  expect((await setup()).help?.["records-meet"]).toMatchObject({ shown: 1, version: 2 })
  expect(notices).not.toHaveBeenCalled()

  // Only the rules line is the browser's to report; ids are slugs.
  expect((await help({ evidence: "rules-added" })).status).toBe(200)
  // What happened changes Next Steps, so every window hears it.
  expect(notices).toHaveBeenCalledTimes(1)
  notices.mockRestore()
  expect((await help({ evidence: "link-made" })).status).toBe(400)
  expect((await help({ id: "Not A Slug", event: "shown" })).status).toBe(400)
  expect((await help({ id: "records-meet" })).status).toBe(400)

  // The person keeping a Doc and an agent making a page finish their help.
  recordActivity({
    spaceId: "atlas",
    action: "doc.kept",
    actor: { kind: "person", id: "local:owner" },
    target: { kind: "doc", path: "brief" },
  })
  recordActivity({
    spaceId: "atlas",
    action: "doc.created",
    actor: { kind: "agent", id: "local-token:codex" },
    target: { kind: "doc", path: "plan", formatId: "worktable.html" },
  })
  current = await eventually(
    (value) =>
      Boolean(value.helpEvidence?.["temporary-kept"]) &&
      Boolean(value.helpEvidence?.["html-doc-made"])
  )
  expect(current.helpEvidence?.["html-doc-made"]).toMatchObject({ path: "plan" })
  expect(current.helpEvidence?.["rules-added"]).toBeDefined()

  // Show Tips Again forgets what was seen, not what happened.
  expect((await help({ resetAll: true })).status).toBe(200)
  current = await setup()
  expect(current.help).toBeUndefined()
  expect(current.helpEvidence?.["temporary-kept"]).toBeDefined()
})

it("drops help entries it can't read instead of losing the setup", () => {
  const at = "2026-11-01T00:00:00.000Z"
  expect(
    parsePersonalSetup({
      items: {},
      help: { "records-meet": { shown: 1 }, "Bad Id": { shown: 1 }, x: { shown: "no" } },
      helpEvidence: { "link-made": { at }, "made-up": { at } },
    })
  ).toEqual({
    items: {},
    help: { "records-meet": { shown: 1 } },
    helpEvidence: { "link-made": { at } },
  })
})

it("finishes HTML help from events that don't name the Doc's format", async () => {
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "atlas",
    name: "Atlas",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
  const created = await createHtmlDocument({
    spaceId: "atlas",
    explicitId: "pricing",
    name: "Pricing",
    metadata: {},
    permissions: { network: false, records: {}, state: { read: true, write: true } },
    html: "<h1>Pricing</h1>",
    createdBy: "test",
    versionSource: "rest-api",
    versionUpdatedBy: "user",
  })
  expect(created.error).toBeUndefined()
  // Producers name only the path, as document and comment activity do.
  recordActivity({
    spaceId: "atlas",
    action: "doc.created",
    actor: { kind: "agent", id: "local-token:codex" },
    target: { kind: "doc", path: "pricing" },
  })
  recordActivity({
    spaceId: "atlas",
    action: "comment.created",
    actor: { kind: "person", id: "local:owner" },
    target: { kind: "doc", path: "pricing" },
  })
  const current = await eventually(
    (value) =>
      Boolean(value.helpEvidence?.["html-doc-made"]) &&
      Boolean(value.helpEvidence?.["html-commented"])
  )
  expect(current.helpEvidence?.["html-doc-made"]).toMatchObject({ path: "pricing" })
})

it("keeps a tip that comes back showing until it's closed again", async () => {
  await help({ id: "temporary-doc", event: "shown", version: 2 })
  await help({ id: "temporary-doc", event: "closed" })
  // A later session shows it once more: that showing is open, not closed.
  await help({ id: "temporary-doc", event: "shown", version: 2 })
  let state = (await setup()).help?.["temporary-doc"]
  expect(state).toMatchObject({ shown: 2, version: 2 })
  expect(state?.closedAt).toBeUndefined()
  await help({ id: "temporary-doc", event: "closed" })
  state = (await setup()).help?.["temporary-doc"]
  expect(state?.closedAt).toBeDefined()
})
