// ============================================================
// Files staged on disk before they are saved
// ============================================================
//
// An upload's bytes are written here as they arrive and hashed on the way,
// so no transfer holds a whole file in memory and nothing hashes them again.
// The write service copies a staged file, a chunk at a time, into a version
// and into the file's place; the staged copy is removed after, whether the
// save worked or not. Staged files live in app storage, where neither an
// export nor the catalog looks, and leftovers from a server that stopped
// partway are removed when the next one starts.

import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, readdir, rm, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { getAppDir } from "./app-storage.ts"

/** The most a staged file's copy or hash holds in memory at once. */
const STAGED_CHUNK_BYTES = 256 * 1024
const STAGED_NAME = /^(\d+)-[0-9a-f]{32}\.staged$/
const CREATE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0)
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

/** A complete staged file: its bytes are on disk at `path`. */
export interface StagedFile {
  readonly path: string
  readonly byteLength: number
  /** The sha256 of its bytes, as hex, computed as they were written. */
  readonly sha256: string
}

/** Staged files this process is writing or still holds, and their sizes. */
const live = new Map<string, number>()

/** What staged files this process holds take on disk, for storage usage. */
export function stagedFilesInProgress(): { bytes: number; files: number } {
  let bytes = 0
  for (const size of live.values()) bytes += size
  return { bytes, files: live.size }
}

/** Where staged files are kept, in app storage. */
export function stagingDirectory(): string {
  return join(getAppDir(), "staged-files")
}

/** A staged file being written, a chunk at a time, in order. */
export class StagingFile {
  readonly path: string
  readonly #handle: FileHandle
  readonly #hash = createHash("sha256")
  #byteLength = 0
  #closed = false

  private constructor(path: string, handle: FileHandle) {
    this.path = path
    this.#handle = handle
  }

  static async create(): Promise<StagingFile> {
    const directory = stagingDirectory()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(
      directory,
      `${process.pid}-${randomBytes(16).toString("hex")}.staged`
    )
    const handle = await open(path, CREATE_FLAGS, 0o600)
    live.set(path, 0)
    return new StagingFile(path, handle)
  }

  get byteLength(): number {
    return this.#byteLength
  }

  async append(chunk: Uint8Array): Promise<void> {
    for (let written = 0; written < chunk.byteLength; ) {
      const { bytesWritten } = await this.#handle.write(
        chunk,
        written,
        chunk.byteLength - written
      )
      written += bytesWritten
    }
    this.#hash.update(chunk)
    this.#byteLength += chunk.byteLength
    if (live.has(this.path)) live.set(this.path, this.#byteLength)
  }

  /** Close it: its bytes are complete. */
  async finish(): Promise<StagedFile> {
    this.#closed = true
    await this.#handle.close()
    return {
      path: this.path,
      byteLength: this.#byteLength,
      sha256: this.#hash.digest("hex"),
    }
  }

  async discard(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true
      await this.#handle.close().catch(() => undefined)
    }
    await discardStagedFile(this)
  }
}

export async function discardStagedFile(file: { path: string }): Promise<void> {
  await rm(file.path, { force: true }).catch(() => undefined)
  live.delete(file.path)
}

/**
 * A staged file's bytes, a chunk at a time to `onChunk`, which is awaited
 * before the next is read and must not keep the chunk. Fails if the file
 * isn't the size it was staged at.
 */
export async function readStagedFile(
  file: StagedFile,
  onChunk: (chunk: Uint8Array) => void | Promise<void>
): Promise<void> {
  const handle = await open(file.path, READ_FLAGS)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size !== file.byteLength) {
      throw new Error("staged file changed after it was staged")
    }
    const buffer = new Uint8Array(
      Math.min(STAGED_CHUNK_BYTES, Math.max(1, file.byteLength))
    )
    let total = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > file.byteLength) break
      await onChunk(buffer.subarray(0, bytesRead))
    }
    if (total !== file.byteLength) {
      throw new Error("staged file changed after it was staged")
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** A staged file's first bytes, at most `maxBytes` of them. */
export async function readStagedFilePrefix(
  file: StagedFile,
  maxBytes: number
): Promise<Uint8Array> {
  const handle = await open(file.path, READ_FLAGS)
  try {
    const buffer = new Uint8Array(Math.min(maxBytes, file.byteLength))
    let filled = 0
    while (filled < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.byteLength - filled,
        filled
      )
      if (bytesRead === 0) break
      filled += bytesRead
    }
    if (filled !== buffer.byteLength) {
      throw new Error("staged file changed after it was staged")
    }
    return buffer
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Copy a staged file's bytes into a file the caller opened to write. */
export async function copyStagedFileInto(
  file: StagedFile,
  handle: FileHandle
): Promise<void> {
  let position = 0
  await readStagedFile(file, async (chunk) => {
    for (let written = 0; written < chunk.byteLength; ) {
      const { bytesWritten } = await handle.write(
        chunk,
        written,
        chunk.byteLength - written,
        position
      )
      written += bytesWritten
      position += bytesWritten
    }
  })
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Remove staged files a stopped server left: those of a process no longer
 * running, and this process's own that it no longer holds, as a container
 * restarted under the same process id leaves them.
 */
export async function removeLeftoverStagedFiles(): Promise<number> {
  let names: string[]
  try {
    names = await readdir(stagingDirectory())
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const match = STAGED_NAME.exec(name)
    if (!match) continue
    const path = join(stagingDirectory(), name)
    const pid = Number(match[1])
    if (pid === process.pid ? live.has(path) : processIsRunning(pid)) continue
    await rm(path, { force: true }).catch(() => undefined)
    removed++
  }
  return removed
}
