// ============================================================
// Cloud tasks: ringing Claude when something is sent to it
// ============================================================
//
// When something lands on the pending list of an agent with a cloud task
// (cloud-task-store.ts), Worktable fires the task: Claude starts a run in the
// cloud, which checks Worktable as that agent and replies. Every fire is a
// new run on the person's plan and can't be deduplicated, so:
//
// - A burst is one fire: it waits a little after the first new item.
// - One run at a time: after a fire, nothing fires again until the agent
//   checks in (pending-read.ts) or a deadline passes, which stops firing
//   until the owner fixes or tests it.
// - The fire is saved before it is sent, so a crash never repeats one.
// - At most a few fires an hour, and none while turned away.
//
// Event driven, with one timer for the next due time. Works only with the
// MCP preview on. Never logs the URL or token.

import { AsyncLocalStorage } from "node:async_hooks"
import {
  CLAUDE_CODE_TASK,
  ringWebhook,
  WAKE_RETRIES,
  type RingOutcome,
} from "./agent-wake.ts"
import {
  cloudTaskFor,
  onCloudTaskChange,
  readCloudTasks,
  updateCloudTask,
  type CloudTask,
} from "./cloud-task-store.ts"
import { configuredMcpSurface } from "./mcp/surface.ts"
import {
  onPendingChange,
  pendingFor,
  pendingMarks,
  pendingRevision,
} from "./pending-list.ts"
import { onCheckIn } from "./pending-read.ts"
import { workspaceCacheKey } from "./workspace.ts"

/** How long a burst gathers before one fire. */
export const COALESCE_MS = 10_000
/** How long a fired run has to check in. */
export const CHECK_IN_MS = 15 * 60_000
export const HOURLY_FIRES = 20
/** Fires turned away for now are tried this many more times. */
const RETRIES = 4
const HOUR_MS = 60 * 60_000

export const CLOUD_TASK_ERRORS = {
  silent:
    "Claude didn't check Worktable. Check the task in Claude, then test again.",
  busy: "Claude is busy. Test again later.",
  401: "Claude didn't accept the token. Paste it again.",
  403: "This Claude account can't run the task.",
  404: "Claude couldn't find the task. Check the URL.",
  400: "Claude didn't start the task. Check that it isn't paused.",
  other: "Claude didn't start the task. Check the URL and token.",
} as const

function rejected(status: number): string {
  return status === 400 || status === 401 || status === 403 || status === 404
    ? CLOUD_TASK_ERRORS[status]
    : CLOUD_TASK_ERRORS.other
}

/** Whether an item the agent hasn't been shown arrived after `revision`. */
async function unshownAfter(
  participantId: string,
  revision: number
): Promise<boolean> {
  return (await pendingFor(participantId)).some(
    (entry) =>
      entry.revision > revision && !pendingMarks(entry.itemId)?.deliveredAt
  )
}

