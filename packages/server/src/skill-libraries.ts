// ============================================================
// Skill libraries
// ============================================================
//
// A library skill is an ordinary Doc plus an entry here that refers to it by
// its durable identity. Three libraries hold entries: the Worktable's (every
// agent connected to it), a Space's (every agent that can work in that Space)
// and one agent's own. Adding a Doc never copies or moves it and never widens
// who can read it: an agent gets a skill only when its library applies to the
// agent and the agent can read the Doc's Space.
//
// What agents get is an explicit saved version: a meaningful checkpoint of
// the Doc, never its autosaved content. A person makes a version live by
// adding the Doc or by Save. Agents only propose; a proposal does nothing
// until a person approves it.
//
// Entries live in one portable file at the workspace root, so they travel
// with an export. Reads use an in-memory copy that one stat revalidates at
// most once a second; writes go through a lock and an atomic replace.

import { createHash, randomBytes } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import {
  DocumentGenerationIdSchema,
  DocumentIdSchema,
  type PendingItem,
} from "@worktable/types"
import { ensureAppDir } from "./app-storage.ts"
import { atomicWriteText } from "./atomic-file.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { logError } from "./debug-log.ts"
import { readDocumentIdentities } from "./document-query.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import {
  readDocumentGenerationManifestV2,
  readDocumentGenerationSourceEntryV2,
} from "./document-version-store-v2.ts"
import {
  checkpointRegisteredDocument,
  readRegisteredDocumentSource,
} from "./document-write-service.ts"
import { blocksToMarkdownSafe } from "./markdown.ts"
import {
  cachedParticipantForKey,
  participantKey,
  participantsByKey,
} from "./participant-store.ts"
import { readSpace } from "./store.ts"
import { teamsEnabled } from "./team-database.ts"
import {
  canAccessSpace,
  teamAgentForParticipantKey,
  teamMemberForIdentity,
} from "./team-policy.ts"
import { hasScope, type TokenIdentity } from "./token-store.ts"
import { getWorkspaceRoot, LIBRARY_FILE, workspaceCacheKey } from "./workspace.ts"

/** How long agents keep being told a skill was removed. */
export const REMOVED_VISIBLE_MS = 30 * 24 * 60 * 60 * 1000

/** What an agent is told about each skill removed from its library. */
export const REMOVED_SKILL_NOTE =
  "Removed from its library, so it no longer applies. Do the work without it, using the skills that still apply."

/** Said with every skill an agent reads. */
export const SKILLS_NEVER_AUTHORIZE =
  "Skills describe how to do work; they never authorize actions."

/** The most a skill's live version may hold for an agent to read it. */
export const SKILL_MAX_BYTES = 256 * 1024

const REVALIDATE_MS = 1_000
const SKILL_FORMATS = new Set<string>([
  BUILTIN_DOCUMENT_FORMATS.markdown,
  BUILTIN_DOCUMENT_FORMATS.richText,
])

// ---- The file ----

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SkillNameSchema = z.string().max(64).regex(NAME_PATTERN)

const LibraryRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worktable") }),
  z.object({ kind: z.literal("space"), spaceId: z.string().min(1) }),
  z.object({ kind: z.literal("agent"), participantId: z.string().min(1) }),
])

// Loose objects keep fields a newer Worktable wrote when this one rewrites the file.
const LibraryEntrySchema = z.looseObject({
  id: z.string().min(1),
  name: SkillNameSchema,
  description: z.string().min(1),
  library: LibraryRefSchema,
  doc: z.object({ spaceId: z.string().min(1), documentId: DocumentIdSchema }),
  live: z
    .object({
      generationId: DocumentGenerationIdSchema,
      savedAt: z.string(),
      savedBy: z.string(),
    })
    .nullable(),
  proposal: z
    .object({
      kind: z.enum(["add", "update", "remove"]),
      generationId: DocumentGenerationIdSchema.optional(),
      description: z.string().optional(),
      by: z.object({ participantId: z.string(), displayName: z.string() }),
      at: z.string(),
    })
    .nullable(),
  removed: z.object({ at: z.string(), by: z.string() }).nullable(),
  revision: z.number().int().nonnegative(),
})

const LibraryFileSchema = z.looseObject({
  type: z.literal("worktable.library"),
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  entries: z.array(LibraryEntrySchema),
})

export type LibraryRef = z.infer<typeof LibraryRefSchema>
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>
export type LibraryProposal = NonNullable<LibraryEntry["proposal"]>
type LibraryFile = z.infer<typeof LibraryFileSchema>

export type LibraryErrorCode =
  | "not_found"
  | "conflict"
  | "forbidden"
  | "invalid"
  | "unreadable"

