import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  DEFAULT_AGENT_TOKEN_SCOPES,
  defaultConversationIdentityId,
  type ActivityActor,
  type ActivityPage,
  type HomeFeed,
  type PendingResult,
  type SpaceFile,
} from "@worktable/types"
import { Hono } from "hono"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  drainActivity,
  peekDocActivity,
  recordActivity,
  runAsActivityActor,
} from "./activity-log.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { pathMovesFor } from "./doc-aliases.ts"
import { ownerIdentity } from "./auth.ts"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { resolveParticipant } from "./participant-store.ts"
import { activityRouter, pendingRouter } from "./routes/activity.ts"
import { annotationsRouter } from "./routes/annotations.ts"
import { homeRouter } from "./routes/home.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { setSpaceArchived, writeSpace } from "./store.ts"
import { postThreadMessage } from "./thread-service.ts"
import type { TokenIdentity } from "./token-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

const codex: TokenIdentity = {
  user: "owner",
  workspace: "test",
  scopes: ["*"],
  agent: "codex",
  principal: {
    id: "local-token:codex",
    type: "agent",
    displayName: "Codex",
    authorizedBy: "local:owner",
  },
}

let root = ""
let appDir = ""
let client: Client | null = null

function space(id: string, name: string): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

/** The production boundary: identity first, then attribution for the request. */
function app(identity: TokenIdentity = ownerIdentity()): Hono {
  const server = new Hono()
  server.use("*", async (c, next) => {
    c.set("identity", identity)
    return next()
  })
  server.use("*", (c, next) =>
    runAsActivityActor(c.get("identity").principal, next)
  )
  server.route("/api/activity", activityRouter)
  server.route("/api/pending", pendingRouter)
  server.route("/api/home", homeRouter)
  server.route("/api/spaces/:spaceId/annotations", annotationsRouter)
  return server
}

async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const response = await app().fetch(
    new Request(`http://localhost${path}`, {
      method: init?.method ?? "GET",
      ...(init?.body
        ? {
            body: JSON.stringify(init.body),
            headers: { "Content-Type": "application/json" },
          }
        : {}),
    })
  )
  expect(response.status).toBeLessThan(300)
  return (await response.json()) as T
}

async function agentTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!client) {
    const server = createWorktableMcpServer({
      version: "test",
      scopes: [...DEFAULT_AGENT_TOKEN_SCOPES, "annotations:write"],
      principal: codex.principal,
    })
    client = new Client({ name: "activity-test", version: "1" })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])
  }
  const result = await client.callTool({ name, arguments: { request: args } })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return (result.structuredContent ?? {}) as Record<string, unknown>
}

/** A Doc at `path` in the company Space, written by the agent. */
async function writeDocAt(path: string): Promise<void> {
  await agentTool("worktable_docs_write", {
    action: "write",
    spaceId: "company",
    docPath: path,
    content: "# Pulse\n",
    lifetime: "durable",
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-activity-"))
  appDir = await mkdtemp(join(tmpdir(), "worktable-activity-app-"))
  setWorkspaceRootOverride(root)
  setAppDirOverride(appDir)
  ensureWorkspaceManifest()
  invalidateSearchIndex()
  await writeSpace(space("company", "Company"))
  await writeSpace(space("old", "Old"))
})

afterEach(async () => {
  await client?.close()
  client = null
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  invalidateSearchIndex()
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ])
})

