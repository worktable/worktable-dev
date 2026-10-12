import { afterEach, beforeEach, expect, test } from "bun:test"
import { preloadWhenIdle } from "./idle-preload"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function setConnection(connection: object | undefined) {
  Object.defineProperty(navigator, "connection", {
    value: connection,
    configurable: true,
  })
}

beforeEach(() => {
  globalThis.requestIdleCallback = ((callback: IdleRequestCallback) =>
    setTimeout(callback, 0)) as unknown as typeof requestIdleCallback
})

afterEach(() => {
  setConnection(undefined)
  delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback
})

test("loads ahead in order once requests finish, past a failure", async () => {
  const loaded: string[] = []
  let busy = true
  const done = new Promise<void>((resolve) =>
    preloadWhenIdle(
      [
        async () => loaded.push("doc"),
        () => Promise.reject(new Error("offline")),
        async () => {
          loaded.push("editor")
          resolve()
        },
      ],
      () => busy
    )
  )
  await wait(100)
  expect(loaded).toEqual([])

  busy = false
  await done
  expect(loaded).toEqual(["doc", "editor"])
})

test("loads nothing ahead when the browser saves data or is on 2G", async () => {
  for (const connection of [
    { saveData: true, effectiveType: "4g" },
    { effectiveType: "2g" },
    { effectiveType: "slow-2g" },
  ]) {
    setConnection(connection)
    let loaded = false
    preloadWhenIdle([async () => (loaded = true)], () => false)
    await wait(50)
    expect(loaded).toBe(false)
  }

  setConnection({ saveData: false, effectiveType: "3g" })
  await new Promise<void>((resolve) =>
    preloadWhenIdle([async () => resolve()], () => false)
  )
})
