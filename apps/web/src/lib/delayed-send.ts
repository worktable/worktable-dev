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
  /** What is being sent, so a row that remounts can restore it. */
  body: string
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
  body: string,
  send: () => Promise<unknown>,
  options: { onSent?: () => void; onFailed?: (error: unknown) => void } = {}
): void {
  if (sends.get(id)?.phase === "waiting" || sends.get(id)?.phase === "sending") return
  const timer = setTimeout(() => {
    set(id, { phase: "sending", body })
    send().then(
      () => {
        set(id, { phase: "sent", body })
        options.onSent?.()
      },
      (error: unknown) => {
        set(id, { phase: "failed", body })
        options.onFailed?.(error)
      }
    )
  }, SEND_DELAY_MS)
  set(id, { phase: "waiting", body, timer })
}

/** Take back a reply that hasn't gone yet, returning its text. */
export function undoSend(id: string): string | null {
  const state = sends.get(id)
  if (state?.phase !== "waiting") return null
  clearTimeout(state.timer)
  set(id, null)
  return state.body
}

/** The text of a reply that failed, to put back in its box. */
export function failedBody(id: string): string | undefined {
  const state = sends.get(id)
  return state?.phase === "failed" ? state.body : undefined
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
