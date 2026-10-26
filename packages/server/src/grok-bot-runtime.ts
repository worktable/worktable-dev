import {
  expireGrokBotDeliveries,
  grokBotDeliveries,
} from "./thread-delivery-store.ts"
import {
  applyGrokBotIdentityDefaults,
  onGrokBotChange,
  readGrokBots,
  reserveGrokBotWake,
  updateGrokBot,
} from "./grok-bot-store.ts"
import {
  GROK_BOT_ROUTINE,
  ringOutcome,
  ringWebhook,
  WAKE_RETRIES,
} from "./agent-wake.ts"
import { notifyWorkspaceChange, onWorkspaceChange } from "./workspace-events.ts"
import { workspaceCacheKey } from "./workspace.ts"
import { reconcileParticipantDeliveries } from "./thread-service.ts"
import {
  agentWorktableThreadAccess,
  runWithoutTeamIdentity,
  teamAgentForParticipantKey,
  teamAgentHasSpaceAccess,
} from "./team-policy.ts"
import { currentTeamWorktable, onTeamPolicyChange } from "./team-database.ts"
import { hasScope } from "./token-store.ts"
import { sendGrokEmailWake } from "./grok-bot-email.ts"
import { scanAllThreadDigests } from "./thread-store.ts"

const isActive = (state: string) =>
  !["queued", "failed", "replied"].includes(state)

