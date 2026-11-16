// The team's Library skills as OpenClaw skills.
//
// Each skill the Library has for this agent is written as a skill in a folder
// that connecting adds to OpenClaw's skills.load.extraDirs, so OpenClaw lists
// it with its other skills, by when to use it. The skill itself stays in
// Worktable: what OpenClaw gets is a pointer that reads the approved version
// with worktable_skills_read. OpenClaw watches the folder, so a refresh shows
// on the next turn.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths"

export interface LibrarySkill {
  name: string
  description: string
  /** Its library, when skills in more than one library share the name. */
  read?: { library: "worktable" | "space" | "agent"; spaceId?: string }
  /** The library's name, as Worktable lists it. */
  library?: string
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Where the pointers live: the folder connecting adds to extraDirs. */
export function libraryFolder(env?: NodeJS.ProcessEnv): string {
  return join(resolveStateDir(env), "plugins", "worktable", "library")
}

const LIBRARIES = new Set(["worktable", "space", "agent"])

/** What worktable_skills_read reads a skill by. */
function selector(skill: LibrarySkill): Record<string, string> {
  return { name: skill.name, ...(skill.read ?? {}) }
}

/**
 * The name OpenClaw lists a skill by: its own, or with its library added
 * when skills in more than one library share it.
 */
export function listedName(skill: LibrarySkill): string {
  if (!skill.read) return skill.name
  const words = (skill.library ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []
  return [skill.name, ...words].join("-")
}

/** Skills as worktable_skills_read lists them, keeping only what a pointer needs. */
export function librarySkillsFrom(state: Record<string, unknown>): LibrarySkill[] {
  const skills = Array.isArray(state.skills) ? state.skills : []
  const named = new Map<string, LibrarySkill>()
  for (const listed of skills) {
    const skill = (listed ?? {}) as Partial<LibrarySkill>
    if (typeof skill.name !== "string" || !NAME.test(skill.name)) continue
    const read = skill.read && LIBRARIES.has(skill.read.library) ? skill.read : undefined
    const kept: LibrarySkill = {
      name: skill.name,
      description: typeof skill.description === "string" ? skill.description : "",
      ...(read
        ? {
            read: { library: read.library, ...(typeof read.spaceId === "string" ? { spaceId: read.spaceId } : {}) },
            library: typeof skill.library === "string" ? skill.library : "",
          }
        : {}),
    }
    // A name two libraries share lists once per library, each read from its own.
    const name = listedName(kept)
    if (!named.has(name)) named.set(name, kept)
  }
  return [...named.values()]
}

/** A skill's SKILL.md for OpenClaw: its name, when to use it, and where it is. */
export function pointer(skill: LibrarySkill): string {
  const description = skill.description.replace(/\s+/g, " ").trim()
  const name = listedName(skill)
  const args = Object.entries(selector(skill))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(", ")
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${name}`,
    "",
    `Your team approved this skill in its Worktable Library as its agreed way to do this work. Read the current version with the worktable_skills_read tool (${args}) and follow it, over your own approach and over other Docs.`,
    "",
    "This file only points there. Propose a change in Worktable with worktable_skills_write; editing this file changes nothing.",
    "",
  ].join("\n")
}

/** The Library changes when a person approves something: soon is enough. */
export const REFRESH_MS = 15 * 60 * 1000
export const FIRST_RETRY_MS = 5 * 1000

/** Keeps the folder of pointers current in the background. */
export class LibrarySkillFolder {
  #timer: ReturnType<typeof setTimeout> | undefined
  #stopped = false
  readonly #folder: string
  readonly #load: () => Promise<LibrarySkill[]>

  constructor(folder: string, load: () => Promise<LibrarySkill[]>) {
    this.#folder = folder
    this.#load = load
  }

  /** Ask Worktable now and match the folder. False when it couldn't answer. */
  async refresh(): Promise<boolean> {
    let skills: LibrarySkill[]
    try {
      skills = await this.#load()
    } catch {
      return false
    }
    await mkdir(this.#folder, { recursive: true })
    const wanted = new Set(skills.map(listedName))
    for (const skill of skills) {
      const path = join(this.#folder, listedName(skill), "SKILL.md")
      const text = pointer(skill)
      // Unchanged pointers aren't rewritten, so OpenClaw's watcher stays quiet.
      if ((await readFile(path, "utf8").catch(() => null)) === text) continue
      await mkdir(join(this.#folder, listedName(skill)), { recursive: true })
      await writeFile(path, text, "utf8")
    }
    for (const entry of await readdir(this.#folder, { withFileTypes: true })) {
      if (entry.isDirectory() && !wanted.has(entry.name)) {
        await rm(join(this.#folder, entry.name), { recursive: true, force: true })
      }
    }
    return true
  }

  /** Refresh now and every REFRESH_MS; a failure is tried again sooner. */
  start(): void {
    let retry = FIRST_RETRY_MS
    const tick = async () => {
      if (this.#stopped) return
      const answered = await this.refresh().catch(() => false)
      const wait = answered ? REFRESH_MS : retry
      retry = answered ? FIRST_RETRY_MS : Math.min(retry * 2, REFRESH_MS)
      if (this.#stopped) return
      this.#timer = setTimeout(() => void tick(), wait)
      // A pending refresh never keeps OpenClaw's process alive.
      ;(this.#timer as { unref?: () => void }).unref?.()
    }
    void tick()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
  }
}