export class LibraryError extends Error {
  readonly code: LibraryErrorCode
  constructor(code: LibraryErrorCode, message: string) {
    super(message)
    this.name = "LibraryError"
    this.code = code
  }
}

const EMPTY: LibraryFile = Object.freeze({
  type: "worktable.library",
  version: 1,
  revision: 0,
  entries: [],
}) as LibraryFile

function libraryPath(): string {
  return join(getWorkspaceRoot(), LIBRARY_FILE)
}

/** The lock lives in app storage, so taking it never touches the workspace root. */
function lockPath(): string {
  return join(ensureAppDir(), "library", `${workspaceCacheKey()}.lock`)
}

function signatureOf(path: string): string {
  try {
    const stat = statSync(path)
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unreadable"
  }
}

function load(path: string, signature: string): { file: LibraryFile; readable: boolean } {
  if (signature === "missing") return { file: EMPTY, readable: true }
  try {
    const parsed = LibraryFileSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8"))
    )
    if (parsed.success) return { file: parsed.data, readable: true }
    console.error("[library] library.json is not a library file; serving none")
  } catch (error) {
    console.error("[library] could not read library.json:", logError(error))
  }
  return { file: EMPTY, readable: false }
}

let cache: {
  path: string
  signature: string
  checkedAt: number
  file: LibraryFile
} | null = null

/** Every entry, as the file holds them now (within a second). */
export function readLibrary(): LibraryFile {
  const path = libraryPath()
  const now = Date.now()
  if (cache?.path === path && now - cache.checkedAt < REVALIDATE_MS) return cache.file
  const signature = signatureOf(path)
  if (cache?.path === path && cache.signature === signature) {
    cache.checkedAt = now
    return cache.file
  }
  cache = { path, signature, checkedAt: now, file: load(path, signature).file }
  return cache.file
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Change the library under its lock, from what is on disk now. A change that
 * throws writes nothing. A file that can't be read is never overwritten.
 */
function changeLibrary<T>(change: (file: LibraryFile, now: string) => T): Promise<T> {
  const run = () =>
    withCrossProcessLock(lockPath(), { label: "Skill library" }, async () => {
      const path = libraryPath()
      const loaded = load(path, signatureOf(path))
      if (!loaded.readable) {
        throw new LibraryError(
          "unreadable",
          "The library file can't be read, so it isn't changed. Move library.json aside to start a new library."
        )
      }
      const file: LibraryFile = structuredClone(loaded.file)
      const now = new Date().toISOString()
      const result = change(file, now)
      const cutoff = Date.parse(now) - REMOVED_VISIBLE_MS
      file.entries = file.entries.filter(
        (entry) => !entry.removed || Date.parse(entry.removed.at) >= cutoff
      )
      file.revision += 1
      await atomicWriteText(path, `${JSON.stringify(file, null, 2)}\n`)
      cache = { path, signature: signatureOf(path), checkedAt: Date.now(), file }
      return result
    })
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

// ---- Names, libraries and versions ----

function sameLibrary(a: LibraryRef, b: LibraryRef): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "space") return a.spaceId === (b as typeof a).spaceId
  if (a.kind === "agent") return a.participantId === (b as typeof a).participantId
  return true
}

/** A Doc's name as a skill name: lowercase words joined by hyphens. */
export function skillNameFrom(title: string): string {
  const name = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "")
  return name || "skill"
}

function checkedName(name: string): string {
  if (!NAME_PATTERN.test(name) || name.length > 64) {
    throw new LibraryError(
      "invalid",
      "A skill's name is lowercase words joined by hyphens, such as release-checklist, up to 64 characters."
    )
  }
  return name
}

function checkedDescription(description: string | undefined): string {
  const line = (description ?? "").replace(/\s+/g, " ").trim()
  if (!line) {
    throw new LibraryError("invalid", "A skill needs a one-line description of when it applies.")
  }
  if (line.length > 280) {
    throw new LibraryError("invalid", "A skill's description is one line of up to 280 characters.")
  }
  return line
}

function assertNameFree(
  file: LibraryFile,
  library: LibraryRef,
  name: string,
  except?: string
): void {
  const taken = file.entries.some(
    (entry) =>
      entry.id !== except &&
      !entry.removed &&
      sameLibrary(entry.library, library) &&
      entry.name === name
  )
  if (taken) {
    throw new LibraryError(
      "conflict",
      `This library already has a skill named ${name}. Choose another name, or change that skill.`
    )
  }
}

/** A short, stable token for a live version, so a reader can tell versions apart. */
export function skillVersion(generationId: string): string {
  return `v_${createHash("sha256").update(generationId).digest("base64url").slice(0, 8)}`
}

function mintEntryId(): string {
  return `skl_${randomBytes(12).toString("base64url")}`
}

