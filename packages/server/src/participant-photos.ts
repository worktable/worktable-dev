import { readFileSync } from "node:fs"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  IDENTITY_IMAGE_MAX_BYTES,
  IDENTITY_IMAGE_TYPES,
  isImageHash,
  type IdentityImageType,
} from "@worktable/types"
import { ensureAppDir, getAppDir } from "./app-storage.ts"
import { atomicWriteText, atomicWriteBytes } from "./atomic-file.ts"
import { logError } from "./debug-log.ts"
import {
  acceptIdentityImage,
  IDENTITY_IMAGE_EXTENSIONS,
  readBoundedStream,
  type IdentityImage,
} from "./identity-images.ts"
import { listSpaces } from "./store.ts"
import { workspaceCacheKey } from "./workspace.ts"
import { notifyWorkspaceChange } from "./workspace-events.ts"

/**
 * People's photos in this Worktable. Each person sets their own here, as
 * they set their display name; a Cloud sign-in's photo is used until they do.
 * Like participant bindings, they live with this install's app data.
 */

interface PhotoEntry {
  hash: string
  type: IdentityImageType
  source: "upload" | "sign-in"
  updatedAt: string
}

interface PhotosFile {
  type: "worktable.participant-photos"
  version: 1
  photos: Record<string, PhotoEntry>
  /** The sign-in photo last taken for each person, so it is fetched once. */
  signIn: Record<string, { url: string; removed?: boolean }>
}

const PARTICIPANT_ID = /^ptc_[A-Za-z0-9_-]{1,64}$/

export function isParticipantId(value: string): boolean {
  return PARTICIPANT_ID.test(value)
}

function baseDir(appDir: string): string {
  return join(appDir, "participants")
}

function indexPath(appDir = getAppDir()): string {
  return join(baseDir(appDir), `${workspaceCacheKey()}.photos.json`)
}

function imageDir(appDir = getAppDir()): string {
  return join(baseDir(appDir), `${workspaceCacheKey()}.photos`)
}

function imagePath(participantId: string, entry: PhotoEntry): string {
  return join(
    imageDir(),
    `${participantId}-${entry.hash}.${IDENTITY_IMAGE_EXTENSIONS[entry.type]}`
  )
}

function emptyFile(): PhotosFile {
  return { type: "worktable.participant-photos", version: 1, photos: {}, signIn: {} }
}

function parse(text: string): PhotosFile {
  const parsed = JSON.parse(text) as Partial<PhotosFile>
  if (parsed.type !== "worktable.participant-photos" || parsed.version !== 1) {
    return emptyFile()
  }
  const photos: Record<string, PhotoEntry> = {}
  for (const [id, entry] of Object.entries(parsed.photos ?? {})) {
    if (
      isParticipantId(id) &&
      isImageHash(entry?.hash) &&
      IDENTITY_IMAGE_TYPES.includes(entry.type) &&
      (entry.source === "upload" || entry.source === "sign-in")
    ) {
      photos[id] = entry
    }
  }
  const signIn: PhotosFile["signIn"] = {}
  for (const [id, entry] of Object.entries(parsed.signIn ?? {})) {
    if (isParticipantId(id) && typeof entry?.url === "string") {
      signIn[id] = { url: entry.url, ...(entry.removed ? { removed: true } : {}) }
    }
  }
  return { type: "worktable.participant-photos", version: 1, photos, signIn }
}

// Read once and refreshed by this server's own saves, so the summaries that
// ride along with every page cost no file I/O.
let cache: { path: string; file: PhotosFile } | null = null

function current(): PhotosFile {
  const path = indexPath()
  if (cache?.path !== path) {
    let file = emptyFile()
    try {
      file = parse(readFileSync(path, "utf8"))
    } catch {
      // Missing or unreadable: nobody has a photo yet.
    }
    cache = { path, file }
  }
  return cache.file
}

let queue: Promise<unknown> = Promise.resolve()

