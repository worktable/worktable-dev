// ============================================================
// A file's bytes at one revision
// ============================================================
//
// A file is resolved, and its revision read, while its Space's lock is held;
// its bytes are read after the lock is released, so a long transfer never
// holds up other work. The revision is the file's on-disk fingerprint: the
// file opens only at that revision, and every chunk read is checked against
// it, so bytes from two revisions never mix. A change partway fails the
// transfer instead.
//
// A file's content hash names its bytes in ETags. It is computed once per
// revision and kept, a bounded number at a time.

import type { BigIntStats } from "node:fs"
import { constants } from "node:fs"
import { lstat, open, type FileHandle } from "node:fs/promises"
import { createHash, type Hash } from "node:crypto"
import { sourceStampOf } from "./document-catalog.ts"

const SECURE_READ_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
/** The most one transfer holds in memory at once. */
export const FILE_READ_CHUNK_BYTES = 256 * 1024
/** Content hashes kept, by file and revision. */
const CONTENT_HASHES_MAX = 4096

/** The file changed, went away or can't be read as the revision it was. */
export class FileRevisionError extends Error {
  readonly reason: "changed" | "unreadable"
  constructor(reason: "changed" | "unreadable", message: string) {
    super(message)
    this.reason = reason
  }
}

/** A file's revision: what its metadata says its bytes are. */
export function fileRevisionOf(info: BigIntStats): string {
  return sourceStampOf(info)
}

/**
 * What an open file's bytes are: a write moves its modification time. Its
 * change time also moves when the file is only replaced or moved, which
 * leaves the bytes an open handle reads as they were.
 */
function contentStampOf(info: BigIntStats): string {
  return `${info.ino}.${info.size}.${info.mtimeNs}`
}

/** The revision of the file at `path` now, without opening it. */
export async function currentFileRevision(
  path: string
): Promise<{ revision: string; size: number }> {
  let info: BigIntStats
  try {
    info = await lstat(path, { bigint: true })
  } catch {
    throw new FileRevisionError("unreadable", "file is missing")
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new FileRevisionError("unreadable", "source is not a regular file")
  }
  return { revision: fileRevisionOf(info), size: Number(info.size) }
}

/** An open file at the revision it had when opened. */
export class OpenFileRevision {
  readonly revision: string
  readonly size: number
  readonly #handle: FileHandle
  readonly #content: string
  #closed = false

  private constructor(handle: FileHandle, info: BigIntStats) {
    this.#handle = handle
    this.revision = fileRevisionOf(info)
    this.size = Number(info.size)
    this.#content = contentStampOf(info)
  }

  /**
   * Open a regular file, never through a symlink. With `revision`, the file
   * must still be at it.
   */
  static async open(path: string, revision?: string): Promise<OpenFileRevision> {
    let handle: FileHandle
    try {
      handle = await open(path, SECURE_READ_FLAGS)
    } catch {
      throw new FileRevisionError("unreadable", "file could not be opened")
    }
    try {
      const [opened, reachable] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(path, { bigint: true }),
      ])
      if (
        !opened.isFile() ||
        reachable.isSymbolicLink() ||
        opened.dev !== reachable.dev ||
        opened.ino !== reachable.ino
      ) {
        throw new FileRevisionError("unreadable", "source is not a regular file")
      }
      const file = new OpenFileRevision(handle, opened)
      if (revision !== undefined && file.revision !== revision) {
        throw new FileRevisionError("changed", "file changed before it was opened")
      }
      return file
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error instanceof FileRevisionError
        ? error
        : new FileRevisionError("unreadable", "file could not be opened")
    }
  }

  /** Bytes at `position`, at most `length`, checked to be this revision's. */
  async read(position: number, length: number): Promise<Uint8Array> {
    if (this.#closed) throw new FileRevisionError("unreadable", "file is closed")
    const buffer = new Uint8Array(length)
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await this.#handle.read(
        buffer,
        filled,
        length - filled,
        position + filled
      )
      if (bytesRead === 0) break
      filled += bytesRead
    }
    const after = await this.#handle.stat({ bigint: true })
    if (filled !== length || contentStampOf(after) !== this.#content) {
      throw new FileRevisionError("changed", "file changed while it was read")
    }
    return buffer
  }

  /** The content hash of the whole file, read a chunk at a time. */
  async contentHash(): Promise<string> {
    const hash = createHash("sha256")
    for (let position = 0; position < this.size; ) {
      const chunk = await this.read(
        position,
        Math.min(FILE_READ_CHUNK_BYTES, this.size - position)
      )
      hash.update(chunk)
      position += chunk.byteLength
    }
    return hash.digest("base64url")
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#handle.close().catch(() => undefined)
  }
}