function entryById(file: LibraryFile, id: string): LibraryEntry {
  const entry = file.entries.find((candidate) => candidate.id === id)
  if (!entry) throw new LibraryError("not_found", "No skill with that id is in a library.")
  return entry
}

function touched(entry: LibraryEntry): void {
  entry.revision += 1
}

// ---- Docs ----

interface DocLocation {
  path: string
  title: string
}

type Locate = (doc: LibraryEntry["doc"]) => Promise<DocLocation | null>

/**
 * Where Docs are now, or null for one deleted, archived or in an archived
 * Space. Each Space's identities come from its read-model snapshot, once per
 * locator.
 */
function docLocator(): Locate {
  const spaces = new Map<string, ReturnType<typeof readDocumentIdentities>>()
  return async (doc) => {
    if (!spaces.has(doc.spaceId)) spaces.set(doc.spaceId, readDocumentIdentities(doc.spaceId))
    try {
      const { identities } = (await spaces.get(doc.spaceId))!
      if (identities.spaceArchived) return null
      return identities.current.get(doc.documentId) ?? null
    } catch {
      return null
    }
  }
}

const docLocation: Locate = (doc) => docLocator()(doc)

/** The Doc at a path as it is now, after checking it can be a skill. */
async function currentSkillDoc(spaceId: string, path: string) {
  const source = await readRegisteredDocumentSource({ spaceId, path })
  if (!SKILL_FORMATS.has(source.format.id)) {
    throw new LibraryError("invalid", "A skill is a Doc: Markdown or rich text.")
  }
  return source
}

/**
 * Save the Doc's current content as a version kept for good, the version a
 * skill goes live with. Saving a version needs Edit on the Doc's Space.
 */
async function saveVersion(options: {
  spaceId: string
  path: string
  createdBy: string
  source: string
  label: string
}): Promise<{ documentId: string; generationId: string; path: string }> {
  if (!canAccessSpace(options.spaceId, "edit")) {
    throw new LibraryError("forbidden", "Saving a version of this Doc needs Edit on its Space.")
  }
  const current = await currentSkillDoc(options.spaceId, options.path)
  const saved = await checkpointRegisteredDocument({
    spaceId: options.spaceId,
    path: current.path,
    expectedRevision: current.sourceRevision,
    createdBy: options.createdBy,
    source: options.source,
    label: options.label,
  })
  return { documentId: saved.documentId, generationId: saved.versionId, path: saved.path }
}

/** A live version's content, as Markdown. */
async function liveContent(entry: LibraryEntry, generationId: string): Promise<string> {
  const workspaceRoot = getWorkspaceRoot()
  const manifest = await readDocumentGenerationManifestV2({
    workspaceRoot,
    spaceId: entry.doc.spaceId,
    documentId: entry.doc.documentId,
    generationId,
  }).catch(() => null)
  const entryPath =
    manifest?.authoredSource.kind === "file"
      ? manifest.authoredSource.entries[0]?.path
      : undefined
  if (!manifest || !entryPath || !SKILL_FORMATS.has(manifest.format.id)) {
    throw new LibraryError("not_found", "No skill by that name applies to you.")
  }
  const bytes = await readDocumentGenerationSourceEntryV2({
    workspaceRoot,
    manifest,
    entryPath,
    maxBytes: SKILL_MAX_BYTES,
  })
  if (!bytes) throw new LibraryError("invalid", "This skill is too large to read.")
  const text = new TextDecoder().decode(bytes)
  if (manifest.format.id === BUILTIN_DOCUMENT_FORMATS.markdown) return text
  let blocks: unknown = null
  try {
    blocks = JSON.parse(text)
  } catch {
    // Not blocks: refused below like any other unreadable Doc.
  }
  const markdown = Array.isArray(blocks) ? await blocksToMarkdownSafe(blocks) : null
  if (markdown === null) throw new LibraryError("invalid", "This skill's Doc can't be read as text.")
  return markdown
}

// ---- Who may change a library ----

/** Whether a person reached this server: not an agent and not an operator check. */
export function isPerson(identity: TokenIdentity): boolean {
  return (
    identity.principal.type === "human" &&
    identity.agent === null &&
    !identity.operatorVerification
  )
}

async function participantKeyFor(participantId: string): Promise<string | null> {
  for (const [key, participant] of await participantsByKey()) {
    if (participant.id === participantId) return key
  }
  return null
}

/**
 * Whether a person may change a library: Edit on a Space's; any member on a
 * team Worktable (the owner otherwise) for the Worktable's; an agent's owner
 * for an agent's: the member a personal agent belongs to, or a Team owner for
 * a team agent.
 */
