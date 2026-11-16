/**
 * The person's help state: read from the workspace summary they already
 * load, written only when they act on a tip. No request of its own.
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import type { HelpEvent, PersonalSetup } from "@worktable/types/setup"
import { useDeploymentInfo, useHelpEnabled } from "@/hooks/use-deployment-info"
import type { WorkspaceInfo } from "../api"
import { fetchJSON } from "../http.ts"
import { queryKeys } from "../queries"
import { usePersonalSetup } from "../setup"
import type { HelpCondition, Tip } from "./registry"
import { pickTip, tipMayShow, type HelpContext } from "./rules"

const SESSION_KEY = "worktable.help.session"

/** When this browser session started; set once per tab session. */
function sessionStartedAt(): string {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY)
    if (stored) return stored
    const now = new Date().toISOString()
    sessionStorage.setItem(SESSION_KEY, now)
    return now
  } catch {
    return SESSION_STARTED_FALLBACK
  }
}
const SESSION_STARTED_FALLBACK = new Date().toISOString()

/**
 * Shown counts are written once per tip per tab session, kept with the
 * session itself so a reload in the same tab doesn't count a showing twice.
 */
const REPORTED_KEY = "worktable.help.reported"
const reported = {
  has(id: string): boolean {
    try {
      return (sessionStorage.getItem(REPORTED_KEY) ?? "")
        .split(" ")
        .includes(id)
    } catch {
      return reportedHere.has(id)
    }
  },
  add(id: string): void {
    reportedHere.add(id)
    try {
      const ids = new Set(
        (sessionStorage.getItem(REPORTED_KEY) ?? "").split(" ")
      )
      ids.add(id)
      sessionStorage.setItem(REPORTED_KEY, [...ids].filter(Boolean).join(" "))
    } catch {
      // Without session storage, this page's memory still counts it once.
    }
  },
  clear(): void {
    reportedHere.clear()
    try {
      sessionStorage.removeItem(REPORTED_KEY)
    } catch {
      // Nothing to clear.
    }
  },
}
const reportedHere = new Set<string>()

export interface HelpChange {
  id?: string
  event?: HelpEvent
  version?: number
  /** With a showing: the close it follows, as the summary had it. */
  follows?: string
  resetAll?: true
  evidence?: "rules-added"
  tryNextHidden?: boolean
}

/**
 * Saves go one at a time: each answer is the whole setup, so an earlier
 * save answering late would undo a later one, such as Hide Next Steps.
 */
let saving: Promise<unknown> = Promise.resolve()

/** Save what the person did with help; the summary carries the result. */
export function saveHelp(
  queryClient: QueryClient,
  change: HelpChange
): Promise<PersonalSetup> {
  const saved = saving.then(() => sendHelp(queryClient, change))
  saving = saved.catch(() => undefined)
  return saved
}

async function sendHelp(
  queryClient: QueryClient,
  change: HelpChange
): Promise<PersonalSetup> {
  const { setup } = await fetchJSON<{ setup: PersonalSetup }>(
    "/api/profile/help",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    }
  )
  queryClient.setQueryData<WorkspaceInfo>(queryKeys.workspace, (current) =>
    current ? { ...current, setup } : current
  )
  // Every tip starts over, so each counts its next showing again.
  if (change.resetAll) reported.clear()
  return setup
}

/** Everything the rules need, from data the app already has. */
export function useHelpContext(): HelpContext & { setup: PersonalSetup } {
  const enabled = useHelpEnabled()
  const deployment = useDeploymentInfo().data
  const { setup, workspace } = usePersonalSetup()
  // Until the summary arrives, the person's help is unknown: nothing shows.
  const known = workspace !== undefined
  const conditions = useMemo<Partial<Record<HelpCondition, boolean>>>(
    () => ({
      teams: workspace?.teamContext != null,
      links: deployment?.capabilities.documentSharing === true,
      files: deployment?.capabilities.files === true,
      library: deployment?.capabilities.skillLibraries === true,
      local: deployment != null && deployment.mode !== "cloud",
    }),
    [deployment, workspace?.teamContext]
  )
  return {
    enabled: enabled && known,
    sessionStartedAt: sessionStartedAt(),
    conditions,
    evidence: setup.helpEvidence,
    setup,
  }
}

// ------------------------------------------------------------
// One tip per screen
// ------------------------------------------------------------

interface Candidate {
  id: string
  priority: number
  order: number
  /**
   * How many places want it now: a page can show the same tip in two copies
   * of one part, such as a Doc's byline before and after its editor loads.
   */
  holders: number
}

let order = 0
const candidates = new Map<string, Candidate>()
const listeners = new Set<() => void>()
let winner: string | null = null

function recompute() {
  const next = pickTip([...candidates.values()])?.id ?? null
  if (next === winner) return
  winner = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Ask to show a tip; returns a release for when it no longer wants to. */
export function claim(id: string, priority: number): () => void {
  const held = candidates.get(id)
  if (held) held.holders += 1
  else candidates.set(id, { id, priority, order: order++, holders: 1 })
  recompute()
  return () => {
    const current = candidates.get(id)
    if (current && --current.holders === 0) candidates.delete(id)
    recompute()
  }
}

export interface UseTip {
  /** Show it now. */
  open: boolean
  close: () => void
  /** The person did what the tip is about. */
  done: () => void
}

/**
 * A tip that shows on its own. `active` is the place's own condition, such as
 * "this Doc is temporary"; the stored state and the one-per-screen rule decide
 * the rest.
 */
export function useTip(tip: Tip, active: boolean): UseTip {
  const queryClient = useQueryClient()
  const context = useHelpContext()
  const state = context.setup.help?.[tip.id]
  // Closed or done here: gone at once, before the save comes back.
  const [settled, setSettled] = useState(false)
  const allowed = active && !settled && tipMayShow(tip, state, context)
  const current = useSyncExternalStore(
    subscribe,
    () => winner,
    () => null
  )

  // Claim the screen while allowed; give it back when not.
  useEffect(() => {
    if (!allowed) return
    return claim(tip.id, tip.priority)
  }, [allowed, tip.id, tip.priority])

  const open = allowed && current === tip.id
  const closedAt = state?.closedAt
  useEffect(() => {
    if (!open || reported.has(tip.id)) return
    reported.add(tip.id)
    void saveHelp(queryClient, {
      id: tip.id,
      event: "shown",
      version: tip.version,
      follows: closedAt,
    }).catch(() => undefined)
  }, [open, queryClient, tip.id, tip.version, closedAt])

  // Saves go in order, so a close never lands before its showing.
  const close = useCallback(() => {
    setSettled(true)
    void saveHelp(queryClient, {
      id: tip.id,
      event: "closed",
      version: tip.version,
    }).catch(() => undefined)
  }, [queryClient, tip.id, tip.version])
  const done = useCallback(() => {
    setSettled(true)
    void saveHelp(queryClient, {
      id: tip.id,
      event: "done",
      version: tip.version,
    }).catch(() => undefined)
  }, [queryClient, tip.id, tip.version])
  return { open, close, done }
}

/** The tip this screen shows now, if any. */
export function currentTip(): string | null {
  return winner
}

/** For tests: forget the screen and the session's reports. */
export function resetHelpForTests() {
  candidates.clear()
  reported.clear()
  winner = null
}
