// ============================================================
// Telling agents their skills changed
// ============================================================
//
// On the preview surface, worktable_state lists the skills that apply to an
// agent. Agents that never call it still learn of them: the first tool call
// of a session (after a break of SESSION_GAP_MS) carries one line naming the
// skills that apply, and a later call carries one line when they changed
// since the agent last saw them. What each agent last saw, and when it last
// called, is kept per participant in a small private file in app storage.

import { readFileSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getAppDir } from "./app-storage.ts"
import { logError } from "./debug-log.ts"
import {
  applicableVersions,
  REMOVED_MARK,
  REMOVED_SKILL_NOTE,
  skillsForAgent,
  skillVersion,
  type AgentSkill,
  type LibraryEntry,
  type SkillReader,
} from "./skill-libraries.ts"
import { workspaceCacheKey } from "./workspace.ts"

/** What the Library is, said once when an agent first learns its skills. */
export const LIBRARY_FOR_AGENTS =
  "The Library is your team's approved Docs: a person reviewed each one for agents to follow. Prefer a skill there over other Docs on the same work; Docs elsewhere may be drafts."

/** The most skills worktable_state lists. */
export const STATE_SKILL_LIMIT = 50
/** The most names a notice names for each kind of change. */
const NOTICE_NAMES = 5
const REMOVED = REMOVED_MARK
/** A call this long after the agent's last one starts a new session. */
export const SESSION_GAP_MS = 30 * 60 * 1000
/** Last-call times are saved when they move this far, not on every call. */
const CALL_SAVE_STEP_MS = 5 * 60 * 1000

/** Calls that never carry the notice: state lists the skills itself. */
const QUIET_OPERATIONS = new Set([
  "workspace.state",
  "workspace.pending",
  "threads.wait",
  "thread_delivery.register_participant",
  "thread_delivery.claim",
  "thread_delivery.accept",
  "thread_delivery.progress",
  "thread_delivery.fail",
])

interface SeenFile {
  type: "worktable.skill-seen"
  version: 1
  /** By participant: each entry's live version when last seen, or "removed". */
  participants: Record<string, Record<string, string>>
  /** By participant: when it last called, in epoch milliseconds. */
  lastCallAt?: Record<string, number>
}

let seen: { path: string; file: SeenFile } | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveCounter = 0
/** Last calls in this process, ahead of what was saved. */
const calls = new Map<string, number>()

function seenPath(): string {
  return join(getAppDir(), "skills", `${workspaceCacheKey()}.json`)
}

