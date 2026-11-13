// ============================================================
// Telling agents their skills changed
// ============================================================
//
// On the preview surface, worktable_state lists the skills that apply to an
// agent. When they change after the agent last saw them, its next tool call
// says so in one line, once per change. What each agent last saw is kept per
// participant in a small private file in app storage, saved shortly after it
// changes.

import { readFileSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getAppDir } from "./app-storage.ts"
import { logError } from "./debug-log.ts"
import {
  REMOVED_SKILL_NOTE,
  skillsForAgent,
  skillVersion,
  type AgentSkill,
  type LibraryEntry,
  type SkillReader,
} from "./skill-libraries.ts"
import { workspaceCacheKey } from "./workspace.ts"

/** The most skills worktable_state lists. */
export const STATE_SKILL_LIMIT = 50
/** The most names a notice names for each kind of change. */
const NOTICE_NAMES = 5
const REMOVED = "removed"

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
}

let seen: { path: string; file: SeenFile } | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveCounter = 0

function seenPath(): string {
  return join(getAppDir(), "skills", `${workspaceCacheKey()}.json`)
}

function seenFile(): SeenFile {
  const path = seenPath()
  if (seen?.path === path) return seen.file
  let file: SeenFile = { type: "worktable.skill-seen", version: 1, participants: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SeenFile>
    if (parsed?.type === "worktable.skill-seen" && parsed.version === 1 && parsed.participants) {
      file = { type: "worktable.skill-seen", version: 1, participants: parsed.participants }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[skills] starting new seen marks:", logError(error))
    }
  }
  seen = { path, file }
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

function setMarks(participantId: string, marks: Record<string, string>): void {
  seenFile().participants[participantId] = marks
  scheduleSave()
}

/** worktable_state's skills, which the agent has now seen. */
export async function stateSkills(reader: SkillReader, spaceId?: string) {
  const { live, removed } = await skillsForAgent(reader, { spaceId })
  const shown = live.slice(0, STATE_SKILL_LIMIT)
  if (reader.participantId) {
    const marks = { ...marksFor(reader.participantId) }
    for (const skill of shown) marks[skill.entry.id] = skill.live.generationId
    for (const { entry } of removed) marks[entry.id] = REMOVED
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

/**
 * One line when the skills that apply to this agent changed since it last
 * saw them, or null. Seeing the line counts as seeing the change.
 */
export async function skillChangeNotice(
  reader: SkillReader,
  operationId: string
): Promise<string | null> {
  try {
    if (!reader.participantId || QUIET_OPERATIONS.has(operationId)) return null
    const before = marksFor(reader.participantId)
    const { live, removed } = await skillsForAgent(reader)
    if (live.length === 0 && removed.length === 0 && !before) return null
    const marks: Record<string, string> = {}
    const added: AgentSkill[] = []
    const updated: AgentSkill[] = []
    for (const skill of live) {
      marks[skill.entry.id] = skill.live.generationId
      const last = before?.[skill.entry.id]
      if (last === undefined || last === REMOVED) added.push(skill)
      else if (last !== skill.live.generationId) updated.push(skill)
    }
    const gone: LibraryEntry[] = []
    for (const { entry } of removed) {
      marks[entry.id] = REMOVED
      const last = before?.[entry.id]
      if (last !== undefined && last !== REMOVED) gone.push(entry)
    }
    const changed = added.length + updated.length + gone.length > 0
    if (changed || Object.keys(before ?? {}).length !== Object.keys(marks).length) {
      setMarks(reader.participantId, marks)
    }
    if (!changed) return null
    if (!before) {
      return `Skills from your team's Worktable libraries apply to you: ${named(added.map((skill) => skill.entry.name))}. worktable_skills_read returns the current ones.`
    }
    const parts = [
      ...(updated.length ? [`updated ${named(updated.map((skill) => skill.entry.name))}`] : []),
      ...(added.length ? [`added ${named(added.map((skill) => skill.entry.name))}`] : []),
      ...(gone.length === 1
        ? [`removed ${gone[0]!.name} (removed from its library, so it no longer applies)`]
        : gone.length > 1
          ? [`removed ${named(gone.map((entry) => entry.name))} (removed from their libraries, so they no longer apply)`]
          : []),
    ]
    return `Your team's Worktable skills changed: ${parts.join("; ")}. worktable_skills_read returns the current ones.`
  } catch (error) {
    console.error("[skills] could not add the skills notice:", logError(error))
    return null
  }
}
