import { afterEach, beforeEach, expect, test } from "bun:test"
import { preloadWhenIdle } from "./idle-preload"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function setConnection(connection: object | undefined) {
  Object.defineProperty(navigator, "connection", {
    value: connection,
    configurable: true,
  })
}

const originals = {
  connection: Object.getOwnPropertyDescriptor(navigator, "connection"),
  requestIdleCallback: Object.getOwnPropertyDescriptor(
    globalThis,
    "requestIdleCallback"
  ),
}

function restore(target: object, key: string, original?: PropertyDescriptor) {
  if (original) Object.defineProperty(target, key, original)
  else Reflect.deleteProperty(target, key)
}

beforeEach(() => {
  globalThis.requestIdleCallback = ((callback: IdleRequestCallback) =>
    setTimeout(callback, 0)) as unknown as typeof requestIdleCallback
})

afterEach(() => {
  restore(navigator, "connection", originals.connection)
  restore(globalThis, "requestIdleCallback", originals.requestIdleCallback)
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

  // Allowed, until the browser starts saving data partway through.
  setConnection({ saveData: false, effectiveType: "3g" })
  let later = false
  await new Promise<void>((resolve) =>
    preloadWhenIdle(
      [
        async () => {
          setConnection({ saveData: true, effectiveType: "3g" })
          resolve()
        },
        async () => (later = true),
      ],
      () => false
    )
  )
  await wait(50)
  expect(later).toBe(false)
})