/** A file at a revision, by where it is: not yet open. */
export interface PinnedFile {
  path: string
  revision: string
  size: number
}

/**
 * Bytes `start` to `end` (exclusive) of a file at its revision, a chunk at
 * a time as they are read. The file opens on the first read, so a body
 * never read holds nothing open, and closes when the stream ends, fails or
 * is cancelled. `verify` sees every chunk, and one chunk is held back until
 * the next is read, so a failed check withholds the end of the bytes.
 */
export function pinnedFileStream(
  pinned: PinnedFile,
  start: number,
  end: number,
  verify?: { update(chunk: Uint8Array): void; ok(): boolean }
): ReadableStream<Uint8Array> {
  let file: OpenFileRevision | null = null
  let position = start
  let held: Uint8Array | null = null
  return new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        try {
          file ??= await OpenFileRevision.open(pinned.path, pinned.revision)
          for (;;) {
            if (position >= end) {
              if (verify && !verify.ok()) {
                throw new FileRevisionError("changed", "file bytes don't match their hash")
              }
              if (held) controller.enqueue(held)
              await file.close()
              controller.close()
              return
            }
            const chunk = await file.read(
              position,
              Math.min(FILE_READ_CHUNK_BYTES, end - position)
            )
            position += chunk.byteLength
            if (!verify) {
              controller.enqueue(chunk)
              return
            }
            verify.update(chunk)
            const previous = held
            held = chunk
            if (previous) {
              controller.enqueue(previous)
              return
            }
          }
        } catch (error) {
          await file?.close()
          controller.error(error)
        }
      },
      cancel: async () => {
        await file?.close()
      },
    },
    { highWaterMark: 0 }
  )
}

/** Checks a whole file's bytes against the sha256 recorded for them. */
export function sha256Check(hex: string): { update(chunk: Uint8Array): void; ok(): boolean } {
  const hash: Hash = createHash("sha256")
  return {
    update: (chunk) => void hash.update(chunk),
    ok: () => hash.digest("hex") === hex,
  }
}

/** A sha256 recorded as hex, as content hashes are written. */
export function contentHashFromHex(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64url")
}

const contentHashes = new Map<string, string>()

function hashKey(path: string, revision: string): string {
  return `${path}\0${revision}`
}

/** The content hash of the file at `path` at `revision`, if known. */
export function knownContentHash(path: string, revision: string): string | undefined {
  const key = hashKey(path, revision)
  const hash = contentHashes.get(key)
  if (hash !== undefined) {
    // Most recently used last, so the oldest goes first.
    contentHashes.delete(key)
    contentHashes.set(key, hash)
  }
  return hash
}

/** A file's content hash at its revision, read once per revision and kept. */
export async function contentHashOf(pinned: PinnedFile): Promise<string> {
  const known = knownContentHash(pinned.path, pinned.revision)
  if (known !== undefined) return known
  const file = await OpenFileRevision.open(pinned.path, pinned.revision)
  let hash: string
  try {
    hash = await file.contentHash()
  } finally {
    await file.close()
  }
  if (contentHashes.size >= CONTENT_HASHES_MAX) {
    const oldest = contentHashes.keys().next().value
    if (oldest !== undefined) contentHashes.delete(oldest)
  }
  contentHashes.set(hashKey(pinned.path, pinned.revision), hash)
  return hash
}
