import { withFileLock } from "openclaw/plugin-sdk/file-lock"
import {
  readJsonFileWithFallback,
  writeJsonFileAtomically,
} from "openclaw/plugin-sdk/json-store"
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths"
import { join } from "node:path"
import type { WorktableThreadLocation } from "./types.js"

const MAX_RETAINED_REPLIES = 2_000
const OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const LOCK_OPTIONS = {
  retries: {
    retries: 20,
    factor: 1.4,
    minTimeout: 10,
    maxTimeout: 250,
    randomize: true,
  },
  stale: 30_000,
}

export interface RetainedWorktableReply {
  location?: WorktableThreadLocation
  spaceId?: string
  threadId: string
  to: string
  inReplyTo: string
  body: string
  idempotencyKey: string
}

interface RetainedReplyEntry {
  eventId: string
  reply: RetainedWorktableReply
  retainedAt: string
}

interface ReplyOutboxFile {
  type: "worktable.openclaw-reply-outbox"
  version: 1
  replies: RetainedReplyEntry[]
}

export interface ReplyOutbox {
  get(eventId: string): Promise<RetainedWorktableReply | undefined>
  put(eventId: string, reply: RetainedWorktableReply): Promise<void>
  delete(eventId: string): Promise<void>
}

function emptyOutbox(): ReplyOutboxFile {
  return {
    type: "worktable.openclaw-reply-outbox",
    version: 1,
    replies: [],
  }
}

function isRetainedReply(value: unknown): value is RetainedWorktableReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const reply = value as Record<string, unknown>
  const location = reply.location as Record<string, unknown> | undefined
  const validLocation =
    location?.kind === "worktable" ||
    (location?.kind === "space" && typeof location.spaceId === "string")
  return (
    (validLocation || typeof reply.spaceId === "string") &&
    typeof reply.threadId === "string" &&
    typeof reply.to === "string" &&
    typeof reply.inReplyTo === "string" &&
    typeof reply.body === "string" &&
    typeof reply.idempotencyKey === "string"
  )
}

function parseOutbox(value: unknown): ReplyOutboxFile {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { type?: unknown }).type !== "worktable.openclaw-reply-outbox" ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { replies?: unknown }).replies)
  ) {
    throw Object.assign(new Error("Invalid Worktable reply outbox"), {
      code: "DURABLE_REPLY_OUTBOX_UNAVAILABLE",
    })
  }
  const entries = (value as { replies: unknown[] }).replies
  if (
    !entries.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof (entry as { eventId?: unknown }).eventId === "string" &&
        typeof (entry as { retainedAt?: unknown }).retainedAt === "string" &&
        Number.isFinite(
          Date.parse((entry as { retainedAt: string }).retainedAt)
        ) &&
        isRetainedReply((entry as { reply?: unknown }).reply)
    )
  ) {
    throw Object.assign(new Error("Invalid Worktable reply outbox entry"), {
      code: "DURABLE_REPLY_OUTBOX_UNAVAILABLE",
    })
  }
  return value as ReplyOutboxFile
}

function pruneExpired(file: ReplyOutboxFile, now = Date.now()): boolean {
  const retained = file.replies.filter(
    (entry) => now - Date.parse(entry.retainedAt) <= OUTBOX_TTL_MS
  )
  if (retained.length === file.replies.length) return false
  file.replies = retained
  return true
}

function sameReply(
  left: RetainedWorktableReply,
  right: RetainedWorktableReply
): boolean {
  return (
    JSON.stringify(left.location) === JSON.stringify(right.location) &&
    left.spaceId === right.spaceId &&
    left.threadId === right.threadId &&
    left.to === right.to &&
    left.inReplyTo === right.inReplyTo &&
    left.body === right.body &&
    left.idempotencyKey === right.idempotencyKey
  )
}

export function createOpenClawReplyOutbox(
  env: NodeJS.ProcessEnv = process.env
): ReplyOutbox {
  const filePath = join(
    resolveStateDir(env),
    "plugins",
    "worktable",
    "reply-outbox.json"
  )

  const locked = <T>(run: (file: ReplyOutboxFile) => Promise<T>) =>
    withFileLock(filePath, LOCK_OPTIONS, async () => {
      const loaded = await readJsonFileWithFallback<unknown>(filePath, null)
      const file = loaded.exists ? parseOutbox(loaded.value) : emptyOutbox()
      return run(file)
    }).catch((error) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code.startsWith("DURABLE_REPLY_OUTBOX_")
      ) {
        throw error
      }
      throw Object.assign(
        new Error("OpenClaw could not access its durable Worktable outbox", {
          cause: error,
        }),
        { code: "DURABLE_REPLY_OUTBOX_UNAVAILABLE" }
      )
    })

  return {
    get(eventId) {
      return locked(async (file) => {
        const changed = pruneExpired(file)
        if (changed) await writeJsonFileAtomically(filePath, file)
        return file.replies.find((entry) => entry.eventId === eventId)?.reply
      })
    },
    put(eventId, reply) {
      return locked(async (file) => {
        const changed = pruneExpired(file)
        const existing = file.replies.find((entry) => entry.eventId === eventId)
        if (existing) {
          if (!sameReply(existing.reply, reply)) {
            throw Object.assign(
              new Error("Conflicting retained Worktable reply"),
              { code: "DURABLE_REPLY_OUTBOX_CONFLICT" }
            )
          }
          if (changed) await writeJsonFileAtomically(filePath, file)
          return
        }
        if (file.replies.length >= MAX_RETAINED_REPLIES) {
          throw Object.assign(new Error("Worktable reply outbox is full"), {
            code: "DURABLE_REPLY_OUTBOX_FULL",
          })
        }
        file.replies.push({
          eventId,
          reply,
          retainedAt: new Date().toISOString(),
        })
        await writeJsonFileAtomically(filePath, file)
      })
    },
    delete(eventId) {
      return locked(async (file) => {
        const before = file.replies.length
        file.replies = file.replies.filter((entry) => entry.eventId !== eventId)
        const changed = pruneExpired(file)
        if (changed || file.replies.length !== before) {
          await writeJsonFileAtomically(filePath, file)
        }
      })
    },
  }
}

export function createMemoryReplyOutbox(): ReplyOutbox {
  const replies = new Map<string, RetainedWorktableReply>()
  return {
    get: (eventId) => Promise.resolve(replies.get(eventId)),
    put(eventId, reply) {
      const existing = replies.get(eventId)
      if (existing && !sameReply(existing, reply)) {
        return Promise.reject(
          Object.assign(new Error("Conflicting retained Worktable reply"), {
            code: "DURABLE_REPLY_OUTBOX_CONFLICT",
          })
        )
      }
      replies.set(eventId, reply)
      return Promise.resolve()
    },
    delete(eventId) {
      replies.delete(eventId)
      return Promise.resolve()
    },
  }
}
