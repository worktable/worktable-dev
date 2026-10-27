import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { createAnnotation } from "./annotation-store.ts"
import { resolveParticipant } from "./participant-store.ts"
import { passageAuthor, passageAuthorForTarget } from "./passage-author.ts"
import { pendingFor, pendingList } from "./pending-list.ts"
import { noticesFor, renderNotices } from "./pending-notices.ts"
import { writeDoc, writeSpace } from "./store.ts"
import type { TokenIdentity } from "./token-store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

let root: string
let appDir: string

const finn: TokenIdentity = {
  user: "owner",
  workspace: "test",
  scopes: ["*"],
  agent: "claude-code",
  principal: { id: "token:finn", type: "agent", displayName: "Finn" },
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-passage-author-"))
  appDir = await mkdtemp(join(tmpdir(), "worktable-passage-author-app-"))
  setWorkspaceRootOverride(root)
  setAppDirOverride(appDir)
  ensureWorkspaceManifest()
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "pricing",
    name: "Pricing",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
  // Finn drafts the tiers; Atlas adds a line; a person adds a note.
  await writeDoc("pricing", "explorer", "# Explorer\n\nTeam is **$49** a month.\n", {
    updatedBy: "token:finn",
    source: "mcp",
    managedIdentity: true,
  })
  await writeDoc(
    "pricing",
    "explorer",
    "# Explorer\n\nTeam is **$49** a month.\n\nBusiness is $199 a month.\n",
    { updatedBy: "token:atlas", source: "mcp", managedIdentity: true }
  )
  await writeDoc(
    "pricing",
    "explorer",
    "# Explorer\n\nTeam is **$49** a month.\n\nBusiness is $199 a month.\n\nCheck with sales.\n",
    { updatedBy: "user", source: "rest-api", managedIdentity: true }
  )
})

afterEach(async () => {
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
  await rm(appDir, { recursive: true, force: true })
})

describe("who wrote a passage", () => {
  it("finds the version that put each passage in the Doc, through formatting", async () => {
    expect(
      await passageAuthor("pricing", "explorer", { quote: "Team is $49 a month." })
    ).toMatchObject({ by: "token:finn", kind: "agent" })
    expect(
      await passageAuthor("pricing", "explorer", { quote: "Business is $199" })
    ).toMatchObject({ by: "token:atlas", kind: "agent" })
    expect(
      await passageAuthor("pricing", "explorer", { quote: "Check with sales." })
    ).toMatchObject({ by: "user", kind: "person" })
    expect(
      await passageAuthor("pricing", "explorer", { quote: "Not in the Doc" })
    ).toBeNull()
    // A selection of a letter or two says too little to find a writer by.
    expect(await passageAuthor("pricing", "explorer", { quote: "a" })).toBeNull()
  })

  it("credits a reworded passage to whoever reworded it, and tells no one who can't read Docs", async () => {
    await writeDoc(
      "pricing",
      "explorer",
      "# Explorer\n\nTeam is **$99** a month.\n\nBusiness is $199 a month.\n\nCheck with sales.\n",
      { updatedBy: "token:nova", source: "mcp", managedIdentity: true }
    )
    expect(
      await passageAuthor("pricing", "explorer", { quote: "Team is $99 a month." })
    ).toMatchObject({ by: "token:nova" })
    const target = { type: "doc" as const, docPath: "explorer", quote: "Team is $99 a month." }
    expect(await passageAuthorForTarget("pricing", target, ["annotations:write"])).toBeNull()
    expect(await passageAuthorForTarget("pricing", target, ["documents:read"])).toMatchObject({
      by: "token:nova",
    })
  })

  it("tells the same words in another place apart, and trusts no near match", async () => {
    await writeDoc("pricing", "status", "# Status\n\nSection A: Approved.\n\nSection B: Pending.\n", {
      updatedBy: "token:finn",
      source: "mcp",
      managedIdentity: true,
    })
    await writeDoc("pricing", "status", "# Status\n\nSection A: Approved.\n\nSection B: Approved.\n", {
      updatedBy: "token:atlas",
      source: "mcp",
      managedIdentity: true,
    })
    expect(
      await passageAuthor("pricing", "status", { quote: "Approved.", prefix: "Section B: " })
    ).toMatchObject({ by: "token:atlas" })
    expect(
      await passageAuthor("pricing", "status", { quote: "Approved.", prefix: "Section A: " })
    ).toMatchObject({ by: "token:finn" })
    // Text added beside a passage doesn't make it new: Atlas's line follows
    // Finn's sentence, and the selection carries it as context.
    expect(
      await passageAuthor("pricing", "explorer", {
        quote: "Team is $49 a month.",
        prefix: "Explorer ",
        suffix: " Business is $199 a month.",
      })
    ).toMatchObject({ by: "token:finn" })
    // Words that are not in the Doc are nobody's, however close.
    expect(
      await passageAuthor("pricing", "explorer", { quote: "Team is $49 a month for everyone." })
    ).toBeNull()
  })

  it("names no writer when the passage is older than the history it reads", async () => {
    for (let index = 0; index < 20; index++) {
      await writeDoc(
        "pricing",
        "explorer",
        `# Explorer\n\nTeam is **$49** a month.\n\nRevision ${index}.\n`,
        {
          updatedBy: index % 2 ? "token:atlas" : "token:nova",
          source: "mcp",
          managedIdentity: true,
        }
      )
    }
    expect(
      await passageAuthor("pricing", "explorer", { quote: "Team is $49 a month." })
    ).toBeNull()
    expect(
      await passageAuthor("pricing", "explorer", { quote: "Revision 19." })
    ).toMatchObject({ by: "token:atlas" })
  })

  it("tells the agent that wrote the text, and quotes only its own or a person's text unasked", async () => {
    const { participant } = await resolveParticipant(finn)
    await pendingList()
    const target = {
      type: "doc" as const,
      docPath: "explorer",
      quote: "Team is $49 a month.",
    }
    await createAnnotation("pricing", {
      target,
      category: "comment",
      body: "Feels high for three people.",
      author: { type: "user", id: "user", name: "Karo" },
      to: [{ id: participant.id, kind: "agent", name: "Finn" }],
      byPerson: true,
      passageAuthor: await passageAuthorForTarget("pricing", target, ["*"]),
    })
    const notices = await noticesFor(await pendingFor(participant.id), finn, {
      spaceId: "pricing",
      docPath: "explorer",
    })
    // Karo also comments on the line Atlas wrote: her words, not Atlas's.
    const atlasLine = { type: "doc" as const, docPath: "explorer", quote: "Business is $199 a month." }
    await createAnnotation("pricing", {
      target: atlasLine,
      category: "comment",
      body: "Too close to Team.",
      author: { type: "user", id: "user", name: "Karo" },
      to: [{ id: participant.id, kind: "agent", name: "Finn" }],
      byPerson: true,
      passageAuthor: await passageAuthorForTarget("pricing", atlasLine, ["*"]),
    })
    const { text } = renderNotices(
      await noticesFor(await pendingFor(participant.id), finn, { spaceId: "pricing", docPath: "explorer" }),
      { mode: "ambient" }
    )
    expect(text).toContain("“Karo” sent you a comment on this Doc: “Too close to Team.”")
    expect(text).not.toContain("Business is $199")
    expect(notices).toHaveLength(1)
    expect(text).toMatch(
      /“Karo” sent you a comment on text you wrote on \d+ \w+, “Team is \$49 a month\.”: “Feels high for three people\.”/
    )
  })
})
