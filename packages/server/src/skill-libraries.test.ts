import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { PendingResult } from "@worktable/types"
import { Hono } from "hono"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { ownerIdentity } from "./auth.ts"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { resolveParticipant } from "./participant-store.ts"
import { pendingRouter } from "./routes/activity.ts"
import { libraryRouter } from "./routes/library.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import {
  REMOVED_SKILL_NOTE,
  SKILLS_NEVER_AUTHORIZE,
  readSkillForAgent,
  skillsForAgent,
  type SkillReader,
} from "./skill-libraries.ts"
import { SESSION_GAP_MS } from "./skill-notices.ts"
import { writeDoc, writeSpace } from "./store.ts"
import type { RequestPrincipal, TokenIdentity } from "./token-store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

const helper: RequestPrincipal = {
  id: "local-token:helper",
  type: "agent",
  displayName: "Helper",
  authorizedBy: "local:owner",
}
const helperIdentity: TokenIdentity = {
  user: "owner",
  workspace: "test",
  scopes: ["*"],
  agent: "helper",
  principal: helper,
}

let root = ""
let appDir = ""
let helperParticipant = ""
const clients: Client[] = []

async function connect(surface: "released" | "preview" = "preview"): Promise<Client> {
  const server = createWorktableMcpServer({
    version: "test",
    surface,
    scopes: ["*"],
    identity: { agent: "helper", principal: helper },
    principal: helper,
  })
  const client = new Client({ name: "skills-test", version: "1" })
  clients.push(client)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  await client.listTools()
  return client
}

