import { readFileSync } from "node:fs"
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

function readFromDisk(path: string): PreferencesFile {
  try {
    return parsePreferences(readFileSync(path, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile()
    throw new PreferencesUnreadableError()
  }
}

/** The preferences file exists but cannot be read or parsed. */
export class PreferencesUnreadableError extends Error {
  readonly code = "PREFERENCES_UNREADABLE"
  constructor() {
    super("Personal preferences can't be read")
  }
}

// Only this server writes the file, so it is read once and then kept current
// by its own saves: the summary every page carries costs no file I/O.
let cached: { path: string; file: PreferencesFile } | null = null

function readPreferences(): PreferencesFile {
  const path = preferencesPath()
  if (cached?.path !== path) cached = { path, file: readFromDisk(path) }
  return cached.file
}

let tmpCounter = 0

async function savePreferences(file: PreferencesFile): Promise<void> {
  const path = preferencesPath(ensureAppDir())
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8")
  await chmod(tmp, 0o600)
  await rename(tmp, path)
  cached = { path: preferencesPath(), file }
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
  /** With the entries kept for other Spaces, it would exceed the limits. */
  | { saved: false; tooLarge: true }

/**
 * Replace the person's navigation if nobody saved since `expectedRevision`.
 * `knownSpaces` are the Spaces the client could show when it made the
 * change. Entries for any other Space, such as one the person cannot read
 * now or could not read when the client loaded, are kept, so access that
 * returns brings their arrangement back. Entries for Spaces that no longer
 * exist are dropped, so a later Space with the same id starts fresh.
 */
export function savePersonalNavigation(
  personKey: string,
  expectedRevision: number,
  next: Omit<PersonalNavigation, "revision">,
  knownSpaces: readonly string[],
  canRead: (spaceId: string) => boolean,
  existingSpaces: readonly string[]
): Promise<SavePersonalNavigationResult> {
  return serialized(async () => {
    const path = preferencesPath()
    const file = readFromDisk(path)
    cached = { path, file }
    const stored =
      file.people[personKey]?.navigation ?? EMPTY_PERSONAL_NAVIGATION
    if (stored.revision !== expectedRevision) {
      return { saved: false, current: visible(stored, canRead) }
    }
    const exists = new Set(existingSpaces)
    const known = new Set(knownSpaces)
    const kept = (spaceId: string) =>
      exists.has(spaceId) && (!canRead(spaceId) || !known.has(spaceId))
    const chosen = (spaceId: string) =>
      exists.has(spaceId) && canRead(spaceId) && known.has(spaceId)
    const groupIds = new Set(next.groups.map((group) => group.id))
    const pins = next.pins.filter(chosen)
    for (const spaceId of stored.pins) {
      if (kept(spaceId) && !pins.includes(spaceId)) pins.push(spaceId)
    }
    const navigation: PersonalNavigation = {
      revision: stored.revision + 1,
      groups: next.groups,
      spaceGroups: {
        ...Object.fromEntries(
          Object.entries(stored.spaceGroups).filter(
            ([spaceId, groupId]) => kept(spaceId) && groupIds.has(groupId)
          )
        ),
        ...Object.fromEntries(
          Object.entries(next.spaceGroups).filter(([spaceId]) => chosen(spaceId))
        ),
      },
      pins,
    }
    // Kept entries count too; a file that breaks the schema would be dropped
    // on its next read, so refuse instead of writing it.
    if (!PersonalNavigationSchema.safeParse(navigation).success) {
      return { saved: false, tooLarge: true }
    }
    file.people[personKey] = { ...file.people[personKey], navigation }
    await savePreferences(file)
    return { saved: true, navigation: visible(navigation, canRead) }
  })
}