export async function personMayChange(
  library: LibraryRef,
  identity: TokenIdentity
): Promise<boolean> {
  if (!isPerson(identity)) return false
  if (library.kind === "space") return canAccessSpace(library.spaceId, "edit", identity)
  if (!teamsEnabled()) return true
  const member = teamMemberForIdentity(identity)
  if (!member) return false
  if (library.kind === "worktable") return true
  const key = await participantKeyFor(library.participantId)
  const agent = key ? teamAgentForParticipantKey(key) : null
  if (agent?.ownership === "personal") return agent.memberId === member.id
  return member.role === "owner"
}

async function requirePersonMayChange(
  library: LibraryRef,
  identity: TokenIdentity
): Promise<void> {
  if (!(await personMayChange(library, identity))) {
    throw new LibraryError("forbidden", "You can't change this library.")
  }
}

function attribution(identity: TokenIdentity): { createdBy: string; source: string } {
  // On a team, each person is their own author, as Doc writes record it.
  return { createdBy: teamsEnabled() ? identity.principal.id : "user", source: "rest-api" }
}

// ---- Labels ----

async function spaceNames(spaceIds: Iterable<string>): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  await Promise.all(
    [...new Set(spaceIds)].map(async (spaceId) => {
      const { data } = await readSpace(spaceId)
      names.set(spaceId, data?.name ?? spaceId)
    })
  )
  return names
}

function agentLabel(library: LibraryRef, spaces: Map<string, string>): string {
  if (library.kind === "worktable") return "Worktable"
  if (library.kind === "space") return `Space: ${spaces.get(library.spaceId) ?? library.spaceId}`
  return "Yours"
}

async function personLabels(entries: LibraryEntry[]): Promise<(library: LibraryRef) => string> {
  const spaces = await spaceNames(
    entries.flatMap((entry) => (entry.library.kind === "space" ? [entry.library.spaceId] : []))
  )
  const agents = entries.some((entry) => entry.library.kind === "agent")
    ? new Map([...(await participantsByKey()).values()].map((participant) => [participant.id, participant.name]))
    : new Map<string, string>()
  return (library) =>
    library.kind === "agent"
      ? `Agent: ${agents.get(library.participantId) ?? "Removed agent"}`
      : agentLabel(library, spaces)
}

// ---- People ----

export interface LibraryInput {
  spaceId: string
  path?: string
  documentId?: string
  name?: string
  description: string
  library:
    | { kind: "worktable" }
    | { kind: "space"; spaceId?: string }
    | { kind: "agent"; participantId: string }
}

export interface LibraryEntryView extends LibraryEntry {
  libraryLabel: string
  /** The Doc's path and title now; absent when it no longer opens. */
  docPath?: string
  docTitle?: string
}

async function viewOf(
  entries: LibraryEntry[]
): Promise<LibraryEntryView[]> {
  const label = await personLabels(entries)
  const locate = docLocator()
  return Promise.all(
    entries.map(async (entry) => {
      const location = await locate(entry.doc)
      return {
        ...entry,
        libraryLabel: label(entry.library),
        ...(location ? { docPath: location.path, docTitle: location.title } : {}),
      }
    })
  )
}

/** The entries a person may see: their libraries, for Docs they can read. */
export async function listLibraryForPerson(
  identity: TokenIdentity
): Promise<{ revision: number; entries: LibraryEntryView[] }> {
  const file = readLibrary()
  const visible: LibraryEntry[] = []
  for (const entry of file.entries) {
    if (!canAccessSpace(entry.doc.spaceId, "read", identity)) continue
    const library = entry.library
    const sees =
      library.kind === "space"
        ? canAccessSpace(library.spaceId, "read", identity)
        : library.kind === "worktable" || (await personMayChange(library, identity))
    if (sees) visible.push(entry)
  }
  return { revision: file.revision, entries: await viewOf(visible) }
}

async function resolveLibrary(input: LibraryInput["library"], docSpaceId: string): Promise<LibraryRef> {
  if (input.kind === "worktable") return { kind: "worktable" }
  if (input.kind === "space") return { kind: "space", spaceId: input.spaceId ?? docSpaceId }
  const known = await participantKeyFor(input.participantId)
  const participant = known ? (await participantsByKey()).get(known) : null
  if (participant?.kind !== "agent") {
    throw new LibraryError("not_found", "No agent with that id is connected to this Worktable.")
  }
  return { kind: "agent", participantId: input.participantId }
}