/** Change the index one writer at a time, then tell open pages. */
function change(edit: (file: PhotosFile) => Promise<boolean>): Promise<void> {
  const run = async () => {
    const appDir = ensureAppDir()
    const path = indexPath(appDir)
    let file = emptyFile()
    try {
      file = parse(await readFile(path, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (!(await edit(file))) return
    await mkdir(baseDir(appDir), { recursive: true, mode: 0o700 })
    await atomicWriteText(path, `${JSON.stringify(file, null, 2)}\n`)
    cache = { path, file }
    notifyWorkspaceChange({ type: "participants" })
    for (const space of await listSpaces()) {
      notifyWorkspaceChange({ type: "participants", spaceId: space.id })
    }
  }
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

/** A person's current photo, named by its content. */
export function participantPhotoHash(participantId: string): string | null {
  return current().photos[participantId]?.hash ?? null
}

async function store(
  participantId: string,
  image: IdentityImage,
  source: PhotoEntry["source"],
  file: PhotosFile
): Promise<void> {
  const previous = file.photos[participantId]
  const entry: PhotoEntry = {
    hash: image.hash,
    type: image.type,
    source,
    updatedAt: new Date().toISOString(),
  }
  await mkdir(imageDir(), { recursive: true, mode: 0o700 })
  await atomicWriteBytes(imagePath(participantId, entry), image.bytes)
  file.photos[participantId] = entry
  if (previous && previous.hash !== entry.hash) {
    await rm(imagePath(participantId, previous), { force: true })
  }
}

/** Set the photo a person chose. */
export function setParticipantPhoto(
  participantId: string,
  image: IdentityImage
): Promise<void> {
  return change(async (file) => {
    await store(participantId, image, "upload", file)
    return true
  })
}

/**
 * Remove a person's photo. A sign-in photo they removed stays removed, until
 * the sign-in brings a different one.
 */
export function removeParticipantPhoto(
  participantId: string,
  /** Their current sign-in photo, which must not come back in its place. */
  signInUrl?: string
): Promise<void> {
  return change(async (file) => {
    const previous = file.photos[participantId]
    const url = signInUrl ?? file.signIn[participantId]?.url
    if (!previous && !url) return false
    if (previous) await rm(imagePath(participantId, previous), { force: true })
    delete file.photos[participantId]
    if (url) file.signIn[participantId] = { url, removed: true }
    return true
  })
}

/** The photo's bytes when `hash` names the person's current one. */
export async function readParticipantPhoto(
  participantId: string,
  hash: string
): Promise<{ bytes: Uint8Array; type: IdentityImageType } | null> {
  const entry = current().photos[participantId]
  if (!entry || entry.hash !== hash) return null
  try {
    return { bytes: new Uint8Array(await readFile(imagePath(participantId, entry))), type: entry.type }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

const adopting = new Set<string>()
let fetchForTests: typeof fetch | null = null

export function setSignInPhotoFetchForTests(value: typeof fetch | null): void {
  fetchForTests = value
}

/** Settles once photos already being taken from a sign-in are saved. */
export async function signInPhotosSettledForTests(): Promise<void> {
  while (adopting.size > 0) await new Promise((resolve) => setTimeout(resolve, 5))
  await queue
}

/** A failure worth trying again on a later page, such as a network error. */
class TransientPhotoError extends Error {}

const MAX_REDIRECTS = 3

/** Fetch a sign-in photo, following only https redirects. */
async function download(url: URL): Promise<Uint8Array> {
  let address = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response
    try {
      response = await (fetchForTests ?? fetch)(address.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
        headers: { Accept: "image/webp,image/png,image/jpeg" },
      })
    } catch (error) {
      throw new TransientPhotoError(error instanceof Error ? error.message : "fetch failed")
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location")
      await response.body?.cancel()
      if (!location) throw new Error("redirect without a location")
      address = new URL(location, address)
      if (address.protocol !== "https:") throw new Error("redirect left https")
      continue
    }
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel()
      throw new TransientPhotoError(`HTTP ${response.status}`)
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    let bytes: Uint8Array | null
    try {
      bytes = await readBoundedStream(response.body, IDENTITY_IMAGE_MAX_BYTES)
    } catch (error) {
      // A connection that drops or times out mid-photo may work next time.
      throw new TransientPhotoError(error instanceof Error ? error.message : "read failed")
    }
    if (!bytes) throw new Error("photo too large")
    return bytes
  }
  throw new Error("too many redirects")
}

/**
 * Use a person's sign-in photo when they have not set one. It is fetched
 * once, in the background, and never again for the same address, so the
 * request that noticed it does not wait and viewers never ask the provider.
 */
export function adoptSignInPhoto(participantId: string, url: string): void {
  if (!isParticipantId(participantId) || adopting.has(participantId)) return
  const file = current()
  if (file.photos[participantId]?.source === "upload") return
  if (file.signIn[participantId]?.url === url) return
  let address: URL
  try {
    address = new URL(url)
  } catch {
    return
  }
  if (address.protocol !== "https:") return
  adopting.add(participantId)
  void (async () => {
    try {
      const image = acceptIdentityImage(await download(address))
      await change(async (latest) => {
        // They chose their own, or removed this one, while it was loading.
        if (latest.photos[participantId]?.source === "upload") return false
        if (latest.signIn[participantId]?.removed && latest.signIn[participantId]?.url === url) {
          return false
        }
        await store(participantId, image, "sign-in", latest)
        latest.signIn[participantId] = { url }
        return true
      })
    } catch (error) {
      if (error instanceof TransientPhotoError) {
        console.warn("Could not reach a sign-in photo; trying again later", logError(error))
        return
      }
      // Remember the address, so a broken photo is not fetched on every page.
      await change(async (latest) => {
        if (latest.signIn[participantId]?.url === url) return false
        latest.signIn[participantId] = { url }
        return true
      }).catch(() => undefined)
      console.warn("Could not take a photo from sign-in", logError(error))
    } finally {
      adopting.delete(participantId)
    }
  })()
}