/** Event driven, with one timer for the next durable retry or execution deadline. */
export function startGrokBotRuntime(
  options: { fetch?: typeof fetch } = {}
): () => Promise<void> {
  let stopped = false
  let dirty = false
  let running: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let canonicalRevision = 0
  const reconciled = new Map<string, number>()
  const abort = new AbortController()
  const workspace = workspaceCacheKey()
  const live = () => !stopped && workspace === workspaceCacheKey()

  async function reconcileGrokBots(): Promise<void> {
    let nextAt: number | undefined
    const revision = canonicalRevision
    let scan: Awaited<ReturnType<typeof scanAllThreadDigests>> | undefined
    const schedule = (at: number) => {
      nextAt = nextAt === undefined ? at : Math.min(nextAt, at)
    }
    for (const original of await readGrokBots()) {
      if (!live()) return
      await applyGrokBotIdentityDefaults(original)
      const key = `${original.participantId}\0${original.generation}`
      if (reconciled.get(key) !== revision) {
        // Repair the crash window between publishing a thread and queuing its
        // delivery. The existing catalog reuses unchanged thread digests.
        scan ??= await scanAllThreadDigests()
        await reconcileParticipantDeliveries(original.participantId, scan)
        reconciled.set(key, revision)
      }
      await expireGrokBotDeliveries(original.participantId)
      const deliveries = await grokBotDeliveries(original.participantId)
      const active = deliveries.find((d) => isActive(d.state))
      if (active?.leaseExpiresAt) schedule(Date.parse(active.leaseExpiresAt))
      if (!original.enabled) continue
      let connection = original
      const probe =
        connection.probe &&
        deliveries.find(
          (d) =>
            d.messageId === connection.probe?.messageId &&
            d.threadId === connection.probe?.threadId &&
            d.identityId === connection.probe?.identityId
        )
      if (probe?.state === "replied") {
        const changes = {
          verifiedAt: new Date().toISOString(),
          probe: undefined,
          error: undefined,
          wake: undefined,
        }
        if (!(await updateGrokBot(connection, changes))) continue
        connection = { ...connection, ...changes }
        notifyWorkspaceChange({ type: "participants" })
      }
      if (active) {
        if (connection.wake)
          await updateGrokBot(connection, { wake: undefined })
        continue
      }
      if (
        connection.error ||
        deliveries.some((d) => d.error?.code === "REMOTE_EXECUTION_UNCONFIRMED")
      )
        continue
      const team = currentTeamWorktable()
      const agent = team
        ? teamAgentForParticipantKey(connection.participantKey)
        : null
      const hasThreads =
        agent &&
        (agent.scopeCeiling === null ||
          ["threads:read", "threads:write", "threads:participate"].every(
            (scope) => hasScope(agent.scopeCeiling!, scope)
          ))
      const queued = deliveries.filter(
        (d) =>
          d.state === "queued" &&
          (connection.verifiedAt ||
            connection.probe?.messageId === d.messageId) &&
          (!team ||
            (hasThreads &&
              (d.location.kind === "space"
                ? teamAgentHasSpaceAccess(agent!, d.location.spaceId, "edit")
                : agentWorktableThreadAccess(agent!) === "edit")))
      )
      if (!queued.length) {
        if (connection.wake)
          await updateGrokBot(connection, { wake: undefined })
        continue
      }
      const eligible = Math.min(
        ...queued.map((d) =>
          d.nextAttemptAt ? Date.parse(d.nextAttemptAt) : 0
        )
      )
      if (eligible > Date.now()) {
        schedule(eligible)
        continue
      }
      const wake = connection.wake ?? { attempts: 0, nextAt: 0 }
      if (wake.nextAt > Date.now()) {
        schedule(wake.nextAt)
        continue
      }
      if (wake.attempts >= WAKE_RETRIES.length) {
        await updateGrokBot(connection, {
          error:
            "Grok Bot has not claimed the queued work. Check the routine, its approvals, and the Worktable sign-in, then retry the wake.",
        })
        notifyWorkspaceChange({ type: "participants" })
        continue
      }
      // Persist BEFORE sending: a crash or ambiguous network result retries this wake,
      // never an execution. The inbox claim is the deduplication boundary.
      const next = await reserveGrokBotWake(connection, WAKE_RETRIES)
      if (!live()) return
      if (!next) {
        // Another server may have reserved the wake. Keep a recovery timer in
        // this process too, in case that process exits before sending it.
        const latest = (await readGrokBots()).find(
          (entry) =>
            entry.connectionId === connection.connectionId &&
            entry.generation === connection.generation
        )
        if (latest?.enabled && latest.wake) schedule(latest.wake.nextAt)
        continue
      }
      schedule(next.nextAt)
      try {
        const signal = AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(10_000),
        ])
        const context = { fetch: options.fetch ?? fetch, signal }
        const outcome =
          connection.wakeMethod === "email"
            ? await ringOutcome(
                await sendGrokEmailWake(connection, next, context)
              )
            : await ringWebhook(
                GROK_BOT_ROUTINE,
                { url: connection.webhookUrl, secret: connection.webhookKey },
                next,
                context
              )
        if (!live()) return
        if (outcome.kind === "rejected") {
          await updateGrokBot(connection, {
            error:
              connection.wakeMethod === "email"
                ? `Email notification failed (HTTP ${outcome.status}). Check the Bot address and Worktable connection.`
                : `Grok Bot rejected the wake (HTTP ${outcome.status}). Check the routine URL and key.`,
          })
          notifyWorkspaceChange({ type: "participants" })
        }
      } catch {
        // Never log fetch errors: they can contain the routine URL or key.
        if (!live()) return
      }
    }
    if (live() && nextAt !== undefined) {
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
    running = runWithoutTeamIdentity(async () => {
      while (dirty && live()) {
        dirty = false
        if (timer) clearTimeout(timer)
        timer = undefined
        await reconcileGrokBots()
      }
    })
      .catch(() => {
        // Fail closed on unreadable private state; expose no credentials in diagnostics.
        console.error(
          "[Worktable] Grok Bot connection state could not be processed"
        )
        if (live()) {
          timer = setTimeout(nudge, WAKE_RETRIES[0])
          timer.unref?.()
        }
      })
      .finally(() => {
        running = undefined
        if (dirty && live()) nudge()
      })
  }
  const offConfig = onGrokBotChange(nudge)
  const offPolicy = onTeamPolicyChange(nudge)
  const offWorkspace = onWorkspaceChange((event) => {
    if (event.type === "thread" || event.type === "workspaceReset")
      canonicalRevision += 1
    if (
      ["threadActivity", "thread", "participants", "workspaceReset"].includes(
        event.type
      )
    )
      nudge()
  })
  nudge()
  return () => {
    stopped = true
    offConfig()
    offPolicy()
    offWorkspace()
    abort.abort()
    if (timer) clearTimeout(timer)
    return running ?? Promise.resolve()
  }
}