/** Add a Doc to a library. Its current content is saved as a version and goes live. */
export async function addToLibrary(
  identity: TokenIdentity,
  input: LibraryInput
): Promise<LibraryEntryView> {
  if (!canAccessSpace(input.spaceId, "read", identity)) {
    throw new LibraryError("not_found", "That Doc isn't in this Space.")
  }
  const library = await resolveLibrary(input.library, input.spaceId)
  await requirePersonMayChange(library, identity)
  const description = checkedDescription(input.description)
  let path = input.path
  if (!path && input.documentId) {
    const location = await docLocation({ spaceId: input.spaceId, documentId: input.documentId })
    if (!location) throw new LibraryError("not_found", "That Doc isn't in this Space.")
    path = location.path
  }
  if (!path) throw new LibraryError("invalid", "Name the Doc by path or documentId.")
  const current = await currentSkillDoc(input.spaceId, path)
  const name = checkedName(input.name ?? skillNameFrom(current.path.split("/").at(-1) ?? ""))
  assertNameFree(readLibrary(), library, name)
  const saved = await saveVersion({
    spaceId: input.spaceId,
    path: current.path,
    ...attribution(identity),
    label: "Library skill",
  })
  const entry = await changeLibrary((file, now) => {
    assertNameFree(file, library, name)
    const created: LibraryEntry = {
      id: mintEntryId(),
      name,
      description,
      library,
      doc: { spaceId: input.spaceId, documentId: saved.documentId },
      live: { generationId: saved.generationId, savedAt: now, savedBy: identity.principal.id },
      proposal: null,
      removed: null,
      revision: 1,
    }
    // A skill removed under this name gives way to the new one.
    file.entries = file.entries.filter(
      (other) => !(other.removed && other.name === name && sameLibrary(other.library, library))
    )
    file.entries.push(created)
    return created
  })
  return (await viewOf([entry]))[0]!
}

/** Make the Doc's current content the live version, and optionally rename or redescribe it. */
export async function saveLibrarySkill(
  identity: TokenIdentity,
  id: string,
  input: { name?: string; description?: string } = {}
): Promise<LibraryEntryView> {
  const before = entryById(readLibrary(), id)
  if (before.removed) throw new LibraryError("not_found", "This skill was removed from its library.")
  await requirePersonMayChange(before.library, identity)
  const name = input.name === undefined ? undefined : checkedName(input.name)
  const description = input.description === undefined ? undefined : checkedDescription(input.description)
  const location = await docLocation(before.doc)
  if (!location) throw new LibraryError("not_found", "This skill's Doc no longer opens.")
  const saved = await saveVersion({
    spaceId: before.doc.spaceId,
    path: location.path,
    ...attribution(identity),
    label: "Library skill",
  })
  const entry = await changeLibrary((file, now) => {
    const entry = entryById(file, id)
    if (entry.removed) throw new LibraryError("not_found", "This skill was removed from its library.")
    if (name !== undefined) assertNameFree(file, entry.library, name, entry.id)
    entry.live = { generationId: saved.generationId, savedAt: now, savedBy: identity.principal.id }
    if (name !== undefined) entry.name = name
    if (description !== undefined) entry.description = description
    // A proposal to add it is answered: it is live.
    if (entry.proposal?.kind === "add") entry.proposal = null
    touched(entry)
    return entry
  })
  return (await viewOf([entry]))[0]!
}

/** Approve an agent's proposal: it goes live, or the skill is removed. */
/** The proposal a person reviewed is still the one waiting. */
function assertReviewed(entry: LibraryEntry, revision: number): void {
  if (entry.revision !== revision) {
    throw new LibraryError("conflict", "This proposal changed since you reviewed it. Review it again.")
  }
}

export async function approveLibraryProposal(
  identity: TokenIdentity,
  id: string,
  revision: number
): Promise<LibraryEntryView> {
  const before = entryById(readLibrary(), id)
  await requirePersonMayChange(before.library, identity)
  if (!canAccessSpace(before.doc.spaceId, "read", identity)) {
    throw new LibraryError("forbidden", "You can't read this skill's Doc, so you can't approve it.")
  }
  const entry = await changeLibrary((file, now) => {
    const entry = entryById(file, id)
    const proposal = entry.proposal
    if (!proposal || entry.removed) {
      throw new LibraryError("conflict", "Nothing waits on approval for this skill.")
    }
    assertReviewed(entry, revision)
    if (proposal.kind === "remove") {
      entry.removed = { at: now, by: identity.principal.id }
    } else {
      if (!proposal.generationId) throw new LibraryError("conflict", "This proposal has no version to make live.")
      assertNameFree(file, entry.library, entry.name, entry.id)
      if (proposal.description) entry.description = proposal.description
      entry.live = { generationId: proposal.generationId, savedAt: now, savedBy: identity.principal.id }
    }
    entry.proposal = null
    touched(entry)
    return entry
  })
  return (await viewOf([entry]))[0]!
}

