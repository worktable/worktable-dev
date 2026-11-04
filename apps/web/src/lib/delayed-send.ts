// ============================================================
// Delayed send
// ============================================================
//
// A reply sent from Home waits a few seconds before it goes, so it can be
// taken back: once posted, an agent may already be working on it. The wait
// lives outside React, so moving around the app doesn't cancel it, and the
// browser asks before closing a tab while a reply is still waiting.

import { useSyncExternalStore } from "react"

export const SEND_DELAY_MS = 5_000

export type SendPhase = "waiting" | "sending" | "sent" | "failed"

interface SendState {
  phase: SendPhase
  timer?: ReturnType<typeof setTimeout>
}

const sends = new Map<string, SendState>()
const listeners = new Set<() => void>()

function set(id: string, state: SendState | null): void {
  if (state) sends.set(id, state)
  else sends.delete(id)
  for (const listener of listeners) listener()
}

/** Send after the delay unless undone; `send` runs at most once. */
export function scheduleSend(
  id: string,
  send: () => Promise<unknown>,
  options: { onSent?: () => void; onFailed?: (error: unknown) => void } = {}
): void {
  if (sends.get(id)?.phase === "waiting" || sends.get(id)?.phase === "sending") return
  const timer = setTimeout(() => {
    set(id, { phase: "sending" })
    send().then(
      () => {
        set(id, { phase: "sent" })
        options.onSent?.()
      },
      (error: unknown) => {
        set(id, { phase: "failed" })
        options.onFailed?.(error)
      }
    )
  }, SEND_DELAY_MS)
  set(id, { phase: "waiting", timer })
}

/** Take back a reply that hasn't gone yet. */
export function undoSend(id: string): boolean {
  const state = sends.get(id)
  if (state?.phase !== "waiting") return false
  clearTimeout(state.timer)
  set(id, null)
  return true
}

/** Forget a finished send, so the row can be answered again. */
export function clearSend(id: string): void {
  const state = sends.get(id)
  if (state?.phase === "sent" || state?.phase === "failed") set(id, null)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSendPhase(id: string): SendPhase | undefined {
  return useSyncExternalStore(
    subscribe,
    () => sends.get(id)?.phase,
    () => undefined
  )
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    for (const state of sends.values()) {
      if (state.phase === "waiting" || state.phase === "sending") {
        event.preventDefault()
        return
      }
    }
  })
}
