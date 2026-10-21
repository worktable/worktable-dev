import { Database } from "bun:sqlite"
import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { readBoundedRegularFileBytes } from "./bounded-file.ts"
import {
  captureVisitorCommentDatabase,
  closeVisitorCommentStores,
  holdVisitorCommentWrites,
  visitorCommentsCheckpoint,
  visitorCommentStoreFile,
} from "./visitor-comment-store.ts"

const MAX_BYTES = 256 * 1024 * 1024
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")
export const VisitorCommentsCheckpointSchema = z.strictObject({
  incarnation: z.string().regex(/^[a-f0-9]{32}$/),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
export const VisitorCommentBackupStateSchema = z.strictObject({
  version: z.literal(1),
  worktableId: z.string().min(1).max(1024),
  size: z.number().int().nonnegative().max(MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  checkpoint: VisitorCommentsCheckpointSchema,
})
export type VisitorCommentBackupState = z.infer<
  typeof VisitorCommentBackupStateSchema
>

/** Operator backups include the private store, independently of preview admission. */
export async function captureVisitorCommentBackup(
  root: string,
  worktableId: string
): Promise<VisitorCommentBackupState | undefined> {
  const path = join(root, "app", "visitor-comments.sqlite")
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const checkpoint = captureVisitorCommentDatabase(path)
  if (!checkpoint) return undefined
  await chmod(path, 0o600)
  const bytes = await readBoundedRegularFileBytes(path, MAX_BYTES)
  const state = {
    version: 1 as const,
    worktableId,
    size: bytes.byteLength,
    sha256: digest(bytes),
    checkpoint,
  }
  VisitorCommentBackupStateSchema.parse(state)
  return state
}

async function verifiedBytes(
  root: string,
  state: VisitorCommentBackupState
): Promise<Uint8Array> {
  VisitorCommentBackupStateSchema.parse(state)
  const path = join(root, "app", "visitor-comments.sqlite")
  const bytes = await readBoundedRegularFileBytes(path, MAX_BYTES)
  if (
    bytes.byteLength !== state.size ||
    digest(bytes) !== state.sha256 ||
    bytes[18] !== 1 ||
    bytes[19] !== 1
  )
    throw new Error("Visitor comment backup changed")
  const db = new Database(path, { readonly: true, create: false })
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA temp_store=MEMORY")
    if (
      (db.query("PRAGMA user_version").get() as { user_version: number })
        .user_version !== 2 ||
      (db.query("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check !== "ok" ||
      db.query("PRAGMA foreign_key_check").get()
    )
      throw new Error("Invalid visitor comment backup")
    const checkpoint = VisitorCommentsCheckpointSchema.parse(
      db.query("SELECT incarnation,revision FROM visitor_meta WHERE id=1").get()
    )
    if (JSON.stringify(checkpoint) !== JSON.stringify(state.checkpoint))
      throw new Error("Visitor comment checkpoint changed")
  } finally {
    db.close()
  }
  return bytes
}

export async function inspectVisitorCommentBackup(
  root: string,
  state: VisitorCommentBackupState
): Promise<void> {
  await verifiedBytes(root, state)
}

/** Called after ordinary writers are drained, before the workspace swap. */
export function holdVisitorCommentsAtCheckpoint(expected: unknown): () => void {
  const release = holdVisitorCommentWrites()
  try {
    const current = visitorCommentsCheckpoint()
    const parsed =
      expected === undefined
        ? undefined
        : VisitorCommentsCheckpointSchema.nullable().parse(expected)
    if (
      (parsed === undefined && current !== null) ||
      (parsed !== undefined &&
        JSON.stringify(parsed) !== JSON.stringify(current))
    )
      throw new Error(
        "Visitor comments changed after the safety backup; retry the restore"
      )
    return release
  } catch (error) {
    release()
    throw error
  }
}

/** The live replacement or offline recovery has fenced callers before this runs. */
export async function restoreVisitorCommentBackup(
  root: string,
  state: VisitorCommentBackupState | null,
  worktableId: string
): Promise<void> {
  if (state && state.worktableId !== worktableId)
    throw new Error("Visitor comments belong to another Worktable")
  const target = visitorCommentStoreFile()
  const release = holdVisitorCommentWrites()
  const staged = `${target}.restore-${randomBytes(8).toString("hex")}`
  try {
    if (state) {
      const bytes = await verifiedBytes(root, state)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(staged, bytes, { mode: 0o600, flag: "wx" })
      const restored = new Database(staged, { readwrite: true, create: false })
      try {
        restored.exec("PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE")
        // Never let a pre-restore safety fence become valid again as its old
        // revision counter catches up after restoring an earlier checkpoint.
        restored
          .query("UPDATE visitor_meta SET incarnation=? WHERE id=1")
          .run(randomBytes(16).toString("hex"))
      } finally {
        restored.close()
      }
      const file = await open(staged, "r")
      try {
        await file.sync()
      } finally {
        await file.close()
      }
    }
    closeVisitorCommentStores()
    await rm(`${target}-wal`, { force: true })
    await rm(`${target}-shm`, { force: true })
    await rm(`${target}-journal`, { force: true })
    if (state) await rename(staged, target)
    else await rm(target, { force: true })
    if (existsSync(dirname(target))) {
      const directory = await open(dirname(target), "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    try {
      await rm(staged, { force: true })
    } finally {
      release()
    }
  }
}
