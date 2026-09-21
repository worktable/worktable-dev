import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"

const SECURE_READ_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
})

export type BoundedFileReadFailure =
  | "missing"
  | "symlink"
  | "not-file"
  | "too-large"
  | "changed"
  | "aborted"
  | "unreadable"

export class BoundedFileReadError extends Error {
  readonly reason: BoundedFileReadFailure
  readonly path: string

  constructor(reason: BoundedFileReadFailure, path: string) {
    super(`bounded file read failed (${reason}): ${path}`)
    this.reason = reason
    this.path = path
  }
}

function sameEntry(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function failureForOpen(error: unknown): BoundedFileReadFailure {
  const code = (error as NodeJS.ErrnoException).code
  if (code === "ENOENT" || code === "ENOTDIR") return "missing"
  if (code === "ELOOP" || code === "EMLINK") return "symlink"
  return "unreadable"
}

async function readBoundedRegularFileBuffer(
  path: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  if (signal?.aborted) {
    throw new BoundedFileReadError("aborted", path)
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, SECURE_READ_FLAGS)
  } catch (error) {
    throw new BoundedFileReadError(failureForOpen(error), path)
  }

  try {
    const opened = await handle.stat()
    let reachable
    try {
      reachable = await lstat(path)
    } catch (error) {
      throw new BoundedFileReadError(failureForOpen(error), path)
    }
    if (reachable.isSymbolicLink()) {
      throw new BoundedFileReadError("symlink", path)
    }
    if (!opened.isFile() || !reachable.isFile()) {
      throw new BoundedFileReadError("not-file", path)
    }
    if (!sameEntry(opened, reachable)) {
      throw new BoundedFileReadError("changed", path)
    }
    if (opened.size > maxBytes) {
      throw new BoundedFileReadError("too-large", path)
    }

    if (signal?.aborted) {
      throw new BoundedFileReadError("aborted", path)
    }

    const chunks: Buffer[] = []
    let bytes = 0
    const stream = handle.createReadStream({
      autoClose: false,
      highWaterMark: Math.min(64 * 1024, maxBytes + 1),
    })
    const abortRead = () => stream.destroy()
    signal?.addEventListener("abort", abortRead, { once: true })
    if (signal?.aborted) abortRead()
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.byteLength
        if (bytes > maxBytes) {
          throw new BoundedFileReadError("too-large", path)
        }
        chunks.push(buffer)
      }
    } finally {
      signal?.removeEventListener("abort", abortRead)
    }
    if (signal?.aborted) {
      throw new BoundedFileReadError("aborted", path)
    }

    const [after, reachableAfter] = await Promise.all([
      handle.stat(),
      lstat(path),
    ])
    if (signal?.aborted) {
      throw new BoundedFileReadError("aborted", path)
    }
    if (
      reachableAfter.isSymbolicLink() ||
      !reachableAfter.isFile() ||
      !sameEntry(opened, after) ||
      !sameEntry(opened, reachableAfter) ||
      bytes !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new BoundedFileReadError("changed", path)
    }
    return Buffer.concat(chunks, bytes)
  } catch (error) {
    if (error instanceof BoundedFileReadError) throw error
    if (
      signal?.aborted ||
      (error as NodeJS.ErrnoException).name === "AbortError"
    ) {
      throw new BoundedFileReadError("aborted", path)
    }
    throw new BoundedFileReadError("unreadable", path)
  } finally {
    await handle.close()
  }
}

export async function readBoundedRegularFileBytes(
  path: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  return readBoundedRegularFileBuffer(path, maxBytes, signal)
}

export async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string> {
  const bytes = await readBoundedRegularFileBuffer(path, maxBytes, signal)
  try {
    return FATAL_UTF8_DECODER.decode(bytes)
  } catch {
    throw new BoundedFileReadError("unreadable", path)
  }
}
