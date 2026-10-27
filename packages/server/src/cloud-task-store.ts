// ============================================================
// Cloud tasks: where to ring an agent that runs in its vendor's cloud
// ============================================================
//
// One target per agent: a Claude Code scheduled task's API trigger, which
// Worktable fires when something is sent to that agent (cloud-task-runtime.ts).
// The URL and token stay in this private file in the app directory. They are
// never sent to a browser or written to a log.

import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { readFileFingerprint } from "./file-fingerprint.ts"
import { notifyWorkspaceChange, onWorkspaceChange } from "./workspace-events.ts"
import { workspaceCacheKey } from "./workspace.ts"

const TaskSchema = z.object({
  participantId: z.string(),
  url: z.string(),
  token: z.string(),
  enabled: z.boolean(),
  /** New with each URL and token, so work for an old one never touches a new one. */
  generation: z.string(),
  verifiedAt: z.string().optional(),
  /** Why it stopped firing, in a line for the owner. */
  error: z.string().optional(),
  /** A test fire is due or out, and counts once the agent checks in. */
  testingSince: z.number().optional(),
  /** When to fire next. */
  nextAt: z.number().optional(),
  /** Tries of the next fire that were turned away for now. */
  attempts: z.number().int().optional(),
  /** The last fire, kept until the agent checks in. Saved before sending. */
  firedAt: z.number().optional(),
  /** The agent's pending revision at that fire: later items are news to it. */
  firedRevision: z.number().optional(),
  sessionUrl: z.string().optional(),
  hourStart: z.number().optional(),
  hourFires: z.number().int().optional(),
})
const FileSchema = z.object({
  type: z.literal("worktable.cloud-tasks"),
  version: z.literal(1),
  tasks: z.array(TaskSchema),
})
export type CloudTask = z.infer<typeof TaskSchema>
type TasksFile = z.infer<typeof FileSchema>

const empty = (): TasksFile => ({
  type: "worktable.cloud-tasks",
  version: 1,
  tasks: [],
})
const listeners = new Set<() => void>()
let queue: Promise<unknown> = Promise.resolve()
let cache:
  | { path: string; fingerprint: string | null; file: TasksFile }
  | undefined

function path(): string {
  return join(ensureAppDir(), "cloud-tasks", `${workspaceCacheKey()}.json`)
}

async function load(filePath: string): Promise<TasksFile> {
  try {
    return FileSchema.parse(JSON.parse(await readFile(filePath, "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty()
    throw error
  }
}

async function read(): Promise<TasksFile> {
  const filePath = path()
  const stamp = await readFileFingerprint(filePath)
  const fingerprint = stamp?.key ?? null
  if (
    !cache ||
    cache.path !== filePath ||
    cache.fingerprint !== fingerprint ||
    stamp?.racy
  ) {
    cache = { path: filePath, fingerprint, file: await load(filePath) }
  }
  return cache.file
}

/** What an agent's auto-reply shows, so a change can tell open screens. */
function shownState(task: CloudTask): string {
  return [
    task.enabled,
    Boolean(task.verifiedAt),
    task.error ?? "",
    task.testingSince !== undefined,
  ].join("|")
}

/** Only local private state goes through this lock; never send inside it. */
async function mutate<T>(change: (file: TasksFile) => T): Promise<T> {
  const filePath = path()
  const run = () =>
    withCrossProcessLock(
      `${filePath}.lock`,
      { label: "Cloud tasks" },
      async () => {
        const file = await load(filePath)
        const before = new Map(
          file.tasks.map((task) => [task.participantId, shownState(task)])
        )
        const result = change(file)
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
        const temporary = `${filePath}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify(file), {
          encoding: "utf8",
          mode: 0o600,
        })
        await chmod(temporary, 0o600)
        await rename(temporary, filePath)
        cache = undefined
        const after = new Map(
          file.tasks.map((task) => [task.participantId, shownState(task)])
        )
        if (
          before.size !== after.size ||
          [...after].some(([id, state]) => before.get(id) !== state)
        )
          notifyWorkspaceChange({ type: "participants" })
        return result
      }
    )
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

export async function readCloudTasks(): Promise<readonly CloudTask[]> {
  return (await read()).tasks
}

export async function cloudTaskFor(
  participantId: string
): Promise<CloudTask | undefined> {
  return (await read()).tasks.find((t) => t.participantId === participantId)
}

/** Save a URL and token, and ask for a test fire at once. */
export async function saveCloudTask(input: {
  participantId: string
  url: string
  token: string
  generation: string
}): Promise<void> {
  await mutate((file) => {
    file.tasks = file.tasks.filter(
      (t) => t.participantId !== input.participantId
    )
    const now = Date.now()
    file.tasks.push({
      ...input,
      enabled: true,
      testingSince: now,
      nextAt: now,
    })
  })
}

/**
 * Change one agent's task under the lock. `change` sees the latest saved
 * state; returns undefined when the agent has none, or a newer one replaced
 * the generation given.
 */
export async function updateCloudTask<T>(
  participantId: string,
  generation: string | null,
  change: (task: CloudTask) => T
): Promise<T | undefined> {
  return mutate((file) => {
    const task = file.tasks.find((t) => t.participantId === participantId)
    if (!task || (generation !== null && task.generation !== generation))
      return undefined
    return change(task)
  })
}

export async function removeCloudTask(participantId: string): Promise<void> {
  if (!(await cloudTaskFor(participantId))) return
  await mutate((file) => {
    file.tasks = file.tasks.filter((t) => t.participantId !== participantId)
  })
}

/** Hear the owner save, test or remove a task. */
export function onCloudTaskChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function signalCloudTaskChange(): void {
  for (const listener of listeners) listener()
}

onWorkspaceChange((event) => {
  if (event.type !== "workspaceReset") return
  return mutate((file) => {
    file.tasks = []
  }).then(signalCloudTaskChange)
})