describe("workspace activity", () => {
  it("tells people who did what, newest first, without repeating itself", async () => {
    // An agent writes a doc and revises it the same day.
    const written = await agentTool("worktable_docs_write", {
      action: "write",
      spaceId: "company",
      docPath: "pulse",
      content: "# Pulse\n",
      lifetime: "durable",
    })
    await agentTool("worktable_docs_write", {
      action: "write",
      spaceId: "company",
      docPath: "pulse",
      content: "# Pulse\n\nQ3 is on track.\n",
      expectedRevision: written["revision"],
      // Restating the lifetime is not a change worth an Activity line.
      lifetime: "durable",
    })
    // The person asks for a change; the agent does it and resolves the request.
    const { annotation } = await request<{ annotation: { id: string } }>(
      "/api/spaces/company/annotations",
      {
        method: "POST",
        body: {
          target: { type: "doc", docPath: "pulse" },
          category: "instruction",
          body: "Add the hiring risks.",
        },
      }
    )
    await agentTool("worktable_annotations_write", {
      action: "resolve",
      spaceId: "company",
      annotationId: annotation.id,
    })
    // Work in an archived Space stays out of the workspace view.
    await agentTool("worktable_docs_write", {
      action: "write",
      spaceId: "old",
      docPath: "notes",
      content: "# Notes\n",
      lifetime: "durable",
    })
    await setSpaceArchived("old", true)

    const page = await request<ActivityPage>("/api/activity")
    expect(
      page.entries.map((entry) => [
        entry.action,
        entry.actor.kind,
        entry.actor.name,
        entry.target.kind === "doc" ? entry.target.title : null,
        entry.quote ?? null,
      ])
    ).toEqual([
      ["comment.resolved", "agent", "Codex", "Pulse", "Add the hiring risks."],
      ["comment.created", "person", "Owner", "Pulse", "Add the hiring risks."],
      ["doc.created", "agent", "Codex", "Pulse", null],
    ])
    expect(page.entries[1]?.category).toBe("instruction")

    // Each agent can be followed on its own.
    const { agents } = await request<{ agents: ActivityActor[] }>(
      "/api/activity/agents"
    )
    expect(agents.map((agent) => agent.name)).toEqual(["Codex"])
    const codex = await request<ActivityPage>(
      `/api/activity?actorId=${encodeURIComponent(agents[0]!.id)}`
    )
    expect(codex.entries.map((entry) => entry.action)).toEqual([
      "comment.resolved",
      "doc.created",
    ])

    // A Space Home reads its own history, archived or not.
    const archived = await request<ActivityPage>("/api/activity?spaceId=old")
    expect(archived.entries.map((entry) => entry.action)).toEqual([
      "doc.created",
    ])

    // Pages continue where the previous one stopped.
    const first = await request<ActivityPage>("/api/activity?limit=2")
    expect(first.nextCursor).not.toBeNull()
    const rest = await request<ActivityPage>(
      `/api/activity?limit=2&before=${first.nextCursor}`
    )
    expect(rest.entries.map((entry) => entry.action)).toEqual(["doc.created"])
    expect(rest.nextCursor).toBeNull()

    // A comment names its Doc. Deleting the Doc erases what its comments
    // said, from the history kept on disk too, and keeps each line.
    const stored = async () => {
      await drainActivity()
      const dir = join(appDir, "activity")
      const [key] = await readdir(dir)
      return readFile(join(dir, key!, "company.jsonl"), "utf8")
    }
    const comment = page.entries.find((entry) => entry.action === "comment.created")
    expect(comment?.target).toMatchObject({ documentId: expect.any(String) })
    // A line written before comments named their Doc has only a path.
    recordActivity({
      spaceId: "company",
      action: "comment.created",
      actor: { kind: "person", id: "local:owner" },
      target: { kind: "doc", path: "pulse" },
      quote: "An older note on the plan.",
    })
    expect(await stored()).toContain("An older note on the plan.")
    await agentTool("worktable_delete", { action: "document", spaceId: "company", path: "pulse" })
    const kept = await stored()
    expect(kept).not.toContain("Add the hiring risks.")
    expect(kept).not.toContain("An older note on the plan.")
    expect(kept).toContain('"comment.created"')

    // A new Doc at the same path shows its own comments' words only.
    await writeDocAt("pulse")
    await request("/api/spaces/company/annotations", {
      method: "POST",
      body: { target: { type: "doc", docPath: "pulse" }, category: "comment", body: "A fresh start." },
    })
    const fresh = await request<ActivityPage>("/api/activity?spaceId=company")
    expect(
      fresh.entries
        .filter((entry) => entry.action.startsWith("comment."))
        .map((entry) => entry.quote ?? null)
    ).toEqual(["A fresh start.", null, null, null])
  })

  it("names moved docs and record collections as they are called now", async () => {
    await agentTool("worktable_docs_write", {
      action: "write",
      spaceId: "company",
      docPath: "pulse",
      content: "# Pulse\n",
      lifetime: "durable",
    })
    await agentTool("worktable_documents_write", {
      action: "move",
      spaceId: "company",
      path: "pulse",
      to: "reports/pulse",
    })
    for (const name of ["Hiring", "Hiring plan"]) {
      await agentTool("worktable_records_write", {
        action: "upsert_collection",
        spaceId: "company",
        collectionId: "hiring",
        name,
      })
      await agentTool("worktable_records_write", {
        action: "create",
        spaceId: "company",
        collectionId: "hiring",
        data: { title: name },
      })
    }

    const page = await request<ActivityPage>("/api/activity")
    expect(
      page.entries.find((entry) => entry.action === "doc.created")?.target
    ).toMatchObject({ kind: "doc", path: "reports/pulse", title: "Pulse" })
    const collections = page.entries.flatMap((entry) =>
      entry.target.kind === "collection" ? [entry.target] : []
    )
    expect(collections.length).toBeGreaterThan(0)
    expect(collections.every((target) => target.name === "Hiring plan")).toBe(
      true
    )

    // One doc's history includes what happened before it moved, and nothing else.
    await agentTool("worktable_docs_write", {
      action: "write",
      spaceId: "company",
      docPath: "other",
      content: "# Other\n",
      lifetime: "durable",
    })
    const docPage = await request<ActivityPage>(
      "/api/activity?spaceId=company&docPath=reports%2Fpulse"
    )
    expect(docPage.entries.map((entry) => entry.action)).toContain(
      "doc.created"
    )
    expect(
      docPage.entries.every(
        (entry) =>
          entry.target.kind === "doc" && entry.target.path === "reports/pulse"
      )
    ).toBe(true)
  })

  it("summarizes who worked on each doc without the page waiting on history", async () => {
    const claude = { kind: "agent" as const, id: "local-token:claude", name: "Claude" }
    const maya = { kind: "person" as const, id: "local:owner" }
    const codexActor = { kind: "agent" as const, id: "local-token:codex", name: "Codex" }
    // Claude created it as a draft; it moved to "plan" before Maya edited it.
    recordActivity({ spaceId: "company", action: "doc.created", actor: claude, target: { kind: "doc", path: "drafts/plan" }, at: "2026-10-16T09:00:00.000Z" })
    recordActivity({ spaceId: "company", action: "doc.edited", actor: maya, target: { kind: "doc", path: "plan" }, at: "2026-10-16T09:05:00.000Z" })
    recordActivity({ spaceId: "company", action: "doc.edited", actor: claude, target: { kind: "doc", path: "plan" }, at: "2026-10-16T09:06:00.000Z" })
    // Inside Maya's edit session: never logged, but she edited last.
    recordActivity({ spaceId: "company", action: "doc.edited", actor: maya, target: { kind: "doc", path: "plan" }, at: "2026-10-16T09:07:00.000Z" })
    // Not every reader may see who commented, so comments do not count.
    recordActivity({ spaceId: "company", action: "comment.created", actor: codexActor, target: { kind: "doc", path: "plan" }, at: "2026-10-16T09:10:00.000Z" })
    const plan = pathMovesFor({ exact: { "drafts/plan": "plan" }, prefixes: {} })

    // A page never waits: a Space not summarized yet answers at once.
    expect(peekDocActivity("archive", "notes")).toBeNull()
    await drainActivity()
    expect(peekDocActivity("company", "plan", plan)).toEqual({
      lastEditor: maya,
      contributors: [maya, claude],
    })

    // Later saves count at once, even inside one edit session.
    recordActivity({ spaceId: "company", action: "doc.edited", actor: maya, target: { kind: "doc", path: "plan" } })
    recordActivity({ spaceId: "company", action: "doc.edited", actor: claude, target: { kind: "doc", path: "plan" } })
    recordActivity({ spaceId: "company", action: "doc.edited", actor: maya, target: { kind: "doc", path: "plan" } })
    expect(peekDocActivity("company", "plan", plan)).toEqual({
      lastEditor: maya,
      contributors: [maya, claude],
    })
    expect(peekDocActivity("company", "other")).toEqual({ contributors: [] })
    await drainActivity()
  })

  it("lists what is waiting on the reader until they answer", async () => {
    const owner = ownerIdentity()
    const ownerParticipant = (
      await resolveParticipant(owner, { name: "Owner" })
    ).participant
    await resolveParticipant(codex, {
      name: "Codex",
      defaultSpaceId: "company",
    })
    const asked = await postThreadMessage(codex, {
      location: { kind: "space", spaceId: "company" },
      to: "Owner",
      body: "Which invitation variant should we ship?",
      idempotencyKey: "ask-owner",
      responseIdentityId: defaultConversationIdentityId(ownerParticipant.id),
      waitSeconds: 0,
    })

    const pending = await request<PendingResult>("/api/pending?spaceId=company")
    expect(pending.items).toMatchObject([
      {
        kind: "threadRequest",
        threadId: asked.threadId,
        from: { kind: "agent", name: "Codex" },
        excerpt: "Which invitation variant should we ship?",
      },
    ])

    await postThreadMessage(owner, {
      threadId: asked.threadId,
      body: "The shorter one.",
      idempotencyKey: "owner-answer",
      inReplyTo: asked.messageId,
      responseTo: asked.messageId,
      expectsReply: false,
    })
    expect((await request<PendingResult>("/api/pending")).items).toEqual([])
  })
  it("gives Home one row per sitting, and each place its two weeks", async () => {
    const owner: ActivityActor = { kind: "person", id: "local:owner" }
    const agent: ActivityActor = { kind: "agent", id: codex.principal.id, name: "Codex" }
    const ago = (minutes: number) =>
      new Date(Date.now() - minutes * 60_000).toISOString()
    // Three hours ago the agent wrote one doc; just now, three more.
    setSystemTime(new Date(Date.now() - 180 * 60_000))
    await writeDocAt("plans/old")
    setSystemTime()
    await writeDocAt("plans/a")
    await writeDocAt("plans/b")
    await writeDocAt("notes/c")
    // It had revised one of them earlier, and the owner has since edited another.
    recordActivity({ spaceId: "company", action: "doc.edited", actor: agent, target: { kind: "doc", path: "plans/a" }, at: ago(170) })
    recordActivity({ spaceId: "company", action: "doc.edited", actor: owner, target: { kind: "doc", path: "notes/c" } })
    // Work on a doc that is gone, and older work on a listed doc, list nothing.
    recordActivity({ spaceId: "company", action: "doc.edited", actor: agent, target: { kind: "doc", path: "gone" }, at: ago(1) })
    recordActivity({ spaceId: "company", action: "doc.edited", actor: agent, target: { kind: "doc", path: "plans/b" }, at: ago(60 * 24 * 20) })

    // Each doc is listed once, with whoever changed it last.
    const home = await request<HomeFeed>("/api/home")
    expect(
      home.runs.map((run) => [
        run.actor.kind,
        run.docs.map((doc) => [doc.path, doc.created]),
      ])
    ).toEqual([
      ["person", [["notes/c", false]]],
      ["agent", [["plans/b", true], ["plans/a", true]]],
      ["agent", [["plans/old", true]]],
    ])
    expect(home.runs[0]!.docs[0]!.title).toBe("Pulse")
    // Across Spaces a place is a Space: who worked there, most recent first.
    expect(home.places.map((place) => place.id)).toEqual(["company"])
    expect(home.places[0]!.days).toHaveLength(14)
    expect(home.places[0]!.who.at(-1)!.map((actor) => actor.kind)).toEqual(["person", "agent"])
    expect(home.places[0]!.days.at(-1)).toBeGreaterThanOrEqual(3)
    expect(home.places[0]!.actors.map((actor) => actor.kind)).toEqual(["person", "agent"])

    // In one Space the places are its top-level folders, and a folder narrows the runs.
    const inSpace = await request<HomeFeed>("/api/home?spaceId=company&folder=notes")
    expect(inSpace.places.map((place) => place.id).sort()).toEqual(["notes", "plans"])
    expect(inSpace.runs.map((run) => run.docs.map((doc) => doc.path))).toEqual([["notes/c"]])
    expect(inSpace.pins).toBeUndefined()
    // Rows are ordered by the work they list: the owner's sitting is the
    // newest, but what it did in this folder came before the agent's work.
    recordActivity({ spaceId: "company", action: "doc.edited", actor: owner, target: { kind: "doc", path: "plans/old" }, at: ago(60) })
    const plans = await request<HomeFeed>("/api/home?spaceId=company&folder=plans")
    expect(plans.runs.map((run) => [run.actor.kind, run.docs.map((doc) => doc.path)])).toEqual([
      ["agent", ["plans/b", "plans/a"]],
      ["person", ["plans/old"]],
    ])

    // A person's own pins come with Home; a pin whose doc is gone says so.
    await request("/api/home/pins", {
      method: "PUT",
      body: { pins: [{ spaceId: "company", path: "plans/a" }, { spaceId: "company", path: "gone" }] },
    })
    // One sitting that moves between folders stays one row in either folder.
    setSystemTime(new Date(Date.now() - 140 * 60_000))
    await writeDocAt("alpha/x")
    setSystemTime(new Date(Date.now() + 70 * 60_000))
    await writeDocAt("beta/y")
    setSystemTime()
    await writeDocAt("alpha/z")
    const alpha = await request<HomeFeed>("/api/home?spaceId=company&folder=alpha")
    expect(alpha.runs.map((run) => run.docs.map((doc) => doc.path))).toEqual([["alpha/z", "alpha/x"]])

    // Work older than two weeks still fills Latest, and counts for no place.
    setSystemTime(new Date(Date.now() - 20 * 24 * 60 * 60_000))
    await writeDocAt("archive/long-ago")
    setSystemTime()
    const quiet = await request<HomeFeed>("/api/home?spaceId=company")
    expect(quiet.runs.at(-1)!.docs.map((doc) => doc.path)).toEqual(["archive/long-ago"])
    expect(quiet.places.map((place) => place.id)).not.toContain("archive")

    expect((await request<HomeFeed>("/api/home")).pins).toEqual([
      { spaceId: "company", path: "plans/a", status: "active", title: "Pulse", formatId: "worktable.markdown", revision: expect.any(String) },
      { spaceId: "company", path: "gone", status: "missing" },
    ])
  })
})