type ToolResult = {
  isError?: boolean
  content: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`)
  return result.structuredContent!
}

async function refusal(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult
  expect(result.isError).toBe(true)
  return result.content[0]?.text ?? ""
}

function app(identity: TokenIdentity): Hono {
  const server = new Hono()
  server.use("*", async (c, next) => {
    c.set("identity", identity)
    return next()
  })
  server.route("/api/library", libraryRouter)
  server.route("/api/pending", pendingRouter)
  return server
}

async function rest<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  identity: TokenIdentity = ownerIdentity()
): Promise<{ status: number; body: T }> {
  const response = await app(identity).request(path, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  })
  return { status: response.status, body: (await response.json()) as T }
}

async function space(id: string, name: string): Promise<void> {
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
}

/** The revision a person reviews before approving or discarding. */
async function reviewed(id: string): Promise<{ revision: number }> {
  const entries = (await rest("GET", "/api/library")).body.entries as Array<{ id: string; revision: number }>
  return { revision: entries.find((entry) => entry.id === id)!.revision }
}

const RELEASE = "# Release checklist\n\nTag the build, then run the smoke test.\n"

async function addRelease(library: Record<string, unknown> = { kind: "worktable" }) {
  const added = await rest("POST", "/api/library", {
    spaceId: "ops",
    path: "release-checklist",
    description: "Use when shipping a release.",
    library,
  })
  expect(added.status).toBe(201)
  return added.body.entry as { id: string; name: string }
}

beforeEach(async () => {
  process.env["WORKTABLE_MCP_PREVIEW"] = "1"
  root = await mkdtemp(join(tmpdir(), "worktable-skills-"))
  appDir = await mkdtemp(join(tmpdir(), "worktable-skills-app-"))
  setWorkspaceRootOverride(root)
  setAppDirOverride(appDir)
  ensureWorkspaceManifest()
  invalidateSearchIndex()
  await space("ops", "Ops")
  await space("private", "Private")
  await writeDoc("ops", "release-checklist", RELEASE)
  await writeDoc("private", "pay-runbook", "# Pay runbook\n\nApprove payroll.\n")
  helperParticipant = (await resolveParticipant({ agent: "helper", principal: helper })).participant.id
})

afterEach(async () => {
  delete process.env["WORKTABLE_MCP_PREVIEW"]
  await Promise.all(clients.splice(0).map((client) => client.close()))
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  invalidateSearchIndex()
  await rm(root, { recursive: true, force: true })
  await rm(appDir, { recursive: true, force: true })
})

describe("skill libraries", () => {
  it("gives agents the saved version, never later edits, until a person saves again", async () => {
    const entry = await addRelease()
    expect(entry.name).toBe("release-checklist")
    const agent = await connect()
    const first = await call(agent, "worktable_skills_read", { name: "release-checklist" })
    expect(first).toMatchObject({ library: "Worktable", note: SKILLS_NEVER_AUTHORIZE })
    expect(first.content).toContain("smoke test")

    await writeDoc("ops", "release-checklist", `${RELEASE}\nSkip the smoke test on Fridays.\n`)
    const unchanged = await call(agent, "worktable_skills_read", { name: "release-checklist" })
    expect(unchanged.content).not.toContain("Fridays")
    expect(unchanged.version).toBe(first.version)

    expect((await rest("POST", `/api/library/${entry.id}/save`, {})).status).toBe(200)
    const saved = await call(agent, "worktable_skills_read", { name: "release-checklist" })
    expect(saved.content).toContain("Fridays")
    expect(saved.version).not.toBe(first.version)
  })

  it("holds the tools and state's skills for the preview surface", async () => {
    await addRelease()
    const released = await connect("released")
    expect(await call(released, "worktable_state")).not.toHaveProperty("skills")
    // The grouped shape answers no one off the preview.
    expect(
      await refusal(released, "worktable_skills", { request: { action: "read", name: "release-checklist" } })
    ).toContain("aren't available")

    const preview = await connect()
    expect((await call(preview, "worktable_state")).skills).toEqual([
      expect.objectContaining({ name: "release-checklist", library: "Worktable", description: "Use when shipping a release." }),
    ])
  })

  it("turns an agent's changes into proposals that do nothing until a person approves", async () => {
    const agent = await connect()
    const proposed = await call(agent, "worktable_skills_write", {
      spaceId: "ops",
      path: "release-checklist",
      library: "space",
      description: "Use when shipping a release.",
    })
    expect(proposed.message).toContain("goes live only when a person approves it")
    expect((await call(agent, "worktable_state")).skills).toEqual([])
    expect(await refusal(agent, "worktable_skills_read", { name: "release-checklist" })).toContain("No skill named")

    // A person who may approve sees it in Pending; the agent doesn't.
    const pending = (await rest<PendingResult>("GET", "/api/pending")).body
    expect(pending.items).toEqual([
      expect.objectContaining({
        kind: "skillProposal",
        skillName: "release-checklist",
        libraryLabel: "Space: Ops",
        agentName: "Helper",
        change: "add",
      }),
    ])
    const id = (pending.items[0] as { entryId: string }).entryId
    const forAgent = (await rest<PendingResult>("GET", "/api/pending", undefined, helperIdentity)).body
    expect(forAgent.items.filter((item) => item.kind === "skillProposal")).toEqual([])
    expect((await rest("POST", `/api/library/${id}/approve`, await reviewed(id), helperIdentity)).status).toBe(403)

    expect((await rest("POST", `/api/library/${id}/approve`, await reviewed(id))).status).toBe(200)
    expect((await call(agent, "worktable_skills_read", { name: "release-checklist" })).library).toBe("Space: Ops")

    // An update proposes the Doc's content as it is now; the live one stays until approved.
    await writeDoc("ops", "release-checklist", `${RELEASE}\nAnnounce in the channel.\n`)
    await call(agent, "worktable_skills_write", { name: "release-checklist" })
    expect((await call(agent, "worktable_skills_read", { name: "release-checklist" })).content).not.toContain("Announce")
    // Approval names the proposal reviewed: one replaced since is refused.
    const first = await reviewed(id)
    await writeDoc("ops", "release-checklist", `${RELEASE}\nAnnounce in the channel.\nThank the team.\n`)
    await call(agent, "worktable_skills_write", { name: "release-checklist" })
    expect((await rest("POST", `/api/library/${id}/approve`, first)).status).toBe(409)
    await rest("POST", `/api/library/${id}/approve`, await reviewed(id))
    expect((await call(agent, "worktable_skills_read", { name: "release-checklist" })).content).toContain("Thank the team")

    // A removal too, after which the skill is gone even by its exact name.
    await call(agent, "worktable_skills_write", { name: "release-checklist", remove: true })
    expect((await call(agent, "worktable_state")).skills).toHaveLength(1)
    await rest("POST", `/api/library/${id}/approve`, await reviewed(id))
    const state = await call(agent, "worktable_state")
    expect(state.skills).toEqual([])
    expect(state.removedSkills).toEqual([
      { name: "release-checklist", library: "Space: Ops", note: REMOVED_SKILL_NOTE },
    ])
    expect(await refusal(agent, "worktable_skills_read", { name: "release-checklist" })).toContain("No skill named")

    // Discarding a proposed addition leaves nothing behind.
    await call(agent, "worktable_skills_write", {
      spaceId: "ops",
      path: "release-checklist",
      library: "agent",
      name: "my-release",
      description: "How I ship.",
    })
    const waiting = (await rest<PendingResult>("GET", "/api/pending")).body.items
    const mine = waiting.find((item) => item.kind === "skillProposal") as { entryId: string; libraryLabel: string }
    expect(mine.libraryLabel).toBe("Agent: Helper")
    expect((await rest("POST", `/api/library/${mine.entryId}/discard`, await reviewed(mine.entryId))).status).toBe(200)
    const listed = (await rest("GET", "/api/library")).body.entries as Array<{ name: string }>
    expect(listed.map((entry) => entry.name)).toEqual(["release-checklist"])
  })

  it("gives a skill only to agents its library applies to that can read its Doc", async () => {
    await rest("POST", "/api/library", {
      spaceId: "private",
      path: "pay-runbook",
      description: "Use when running payroll.",
      library: { kind: "worktable" },
    })
    await addRelease({ kind: "space" })
    await addRelease({ kind: "agent", participantId: helperParticipant })
    const reader = (
      canRead: (spaceId: string) => boolean,
      participantId: string | null = helperParticipant,
      scopes = ["*"]
    ): SkillReader => ({
      participantId,
      displayName: "Helper",
      actorId: helper.id,
      scopes,
      canAccess: (spaceId, access) => access === "read" && canRead(spaceId),
    })
    const names = async (r: SkillReader) =>
      (await skillsForAgent(r)).live.map((skill) => `${skill.library}/${skill.entry.name}`)

    expect(await names(reader(() => true))).toEqual([
      "Worktable/pay-runbook",
      "Space: Ops/release-checklist",
      "Yours/release-checklist",
    ])
    // Without the private Space, the Worktable's skill from it never reaches the agent.
    const narrowed = reader((spaceId) => spaceId !== "private")
    expect(await names(narrowed)).not.toContain("Worktable/pay-runbook")
    await expect(readSkillForAgent(narrowed, { name: "pay-runbook" })).rejects.toThrow("No skill named")
    // A Space's library needs that Space; an agent's library is its own.
    expect(await names(reader((spaceId) => spaceId !== "ops"))).toEqual(["Worktable/pay-runbook"])
    expect(await names(reader(() => true, "another-agent"))).toEqual([
      "Worktable/pay-runbook",
      "Space: Ops/release-checklist",
    ])
    // Reading skills is reading Docs.
    expect(await names(reader(() => true, helperParticipant, ["search:read"]))).toEqual([])
  })

  it("tells an agent once when its skills change", async () => {
    const entry = await addRelease()
    const agent = await connect()
    const notices = async () =>
      (await call(agent, "worktable_docs_read", { spaceId: "ops", docPath: "release-checklist" })).notices as
        | string
        | undefined
    expect(await notices()).toBe(
      "Skills from your team's Worktable libraries apply to you: release-checklist. worktable_skills_read returns the current ones."
    )
    expect(await notices()).toBeUndefined()

    await writeDoc("ops", "release-checklist", `${RELEASE}\nAnnounce in the channel.\n`)
    await rest("POST", `/api/library/${entry.id}/save`, {})
    expect(await notices()).toBe(
      "Your team's Worktable skills changed: updated release-checklist. worktable_skills_read returns the current ones."
    )
    expect(await notices()).toBeUndefined()

    // After a break, the next call starts a session and names the skills
    // again, even when that call is a search.
    setSystemTime(new Date(Date.now() + SESSION_GAP_MS + 1000))
    try {
      expect((await call(agent, "search", { query: "release" })).notices).toBe(
        "Skills from your team's Worktable libraries apply to you: release-checklist. worktable_skills_read returns the current ones."
      )
      expect(await notices()).toBeUndefined()
    } finally {
      setSystemTime()
    }

    await rest("DELETE", `/api/library/${entry.id}`)
    expect(await notices()).toBe(
      "Your team's Worktable skills changed: removed release-checklist (removed from its library, so it no longer applies). worktable_skills_read returns the current ones."
    )
    expect(await notices()).toBeUndefined()
  })

  it("keeps libraries off while the preview tools are off", async () => {
    delete process.env["WORKTABLE_MCP_PREVIEW"]
    process.env["WORKTABLE_MCP_PREVIEW"] = "0"
    expect((await rest("GET", "/api/library")).status).toBe(404)
  })
})