/** Discard an agent's proposal. A skill only proposed is gone with it. */
export async function discardLibraryProposal(
  identity: TokenIdentity,
  id: string,
  revision: number
): Promise<{ entry: LibraryEntryView | null }> {
  await requirePersonMayChange(entryById(readLibrary(), id).library, identity)
  const entry = await changeLibrary((file) => {
    const entry = entryById(file, id)
    if (!entry.proposal) throw new LibraryError("conflict", "Nothing waits on approval for this skill.")
    assertReviewed(entry, revision)
    if (!entry.live && !entry.removed) {
      file.entries = file.entries.filter((other) => other.id !== id)
      return null
    }
    entry.proposal = null
    touched(entry)
    return entry
  })
  return { entry: entry ? (await viewOf([entry]))[0]! : null }
}

/** Remove a skill from its library at once. Agents are told for 30 days. */
export async function removeFromLibrary(
  identity: TokenIdentity,
  id: string
): Promise<{ entry: LibraryEntryView | null }> {
  await requirePersonMayChange(entryById(readLibrary(), id).library, identity)
  const entry = await changeLibrary((file, now) => {
    const entry = entryById(file, id)
    if (entry.removed) throw new LibraryError("not_found", "This skill was already removed.")
    // Never live, so no agent has it to unlearn.
    if (!entry.live) {
      file.entries = file.entries.filter((other) => other.id !== id)
      return null
    }
    entry.removed = { at: now, by: identity.principal.id }
    entry.proposal = null
    touched(entry)
    return entry
  })
  return { entry: entry ? (await viewOf([entry]))[0]! : null }
}

/** Agents' proposals waiting on this person, for Pending. */
export async function pendingSkillProposals(
  identity: TokenIdentity,
  spaceId?: string
): Promise<PendingItem[]> {
  if (!isPerson(identity)) return []
  const waiting: LibraryEntry[] = []
  for (const entry of readLibrary().entries) {
    if (!entry.proposal || entry.removed) continue
    if (spaceId && (entry.library.kind !== "space" || entry.library.spaceId !== spaceId)) continue
    if (!canAccessSpace(entry.doc.spaceId, "read", identity)) continue
    if (await personMayChange(entry.library, identity)) waiting.push(entry)
  }
  if (waiting.length === 0) return []
  const label = await personLabels(waiting)
  return waiting.map((entry) => {
    const proposal = entry.proposal!
    return {
      kind: "skillProposal",
      id: `skill:${entry.id}:${entry.revision}`,
      at: proposal.at,
      spaceId: entry.library.kind === "space" ? entry.library.spaceId : null,
      entryId: entry.id,
      revision: entry.revision,
      skillName: entry.name,
      libraryLabel: label(entry.library),
      agentName: proposal.by.displayName,
      change: proposal.kind,
    }
  })
}

// ---- Agents ----

/** The agent a call comes from, and what it may reach. */
export interface SkillReader {
  /** Its participant, which survives reconnects; null for a caller without one. */
  participantId: string | null
  displayName: string
  /** Who saved versions are attributed to. */
  actorId: string
  scopes: readonly string[]
  canAccess: (spaceId: string, access: "read" | "edit") => boolean
}

/**
 * The reader for a tool call's identity. Space access follows the request's
 * identity, as every other tool's does.
 */
export function skillReaderFor(
  identity: Pick<TokenIdentity, "agent" | "principal"> & { scopes: readonly string[] }
): SkillReader {
  const participant = cachedParticipantForKey(participantKey(identity))
  return {
    participantId: participant?.kind === "agent" ? participant.id : null,
    displayName: participant?.name ?? identity.principal.displayName,
    actorId: identity.principal.id,
    scopes: identity.scopes,
    canAccess: (spaceId, access) => canAccessSpace(spaceId, access),
  }
}

/** One skill as an agent sees it. */
export interface AgentSkill {
  entry: LibraryEntry
  live: NonNullable<LibraryEntry["live"]>
  library: string
  path: string
}

function libraryApplies(library: LibraryRef, reader: SkillReader): boolean {
  if (library.kind === "worktable") return true
  if (library.kind === "space") return reader.canAccess(library.spaceId, "read")
  return reader.participantId !== null && library.participantId === reader.participantId
}

/**
 * What applies to an agent, from the in-memory index alone: each entry's live
 * version, or "removed" for one removed within 30 days. It reads no files, so
 * a tool call can compare it with what the agent last saw at no cost. It
 * doesn't check that each Doc still opens; skillsForAgent does.
 */
export function applicableVersions(reader: SkillReader): Map<string, string> {
  const versions = new Map<string, string>()
  const file = readLibrary()
  if (file.entries.length === 0 || !hasScope([...reader.scopes], "documents:read")) return versions
  const now = Date.now()
  for (const entry of file.entries) {
    if (!libraryApplies(entry.library, reader) || !reader.canAccess(entry.doc.spaceId, "read")) continue
    if (entry.removed) {
      if (now - Date.parse(entry.removed.at) < REMOVED_VISIBLE_MS) versions.set(entry.id, REMOVED_MARK)
    } else if (entry.live) {
      versions.set(entry.id, entry.live.generationId)
    }
  }
  return versions
}