export function startCloudTaskRuntime(
  options: {
    fetch?: typeof fetch
    /** Called whenever nothing is being recorded or sent, for tests. */
    onSettled?: () => void
  } = {}
): () => Promise<void> {
  const send = options.fetch ?? fetch
  let stopped = false
  let dirty = false
  let running: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = new AbortController()
  // Work runs in the context the runtime started in, never in that of the
  // request whose change happened to wake it.
  const detached = AsyncLocalStorage.snapshot()
  const workspace = workspaceCacheKey()
  const live = () => !stopped && workspace === workspaceCacheKey()
  const enabled = () => configuredMcpSurface() === "preview"
  // Agents with a task, as of the last pass, so events for others cost nothing.
  let targets = new Set<string>()

  async function fire(task: CloudTask, schedule: (at: number) => void) {
    const { participantId, generation } = task
    const testing = task.testingSince !== undefined
    if (
      !testing &&
      !(await unshownAfter(participantId, task.firedRevision ?? 0))
    ) {
      // What gathered was shown or closed meanwhile.
      await updateCloudTask(participantId, generation, (t) => {
        if (t.nextAt !== task.nextAt) return
        t.nextAt = undefined
        t.attempts = undefined
      })
      return
    }
    const revision = await pendingRevision(participantId)
    // Saved BEFORE sending: after a crash this reads as fired, and waits for
    // the check-in instead of starting a second run.
    const reserved = await updateCloudTask(participantId, generation, (t) => {
      const now = Date.now()
      if (
        !t.enabled ||
        t.error ||
        t.firedAt !== undefined ||
        t.nextAt === undefined ||
        t.nextAt > now
      )
        return undefined
      if (t.hourStart === undefined || now - t.hourStart >= HOUR_MS) {
        t.hourStart = now
        t.hourFires = 0
      }
      if ((t.hourFires ?? 0) >= HOURLY_FIRES) {
        const capped = t.hourStart + HOUR_MS
        t.nextAt = capped
        return { capped }
      }
      t.hourFires = (t.hourFires ?? 0) + 1
      t.firedAt = now
      t.nextAt = undefined
      t.sessionUrl = undefined
      return { firedAt: now, attempts: t.attempts ?? 0 }
    })
    if (!reserved || !live()) return
    if (reserved.capped !== undefined) {
      schedule(reserved.capped)
      return
    }
    const { firedAt } = reserved
    schedule(firedAt + CHECK_IN_MS)
    let outcome: RingOutcome
    try {
      outcome = await ringWebhook(
        CLAUDE_CODE_TASK,
        { url: task.url, secret: task.token },
        { id: `${generation}:${firedAt}`, attempts: reserved.attempts },
        {
          fetch: send,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
        }
      )
    } catch {
      // Never log send errors: they can carry the URL or token. A run may
      // have started, so this waits for the check-in like a fire.
      return
    }
    if (!live()) return
    await updateCloudTask(participantId, generation, (t) => {
      if (t.firedAt !== firedAt) return
      if (outcome.kind === "sent") {
        // Only an accepted fire moves the boundary: a refused one still owes
        // the items it was for, and its retry looks for them again.
        t.firedRevision = revision
        t.attempts = undefined
        if (outcome.session) t.sessionUrl = outcome.session
        return
      }
      // Turned away: no run started.
      t.firedAt = undefined
      const attempts = (t.attempts ?? 0) + 1
      if (outcome.kind === "retry" && attempts <= RETRIES) {
        t.attempts = attempts
        t.nextAt = Date.now() + (outcome.after ?? WAKE_RETRIES[attempts - 1]!)
        schedule(t.nextAt)
        return
      }
      t.attempts = undefined
      t.testingSince = undefined
      t.error =
        outcome.kind === "rejected"
          ? rejected(outcome.status)
          : CLOUD_TASK_ERRORS.busy
    })
  }

  async function drain(): Promise<void> {
    const tasks = await readCloudTasks()
    targets = new Set(tasks.map((task) => task.participantId))
    if (!enabled()) return
    let nextAt = Infinity
    const schedule = (at: number) => {
      nextAt = Math.min(nextAt, at)
    }
    for (const task of tasks) {
      if (!live()) return
      if (!task.enabled || task.error) continue
      const now = Date.now()
      if (task.firedAt !== undefined) {
        const deadline = task.firedAt + CHECK_IN_MS
        if (deadline > now) schedule(deadline)
        else
          await updateCloudTask(task.participantId, task.generation, (t) => {
            // Kept as fired and testing, so a late check-in still counts.
            if (t.firedAt === task.firedAt && !t.error)
              t.error = CLOUD_TASK_ERRORS.silent
          })
        continue
      }
      if (task.nextAt === undefined) continue
      if (task.nextAt > now) schedule(task.nextAt)
      else await fire(task, schedule)
    }
    if (live() && Number.isFinite(nextAt)) {
      timer = setTimeout(nudge, Math.max(1, nextAt - Date.now()))
      timer.unref?.()
    }
  }

  function nudge(): void {
    if (!live()) return
    dirty = true
    if (running) return
    if (timer) clearTimeout(timer)
    timer = undefined
    running = detached(async () => {
      while (dirty && live()) {
        dirty = false
        if (timer) clearTimeout(timer)
        timer = undefined
        await drain()
      }
    })
      .catch(() => {
        console.error("[Worktable] Cloud task state could not be processed")
        if (live()) {
          timer = setTimeout(nudge, WAKE_RETRIES[0])
          timer.unref?.()
        }
      })
      .finally(() => {
        running = undefined
        if (dirty && live()) nudge()
        else settled()
      })
  }

  function settled(): void {
    if (!running && recording.size === 0) options.onSettled?.()
  }

  // Changes being recorded. Stopping waits for them.
  const recording = new Set<Promise<void>>()
  function record(participantId: string, work: () => Promise<boolean>) {
    if (!live() || !enabled() || !targets.has(participantId)) return
    const done: Promise<void> = detached(work)
      .then((changed) => {
        if (changed) nudge()
      })
      .catch(() => {
        console.error("[Worktable] Cloud task state could not be recorded")
      })
      .finally(() => {
        recording.delete(done)
        settled()
      })
    recording.add(done)
  }

  const offPending = onPendingChange((change) => {
    if (change.type !== "added") return
    const participantId = change.entry.recipient.participantId
    record(participantId, async () =>
      Boolean(
        await updateCloudTask(participantId, null, (t) => {
          // A run out picks this up when it checks in.
          if (!t.enabled || t.error || !t.verifiedAt) return false
          if (t.firedAt !== undefined || t.nextAt !== undefined) return false
          t.nextAt = Date.now() + COALESCE_MS
          return true
        })
      )
    )
  })

  const offCheckIn = onCheckIn((participantId) => {
    record(participantId, async () => {
      const task = await cloudTaskFor(participantId)
      if (!task) return false
      // Items that came after the fire and weren't shown on this check-in.
      const fresh =
        task.firedAt !== undefined &&
        (await unshownAfter(participantId, task.firedRevision ?? 0))
      return Boolean(
        await updateCloudTask(participantId, task.generation, (t) => {
          const now = Date.now()
          if (t.firedAt === undefined) {
            // While the agent is looking, a gathered fire waits for it.
            if (t.nextAt === undefined || t.testingSince !== undefined)
              return false
            t.nextAt = Math.max(t.nextAt, now + COALESCE_MS)
            return true
          }
          if (t.testingSince !== undefined) {
            t.verifiedAt = new Date(now).toISOString()
            t.testingSince = undefined
          }
          t.firedAt = undefined
          t.error = undefined
          t.attempts = undefined
          if (fresh && t.enabled && t.verifiedAt) t.nextAt = now + COALESCE_MS
          return true
        })
      )
    })
  })

  const offChange = onCloudTaskChange(nudge)
  nudge()
  return () => {
    stopped = true
    offPending()
    offCheckIn()
    offChange()
    abort.abort()
    if (timer) clearTimeout(timer)
    return Promise.allSettled([...recording, running]).then(() => undefined)
  }
}
