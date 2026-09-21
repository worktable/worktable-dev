import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { link, open, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

const ATOMIC_WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0)

const ATOMIC_WRITE_TEMPORARY_FILE_PATTERN =
  /^\.worktable-write-\d+-[0-9a-f]{32}\.tmp$/

export function isAtomicWriteTemporaryFileName(name: string): boolean {
  return ATOMIC_WRITE_TEMPORARY_FILE_PATTERN.test(name)
}

/**
 * Publishes text through a fresh sibling file without ever opening an
 * attacker-provided temporary symlink.
 */
export async function atomicWriteText(
  filePath: string,
  text: string
): Promise<void> {
  await atomicWriteBytes(filePath, new TextEncoder().encode(text))
}

/**
 * Publishes bytes through a fresh sibling file without ever opening an
 * attacker-provided temporary symlink.
 */
export async function atomicWriteBytes(
  filePath: string,
  bytes: Uint8Array
): Promise<void> {
  await atomicWriteBytesAfterValidation(filePath, bytes, async () => true)
}

/**
 * Publishes bytes only if the caller's source fence still holds after the
 * complete replacement has been staged beside its destination.
 */
export async function atomicWriteBytesAfterValidation(
  filePath: string,
  bytes: Uint8Array,
  validate: () => boolean | Promise<boolean>
): Promise<boolean> {
  const temporaryPath = join(
    dirname(filePath),
    `.worktable-write-${process.pid}-${randomBytes(16).toString("hex")}.tmp`
  )
  let published = false
  try {
    const handle = await open(temporaryPath, ATOMIC_WRITE_FLAGS, 0o666)
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
    if (!(await validate())) return false
    await rename(temporaryPath, filePath)
    published = true
    return true
  } finally {
    if (!published) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

/** Publish a new file without replacing a source created by another writer. */
export async function atomicCreateBytes(
  filePath: string,
  bytes: Uint8Array
): Promise<void> {
  const temporaryPath = join(
    dirname(filePath),
    `.worktable-write-${process.pid}-${randomBytes(16).toString("hex")}.tmp`
  )
  try {
    const handle = await open(temporaryPath, ATOMIC_WRITE_FLAGS, 0o666)
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
    await link(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}