/** The seen mark for a skill removed from its library. */
export const REMOVED_MARK = "removed"

function inScope(library: LibraryRef, spaceId: string | undefined): boolean {
  return !spaceId || library.kind !== "space" || library.spaceId === spaceId
}

/**
 * The skills that apply to an agent: live, in a library that applies to it,
 * of a Doc it can read that still opens. With spaceId, only that Space's
 * library besides the Worktable's and the agent's own. Removed ones are
 * those removed within 30 days from libraries that apply.
 */
export async function skillsForAgent(
  reader: SkillReader,
  options: { spaceId?: string } = {}
): Promise<{ live: AgentSkill[]; removed: Array<{ entry: LibraryEntry; library: string }> }> {
  const file = readLibrary()
  if (file.entries.length === 0 || !hasScope([...reader.scopes], "documents:read")) {
    return { live: [], removed: [] }
  }
  const now = Date.now()
  const applicable = file.entries.filter(
    (entry) =>
      inScope(entry.library, options.spaceId) &&
      libraryApplies(entry.library, reader) &&
      reader.canAccess(entry.doc.spaceId, "read")
  )
  if (applicable.length === 0) return { live: [], removed: [] }
  const spaces = await spaceNames(
    applicable.flatMap((entry) => (entry.library.kind === "space" ? [entry.library.spaceId] : []))
  )
  const live: AgentSkill[] = []
  const removed: Array<{ entry: LibraryEntry; library: string }> = []
  const locate = docLocator()
  for (const entry of applicable) {
    if (entry.removed) {
      if (now - Date.parse(entry.removed.at) < REMOVED_VISIBLE_MS) {
        removed.push({ entry, library: agentLabel(entry.library, spaces) })
      }
      continue
    }
    if (!entry.live) continue
    const location = await locate(entry.doc)
    if (!location) continue
    live.push({ entry, live: entry.live, library: agentLabel(entry.library, spaces), path: location.path })
  }
  live.sort((a, b) => a.entry.name.localeCompare(b.entry.name))
  // A name back in its library isn't removed from it.
  const liveNames = new Set(live.map((skill) => `${skill.library}\n${skill.entry.name}`))
  return {
    live,
    removed: removed.filter(({ entry, library }) => !liveNames.has(`${library}\n${entry.name}`)),
  }
}

function matchesHint(
  library: LibraryRef,
  hint: { library?: LibraryRef["kind"]; spaceId?: string }
): boolean {
  if (hint.library && library.kind !== hint.library) return false
  if (hint.spaceId && library.kind === "space" && library.spaceId !== hint.spaceId) return false
  return true
}

function pickOne<T extends { entry: LibraryEntry }>(found: T[], name: string): T {
  if (found.length === 0) throw new LibraryError("not_found", `No skill named ${name} applies to you.`)
  if (found.length > 1) {
    throw new LibraryError(
      "conflict",
      `More than one library has a skill named ${name}. Pass library (and spaceId for a Space's) to choose.`
    )
  }
  return found[0]!
}

/** A live skill's content, for an agent it applies to. */
export async function readSkillForAgent(
  reader: SkillReader,
  input: { name: string; library?: "worktable" | "space" | "agent"; spaceId?: string }
) {
  const { live } = await skillsForAgent(reader)
  const skill = pickOne(
    live.filter((candidate) => candidate.entry.name === input.name && matchesHint(candidate.entry.library, input)),
    input.name
  )
  return {
    name: skill.entry.name,
    description: skill.entry.description,
    library: skill.library,
    version: skillVersion(skill.live.generationId),
    spaceId: skill.entry.doc.spaceId,
    path: skill.path,
    content: await liveContent(skill.entry, skill.live.generationId),
    note: SKILLS_NEVER_AUTHORIZE,
  }
}

export interface ProposalInput {
  name?: string
  spaceId?: string
  path?: string
  library?: "worktable" | "space" | "agent"
  description?: string
  remove?: boolean
}

const PROPOSED =
  "This is a proposal: it goes live only when a person approves it in Worktable."

function proposalResult(entry: LibraryEntry, library: string) {
  const proposal = entry.proposal!
  return {
    ok: true as const,
    proposal: {
      id: entry.id,
      name: entry.name,
      library,
      change: proposal.kind,
    },
    message: PROPOSED,
  }
}

/** Whether an agent could change a library with its own access. */
function agentMayPropose(library: LibraryRef, reader: SkillReader): boolean {
  if (library.kind === "space") return reader.canAccess(library.spaceId, "edit")
  if (library.kind === "worktable") return hasScope([...reader.scopes], "documents:write")
  return reader.participantId !== null && library.participantId === reader.participantId
}

