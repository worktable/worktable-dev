// The frame's side of the viewer protocol: everything a viewer frame says
// to the page that holds it, and hears from it. A frame has no origin, so
// it posts to any origin and trusts only its own parent window.

import type {
  ViewerAssetRequest,
  ViewerFrameMessage,
  ViewerHostMessage,
} from "../lib/viewer-frame-protocol"

type Outgoing = ViewerFrameMessage extends infer M
  ? M extends { token: string }
    ? Omit<M, "token">
    : never
  : never

const token = crypto.randomUUID()

/** Tell the page something. */
export function say(message: Outgoing): void {
  window.parent.postMessage({ ...message, token }, "*")
}

/** Hear the page, and nothing else that can post to this window. */
export function hear(listener: (message: ViewerHostMessage) => void): void {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return
    const message = event.data as ViewerHostMessage | null
    if (
      typeof message?.type === "string" &&
      message.type.startsWith("viewer.")
    ) {
      listener(message)
    }
  })
}

const assets = new Map<
  string,
  { resolve: (data: ArrayBuffer) => void; reject: (reason: Error) => void }
>()

/** One of the viewer's own public files, fetched by the page. */
export function asset(request: ViewerAssetRequest): Promise<ArrayBuffer> {
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    assets.set(id, { resolve, reject })
    say({ type: "viewer.asset", id, ...request })
  })
}

/** Settle an asset the page answered. */
export function assetArrived(id: string, data: ArrayBuffer | null): void {
  const waiting = assets.get(id)
  assets.delete(id)
  if (data) waiting?.resolve(data)
  else waiting?.reject(new Error("This file isn't available."))
}

/**
 * A worker from the code the frame document carries. A frame with no origin
 * can start one only from a blob, and only as a classic script. It resolves
 * once the worker has said something, which is when it has begun listening.
 */
export function startWorker(elementId: string): Promise<Worker> {
  return new Promise((resolve, reject) => {
    const code = document.getElementById(elementId)?.textContent
    if (!code) {
      reject(new Error("No worker code"))
      return
    }
    let worker: Worker
    try {
      worker = new Worker(
        URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
      )
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const giveUp = (reason: string) => {
      worker.terminate()
      reject(new Error(reason))
    }
    const timer = setTimeout(() => giveUp("The worker did not answer"), 10_000)
    worker.addEventListener(
      "message",
      () => {
        clearTimeout(timer)
        resolve(worker)
      },
      { once: true }
    )
    worker.addEventListener(
      "error",
      () => {
        clearTimeout(timer)
        giveUp("The worker did not start")
      },
      { once: true }
    )
  })
}
