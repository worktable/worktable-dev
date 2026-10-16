import { readFileSync, statSync } from "node:fs"
import { chmod, mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  EMPTY_PERSONAL_NAVIGATION,
  PersonalNavigationSchema,
  type PersonalNavigation,
} from "@worktable/types"
import { ensureAppDir, getAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { logError } from "./debug-log.ts"
import { workspaceCacheKey } from "./workspace.ts"

/**
 * Each person's own preferences for this Worktable, keyed by participant key.
 * They are private and per machine, so they live in the app directory beside
 * the participant bindings, never in the portable workspace.
 */
interface PreferencesFile {
  type: "worktable.personal-preferences"
  version: 1
  people: Record<string, { navigation?: PersonalNavigation }>
}

function emptyFile(): PreferencesFile {
  return { type: "worktable.personal-preferences", version: 1, people: {} }
}

function preferencesPath(appDir = getAppDir()): string {
  return join(appDir, "participants", `${workspaceCacheKey()}.preferences.json`)
}

function parsePreferences(text: string): PreferencesFile {
  const parsed = JSON.parse(text) as Partial<PreferencesFile> | null
  if (
    parsed?.type !== "worktable.personal-preferences" ||
    parsed.version !== 1 ||
    !parsed.people ||
    typeof parsed.people !== "object"
  ) {
    throw new Error("Invalid personal preferences file")
  }
  const people: PreferencesFile["people"] = {}
  for (const [key, entry] of Object.entries(parsed.people)) {
    const navigation = PersonalNavigationSchema.safeParse(entry?.navigation)
    people[key] = navigation.success ? { navigation: navigation.data } : {}
  }
  return { type: "worktable.personal-preferences", version: 1, people }
}

// Every write replaces the file through a rename, so a new inode marks a new
// version and the read path costs one stat.
let cached: { path: string; stamp: string; file: PreferencesFile } | null = null

function readPreferences(): PreferencesFile {
  const path = preferencesPath()
  const info = statSync(path, { throwIfNoEntry: false })
  if (!info) return emptyFile()
  const stamp = `${info.ino}:${info.size}:${info.mtimeMs}`
  if (cached?.path === path && cached.stamp === stamp) return cached.file
  const file = parsePreferences(readFileSync(path, "utf8"))
  cached = { path, stamp, file }
  return file
}

let tmpCounter = 0

async function savePreferences(file: PreferencesFile): Promise<void> {
  const path = preferencesPath(ensureAppDir())
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8")
  await chmod(tmp, 0o600)
  await rename(tmp, path)
  cached = null
}

let mutationQueue: Promise<unknown> = Promise.resolve()

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const locked = () =>
    withCrossProcessLock(
      `${preferencesPath(ensureAppDir())}.lock`,
      { label: "Personal preferences" },
      fn
    )
  const next = mutationQueue.then(locked, locked)
  mutationQueue = next.catch(() => undefined)
  return next
}

/** What the person may see: Spaces they can no longer read stay stored but unnamed. */
function visible(
  navigation: PersonalNavigation,
  canRead: (spaceId: string) => boolean
): PersonalNavigation {
  return {
    revision: navigation.revision,
    groups: navigation.groups,
    spaceGroups: Object.fromEntries(
      Object.entries(navigation.spaceGroups).filter(([spaceId]) =>
        canRead(spaceId)
      )
    ),
    pins: navigation.pins.filter(canRead),
  }
}

/**
 * The person's saved navigation, or null when they have not arranged anything
 * yet and the client offers its starting arrangement.
 */
export function readPersonalNavigation(
  personKey: string,
  canRead: (spaceId: string) => boolean
): PersonalNavigation | null {
  let navigation: PersonalNavigation | undefined
  try {
    navigation = readPreferences().people[personKey]?.navigation
  } catch (error) {
    // An unreadable file must not keep the app from starting; the next save
    // reports it.
    console.warn("[preferences] personal preferences are unreadable:", logError(error))
    return null
  }
  return navigation ? visible(navigation, canRead) : null
}

export type SavePersonalNavigationResult =
  | { saved: true; navigation: PersonalNavigation }
  | { saved: false; current: PersonalNavigation }

/**
 * Replace the person's navigation if nobody saved since `expectedRevision`.
 * Entries for Spaces they cannot read right now are kept, so access that
 * returns brings their arrangement back.
 */
export function savePersonalNavigation(
  personKey: string,
  expectedRevision: number,
  next: Omit<PersonalNavigation, "revision">,
  canRead: (spaceId: string) => boolean
): Promise<SavePersonalNavigationResult> {
  return serialized(async () => {
    cached = null
    const file = readPreferences()
    const stored =
      file.people[personKey]?.navigation ?? EMPTY_PERSONAL_NAVIGATION
    if (stored.revision !== expectedRevision) {
      return { saved: false, current: visible(stored, canRead) }
    }
    const groupIds = new Set(next.groups.map((group) => group.id))
    const hiddenAssignments = Object.entries(stored.spaceGroups).filter(
      ([spaceId, groupId]) => !canRead(spaceId) && groupIds.has(groupId)
    )
    const pins = next.pins.filter(canRead)
    for (const spaceId of stored.pins) {
      if (!canRead(spaceId) && !pins.includes(spaceId)) pins.push(spaceId)
    }
    const navigation: PersonalNavigation = {
      revision: stored.revision + 1,
      groups: next.groups,
      spaceGroups: {
        ...Object.fromEntries(hiddenAssignments),
        ...Object.fromEntries(
          Object.entries(next.spaceGroups).filter(([spaceId]) =>
            canRead(spaceId)
          )
        ),
      },
      pins,
    }
    file.people[personKey] = { ...file.people[personKey], navigation }
    await savePreferences(file)
    return { saved: true, navigation: visible(navigation, canRead) }
  })
}