function requireAgentMayPropose(library: LibraryRef, reader: SkillReader, doc: { spaceId: string }): void {
  if (!agentMayPropose(library, reader)) {
    throw new LibraryError("forbidden", "You can't propose changes to this library.")
  }
  if (!reader.canAccess(doc.spaceId, "read")) {
    throw new LibraryError("forbidden", "You can't read this Doc.")
  }
}

/**
 * An agent's proposed change to a library: add a Doc, update a skill to its
 * Doc's current content, or remove a skill. The content proposed is saved as
 * a version now, so approval makes exactly it live. Nothing changes for any
 * agent until a person approves.
 */
export async function proposeSkillChange(reader: SkillReader, input: ProposalInput) {
  if (!reader.participantId) {
    throw new LibraryError("forbidden", "Only a connected agent can propose skills.")
  }
  const by = { participantId: reader.participantId, displayName: reader.displayName }
  if (input.remove && input.path !== undefined) {
    throw new LibraryError("invalid", "remove takes the skill's name, not a path.")
  }
  if (input.path !== undefined) return proposeAdd(reader, input, by)
  if (!input.name) {
    throw new LibraryError("invalid", "Pass spaceId and path to add a Doc, or name to change a skill.")
  }
  const name = input.name
  // Skills it can see, live or waiting to be added, by name.
  const candidates = readLibrary().entries.filter(
    (entry) =>
      !entry.removed &&
      entry.name === name &&
      matchesHint(entry.library, input) &&
      libraryApplies(entry.library, reader) &&
      reader.canAccess(entry.doc.spaceId, "read")
  )
  const { entry: target } = pickOne(candidates.map((entry) => ({ entry })), name)
  requireAgentMayPropose(target.library, reader, target.doc)
  const spaces = await spaceNames(target.library.kind === "space" ? [target.library.spaceId] : [])
  const description = input.description === undefined ? undefined : checkedDescription(input.description)
  let generationId: string | undefined
  if (!input.remove) {
    const location = await docLocation(target.doc)
    if (!location) throw new LibraryError("not_found", "This skill's Doc no longer opens.")
    generationId = (
      await saveVersion({
        spaceId: target.doc.spaceId,
        path: location.path,
        createdBy: reader.actorId,
        source: "mcp",
        label: "Proposed library skill",
      })
    ).generationId
  }
  const entry = await changeLibrary((file, now) => {
    const entry = entryById(file, target.id)
    if (entry.removed) throw new LibraryError("not_found", `No skill named ${name} applies to you.`)
    if (input.remove && !entry.live) {
      throw new LibraryError("conflict", `${name} isn't live yet; a person can discard its proposal.`)
    }
    entry.proposal = {
      kind: input.remove ? "remove" : entry.live ? "update" : "add",
      ...(generationId ? { generationId } : {}),
      ...(description ? { description } : {}),
      by,
      at: now,
    }
    touched(entry)
    return entry
  })
  return proposalResult(entry, agentLabel(entry.library, spaces))
}

async function proposeAdd(
  reader: SkillReader,
  input: ProposalInput,
  by: LibraryProposal["by"]
) {
  if (!input.spaceId) throw new LibraryError("invalid", "Adding a Doc needs spaceId and path.")
  if (!input.library) {
    throw new LibraryError("invalid", "Adding a Doc needs library: worktable, space or agent.")
  }
  const spaceId = input.spaceId
  const library: LibraryRef =
    input.library === "worktable"
      ? { kind: "worktable" }
      : input.library === "space"
        ? { kind: "space", spaceId }
        : { kind: "agent", participantId: by.participantId }
  requireAgentMayPropose(library, reader, { spaceId })
  const description = checkedDescription(input.description)
  const current = await currentSkillDoc(spaceId, input.path!)
  const name = checkedName(input.name ?? skillNameFrom(current.path.split("/").at(-1) ?? ""))
  assertNameFree(readLibrary(), library, name)
  const saved = await saveVersion({
    spaceId,
    path: current.path,
    createdBy: reader.actorId,
    source: "mcp",
    label: "Proposed library skill",
  })
  const spaces = await spaceNames(library.kind === "space" ? [spaceId] : [])
  const entry = await changeLibrary((file, now) => {
    assertNameFree(file, library, name)
    const created: LibraryEntry = {
      id: mintEntryId(),
      name,
      description,
      library,
      doc: { spaceId, documentId: saved.documentId },
      live: null,
      proposal: { kind: "add", generationId: saved.generationId, by, at: now },
      removed: null,
      revision: 1,
    }
    file.entries.push(created)
    return created
  })
  return proposalResult(entry, agentLabel(entry.library, spaces))
}
