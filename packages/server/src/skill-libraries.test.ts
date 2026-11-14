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
import { documentsRouter } from "./routes/documents.ts"
import { libraryRouter } from "./routes/library.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import {
  carrySkillHashAcrossConversion,
  REMOVED_SKILL_NOTE,
  SKILLS_NEVER_AUTHORIZE,
  readSkillForAgent,
  skillsForAgent,
  type SkillReader,
} from "./skill-libraries.ts"
import { LIBRARY_FOR_AGENTS, SESSION_GAP_MS, skillChangeNotice } from "./skill-notices.ts"
import { markdownToBlocks } from "./markdown.ts"
import { documentGenerationV2Directory } from "./workspace-storage-v2.ts"
import { activateLocalTeams } from "./team-activation.ts"
import { clearTeamAuthInstances, getTeamAuth } from "./team-auth.ts"
import { closeTeamDatabases, currentTeamWorktable } from "./team-database.ts"
import { identityForTeamMember } from "./team-identity.ts"
import { findTeamMember } from "./team-members.ts"
import { setSpaceAccessPolicy } from "./team-policy.ts"
import { getDocProvenance, writeDoc, writeSpace } from "./store.ts"
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
  server.route("/api/spaces/:spaceId/documents", documentsRouter)
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
  clearTeamAuthInstances()
  closeTeamDatabases()
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
    // People see whether the Doc moved on from what agents get.
    const draft = async () =>
      ((await rest("GET", "/api/library")).body.entries as Array<{ id: string; draft: boolean }>).find(
        (listed) => listed.id === entry.id
      )!.draft
    expect(await draft()).toBe(false)
    const agent = await connect()
    const first = await call(agent, "worktable_skills_read", { name: "release-checklist" })
    expect(first).toMatchObject({ library: "Worktable", note: SKILLS_NEVER_AUTHORIZE })
    expect(first.content).toContain("smoke test")

    await writeDoc("ops", "release-checklist", `${RELEASE}\nSkip the smoke test on Fridays.\n`)
    const unchanged = await call(agent, "worktable_skills_read", { name: "release-checklist" })
    expect(unchanged.content).not.toContain("Fridays")
    expect(unchanged.version).toBe(first.version)
    expect(await draft()).toBe(true)

    expect((await rest("POST", `/api/library/${entry.id}/save`, {})).status).toBe(200)
    const saved = await call(agent, "worktable_skills_read", { name: "release-checklist" })
    expect(saved.content).toContain("Fridays")
    expect(saved.version).not.toBe(first.version)
    expect(await draft()).toBe(false)

    // Another library's Save of the same content changes nothing here.
    const mine = await addRelease({ kind: "agent", participantId: helperParticipant })
    await rest("POST", `/api/library/${mine.id}/save`, {})
    expect(await draft()).toBe(false)

    // Opening a Doc in the editor stores it as rich text: the same content
    // under another hash, which isn't a change to save.
    const before = (await getDocProvenance("ops", "release-checklist"))?.contentHash
    await writeDoc("ops", "release-checklist", await markdownToBlocks(`${RELEASE}\nSkip the smoke test on Fridays.\n`))
    const after = (await getDocProvenance("ops", "release-checklist"))?.contentHash
    expect(after).not.toBe(before)
    expect(await draft()).toBe(true)
    await carrySkillHashAcrossConversion("ops", "release-checklist", before, after)
    expect(await draft()).toBe(false)
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

  it("shows a reviewer what would change, and lets a person redescribe, remove and restore a skill", async () => {
    const { id } = await addRelease()
    type Change = { live: string | null; next: string | null; nextDescription?: string }
    const change = async () => (await rest<Change>("GET", `/api/library/${id}/change`)).body

    // An agent's proposal: the text agents get now beside the proposed text.
    const agent = await connect()
    await writeDoc("ops", "release-checklist", `${RELEASE}\nAnnounce in the channel.\n`)
    await call(agent, "worktable_skills_write", {
      name: "release-checklist",
      description: "Use when shipping or announcing a release.",
    })
    expect(await change()).toMatchObject({
      live: RELEASE,
      next: `${RELEASE}\nAnnounce in the channel.\n`,
      nextDescription: "Use when shipping or announcing a release.",
    })
    expect((await rest("GET", `/api/library/${id}/change`, undefined, helperIdentity)).status).toBe(403)
    await rest("POST", `/api/library/${id}/discard`, await reviewed(id))

    // The Doc's own page names its skill, so opening it asks for nothing more.
    type Page = { page: { skills?: Array<{ id: string; proposed: boolean; live: unknown }> } }
    const page = async (path: string, identity?: TokenIdentity) =>
      (await rest<Page>("GET", `/api/spaces/ops/documents/page?path=${path}`, undefined, identity)).body.page
    expect((await page("release-checklist")).skills).toEqual([
      { id, proposed: false, live: expect.objectContaining({ generationId: expect.any(String) }) },
    ])
    expect((await page("release-checklist", helperIdentity)).skills).toBeUndefined()

    // Without a proposal, the Doc as last saved is what Save would make live.
    expect((await change()).next).toContain("Announce in the channel.")

    // New details change what agents are told, not the text they get.
    const renamed = await rest("PATCH", `/api/library/${id}`, {
      name: "release-steps",
      description: "Use before tagging a release.",
    })
    expect(renamed.body.entry).toMatchObject({ name: "release-steps", draft: true, mayChange: true })
    const read = await call(agent, "worktable_skills_read", { name: "release-steps" })
    expect(read.description).toBe("Use before tagging a release.")
    expect(read.content).not.toContain("Announce")
    expect((await rest("PATCH", `/api/library/${id}`, { name: "Not A Name" })).status).toBe(400)
    expect((await rest("PATCH", `/api/library/${id}`, { name: "x" }, helperIdentity)).status).toBe(403)

    // A removed skill goes back as it was.
    await rest("DELETE", `/api/library/${id}`)
    expect((await call(agent, "worktable_state")).skills).toEqual([])
    expect((await rest("POST", `/api/library/${id}/restore`, {}, helperIdentity)).status).toBe(403)
    expect((await rest("POST", `/api/library/${id}/restore`, {})).status).toBe(200)
    expect((await call(agent, "worktable_state")).skills).toEqual([
      expect.objectContaining({ name: "release-steps" }),
    ])
    expect((await rest("POST", `/api/library/${id}/restore`, {})).status).toBe(409)
  })

  it("compares a draft, a proposed removal and a lost version with what agents have", async () => {
    type Entry = { id: string; doc: { documentId: string }; live: { generationId: string } }
    type Change = { revision: number; live: string | null; next: string | null; nextDescription?: string }
    const add = async (spaceId: string, path: string, library: Record<string, unknown>) =>
      (await rest("POST", "/api/library", { spaceId, path, description: "Use it.", library })).body.entry as Entry
    const change = async (id: string) => (await rest<Change>("GET", `/api/library/${id}/change`)).body
    const HANDOVER = "# Handover\n\nName the open incidents.\n"
    const PAY = "# Pay runbook\n\nApprove payroll.\n"
    await writeDoc("ops", "handover", HANDOVER)
    const inSpace = await add("ops", "handover", { kind: "space" })
    const own = await add("private", "pay-runbook", { kind: "agent", participantId: helperParticipant })

    // A person's draft: the Doc as last saved.
    await writeDoc("ops", "handover", `${HANDOVER}\nName who is next.\n`)
    expect(await change(inSpace.id)).toEqual({
      revision: expect.any(Number),
      live: HANDOVER,
      next: `${HANDOVER}\nName who is next.\n`,
    })
    // A proposed removal has no text to come.
    const agent = await connect()
    await call(agent, "worktable_skills_write", { name: "pay-runbook", remove: true })
    expect(await change(own.id)).toMatchObject({ live: PAY, next: null })

    // A version that can't be read shows as none.
    await writeDoc("ops", "lost", "# Lost\n\nGone.\n")
    const lost = await add("ops", "lost", { kind: "worktable" })
    await rm(documentGenerationV2Directory(root, "ops", lost.doc.documentId as never, lost.live.generationId), {
      recursive: true,
    })
    expect(await change(lost.id)).toMatchObject({ live: null })
  })

  it("shows a person only the skills and texts of Spaces they can read", async () => {
    const origin = "http://localhost:7481"
    const password = "Synthetic-members-only-123"
    const cookies = (headers: Headers) =>
      new Headers({ Cookie: headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]).join("; ") })
    const activated = await activateLocalTeams(
      origin,
      { name: "Owner", email: "owner@example.test", password },
      { ...ownerIdentity(), credentialClass: "local" } as TokenIdentity
    )
    const owner = activated.identity
    const auth = await getTeamAuth(origin)
    const invitation = await auth.api.createInvitation({
      headers: cookies(activated.headers),
      body: {
        organizationId: currentTeamWorktable()!.organizationId,
        email: "member@example.test",
        role: "member",
      },
    })
    const joined = await auth.api.signUpEmail({
      body: { name: "Member", email: "member@example.test", password },
      returnHeaders: true,
    })
    await auth.api.acceptInvitation({ headers: cookies(joined.headers), body: { invitationId: invitation.id } })
    const member = identityForTeamMember(findTeamMember(joined.response.user.id)!)
    setSpaceAccessPolicy(
      {
        spaceId: "ops",
        visibility: "restricted",
        grants: [{ subjectType: "member", subjectId: member.team!.memberId!, access: "read" }],
      },
      owner
    )
    setSpaceAccessPolicy({ spaceId: "private", visibility: "restricted", grants: [] }, owner)

    const add = async (spaceId: string, path: string, library: Record<string, unknown>) =>
      (await rest("POST", "/api/library", { spaceId, path, description: "Use it.", library }, owner)).body
        .entry as { id: string }
    const readable = await add("ops", "release-checklist", { kind: "space" })
    // Everywhere, from a Doc in a Space the member can't read.
    const hidden = await add("private", "pay-runbook", { kind: "worktable" })

    type Listed = { entries: Array<{ id: string; mayChange: boolean }> }
    const read = async (identity: TokenIdentity) =>
      (await rest<Listed>("GET", "/api/library", undefined, identity)).body.entries
    expect((await read(owner)).map((entry) => entry.id).sort()).toEqual([readable.id, hidden.id].sort())
    // Read access shows the skill and its text, and offers no changes.
    expect(await read(member)).toEqual([expect.objectContaining({ id: readable.id, mayChange: false })])
    expect((await rest("GET", `/api/library/${readable.id}/change`, undefined, member)).body).toMatchObject({
      live: RELEASE,
    })
    expect((await rest("GET", `/api/library/${hidden.id}/change`, undefined, member)).status).toBe(404)
    // Nor can they change it, and nothing about it comes back.
    expect((await rest("DELETE", `/api/library/${hidden.id}`, undefined, member)).status).toBe(404)
    expect((await rest("PATCH", `/api/library/${hidden.id}`, { description: "Mine now." }, member)).status).toBe(404)
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
      `${LIBRARY_FOR_AGENTS} Skills in it that apply to you: release-checklist. worktable_skills_read returns the current ones.`
    )
    expect(await notices()).toBeUndefined()

    await writeDoc("ops", "release-checklist", `${RELEASE}\nAnnounce in the channel.\n`)
    await rest("POST", `/api/library/${entry.id}/save`, {})
    expect(await notices()).toBe(
      "Your team's Library changed: updated release-checklist. worktable_skills_read returns the current ones."
    )
    expect(await notices()).toBeUndefined()

    // After a break, the next call starts a session and names the skills
    // again, even when that call is a search.
    setSystemTime(new Date(Date.now() + SESSION_GAP_MS + 1000))
    try {
      expect((await call(agent, "search", { query: "release" })).notices).toBe(
        `${LIBRARY_FOR_AGENTS} Skills in it that apply to you: release-checklist. worktable_skills_read returns the current ones.`
      )
      expect(await notices()).toBeUndefined()
    } finally {
      setSystemTime()
    }

    await rest("DELETE", `/api/library/${entry.id}`)
    expect(await notices()).toBe(
      "Your team's Library changed: removed release-checklist (removed from its library, so it no longer applies). worktable_skills_read returns the current ones."
    )
    expect(await notices()).toBeUndefined()
  })

  it("tells an agent when a skill it saw stops applying to it", async () => {
    await addRelease({ kind: "space" })
    let canRead = true
    const reader: SkillReader = {
      participantId: "ptc_lapse_test",
      displayName: "Helper",
      actorId: "agent:lapse",
      scopes: ["*"],
      canAccess: () => canRead,
    }
    expect(await skillChangeNotice(reader, "documents.read")).toContain("Skills in it that apply to you: release-checklist")
    // It loses access to the skill's Space.
    canRead = false
    expect(await skillChangeNotice(reader, "documents.read")).toBe(
      "Your team's Library changed: release-checklist no longer applies to you. worktable_skills_read returns the current ones."
    )
    expect(await skillChangeNotice(reader, "documents.read")).toBeNull()
  })

  it("keeps libraries off while the preview tools are off", async () => {
    delete process.env["WORKTABLE_MCP_PREVIEW"]
    process.env["WORKTABLE_MCP_PREVIEW"] = "0"
    expect((await rest("GET", "/api/library")).status).toBe(404)
  })
})