function seenFile(): SeenFile {
  const path = seenPath()
  if (seen?.path === path) return seen.file
  let file: SeenFile = { type: "worktable.skill-seen", version: 1, participants: {}, lastCallAt: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SeenFile>
    if (parsed?.type === "worktable.skill-seen" && parsed.version === 1 && parsed.participants) {
      file = {
        type: "worktable.skill-seen",
        version: 1,
        participants: parsed.participants,
        lastCallAt: parsed.lastCallAt ?? {},
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[skills] starting new seen marks:", logError(error))
    }
  }
  seen = { path, file }
  calls.clear()
  return file
}

async function saveNow(): Promise<void> {
  if (!seen) return
  const { path, file } = seen
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${(saveCounter += 1)}`
  await writeFile(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void saveNow().catch((error: unknown) => {
      console.error("[skills] could not save seen marks:", logError(error))
    })
  }, 250)
  saveTimer.unref?.()
}

/** Write the seen marks now, as at shutdown. */
export async function saveSkillSeenMarks(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  await saveNow()
}

function marksFor(participantId: string): Record<string, string> | undefined {
  return seenFile().participants[participantId]
}

function sameMarks(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  if (!a) return Object.keys(b).length === 0
  const keys = Object.keys(b)
  return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key])
}

/** Record what the agent has now seen, saving only a real change. */
function setMarks(participantId: string, marks: Record<string, string>): void {
  if (sameMarks(marksFor(participantId), marks)) return
  seenFile().participants[participantId] = marks
  scheduleSave()
}

/**
 * Note a call now and say whether it starts a session: the agent's first call
 * here, or its first after a break. Synchronous, so of two calls arriving
 * together only the first starts the session.
 */
function noteCall(participantId: string, now: number): boolean {
  const file = seenFile()
  const last = calls.get(participantId) ?? file.lastCallAt?.[participantId]
  calls.set(participantId, now)
  const saved = file.lastCallAt?.[participantId]
  if (saved === undefined || now - saved >= CALL_SAVE_STEP_MS) {
    file.lastCallAt = { ...file.lastCallAt, [participantId]: now }
    scheduleSave()
  }
  return last === undefined || now - last >= SESSION_GAP_MS
}

function marksOf(live: AgentSkill[], removed: Array<{ entry: LibraryEntry }>): Record<string, string> {
  const marks: Record<string, string> = {}
  for (const skill of live) marks[skill.entry.id] = skill.live.generationId
  for (const { entry } of removed) marks[entry.id] = REMOVED
  return marks
}

/** worktable_state's skills, which the agent has now seen. */
export async function stateSkills(reader: SkillReader, spaceId?: string) {
  if (reader.participantId) noteCall(reader.participantId, Date.now())
  const { live, removed } = await skillsForAgent(reader, { spaceId })
  const shown = live.slice(0, STATE_SKILL_LIMIT)
  if (reader.participantId && (shown.length > 0 || removed.length > 0)) {
    // Merged after the wait, so a change seen meanwhile isn't undone.
    const marks = { ...marksFor(reader.participantId), ...marksOf(shown, removed) }
    setMarks(reader.participantId, marks)
  }
  return {
    skills: shown.map((skill) => ({
      name: skill.entry.name,
      description: skill.entry.description,
      library: skill.library,
      version: skillVersion(skill.live.generationId),
    })),
    ...(live.length > shown.length ? { moreSkills: live.length - shown.length } : {}),
    ...(removed.length > 0
      ? {
          removedSkills: removed.map(({ entry, library }) => ({
            name: entry.name,
            library,
            note: REMOVED_SKILL_NOTE,
          })),
        }
      : {}),
  }
}

function named(names: string[]): string {
  const listed = names.slice(0, NOTICE_NAMES).join(", ")
  return names.length > NOTICE_NAMES ? `${listed} and ${names.length - NOTICE_NAMES} more` : listed
}

function removedPart(gone: LibraryEntry[]): string[] {
  if (gone.length === 1) return [`removed ${gone[0]!.name} (removed from its library, so it no longer applies)`]
  if (gone.length > 1) {
    return [`removed ${named(gone.map((entry) => entry.name))} (removed from their libraries, so they no longer apply)`]
  }
  return []
}

/**
 * One line for an agent's tool call, or null: at the start of a session, the
 * skills that apply to it; later, what changed since it last saw them. Seeing
 * the line counts as seeing the skills.
 */
export async function skillChangeNotice(
  reader: SkillReader,
  operationId: string
): Promise<string | null> {
  try {
    if (!reader.participantId || QUIET_OPERATIONS.has(operationId)) return null
    const participantId = reader.participantId
    const sessionStart = noteCall(participantId, Date.now())
    // The cheap check: nothing changed and no session starts, so no file is read.
    const versions = applicableVersions(reader)
    const known = marksFor(participantId)
    if (!sessionStart && sameMarks(known, Object.fromEntries(versions))) return null
    if (versions.size === 0 && !known) return null
    const { live, removed } = await skillsForAgent(reader)
    // What the agent saw is read after the wait: a parallel call may have
    // shown it this change already.
    const before = marksFor(participantId)
    const added: AgentSkill[] = []
    const updated: AgentSkill[] = []
    for (const skill of live) {
      const last = before?.[skill.entry.id]
      if (last === undefined || last === REMOVED) added.push(skill)
      else if (last !== skill.live.generationId) updated.push(skill)
    }
    const gone: LibraryEntry[] = []
    for (const { entry } of removed) {
      const last = before?.[entry.id]
      if (last !== undefined && last !== REMOVED) gone.push(entry)
    }
    // Skills whose Doc no longer opens keep their version too, so the cheap
    // check keeps matching instead of resolving on every call.
    setMarks(participantId, { ...Object.fromEntries(versions), ...marksOf(live, removed) })
    if (sessionStart || !before) {
      if (live.length === 0 && gone.length === 0) return null
      const parts = [
        ...(live.length ? [`Skills in it that apply to you: ${named(live.map((skill) => skill.entry.name))}`] : []),
        ...(updated.length ? [`updated since you last saw them: ${named(updated.map((skill) => skill.entry.name))}`] : []),
        ...removedPart(gone),
      ]
      return `${LIBRARY_FOR_AGENTS} ${parts.join("; ")}. worktable_skills_read returns the current ones.`
    }
    const parts = [
      ...(updated.length ? [`updated ${named(updated.map((skill) => skill.entry.name))}`] : []),
      ...(added.length ? [`added ${named(added.map((skill) => skill.entry.name))}`] : []),
      ...removedPart(gone),
    ]
    if (parts.length === 0) return null
    return `Your team's Library changed: ${parts.join("; ")}. worktable_skills_read returns the current ones.`
  } catch (error) {
    console.error("[skills] could not add the skills notice:", logError(error))
    return null
  }
}
