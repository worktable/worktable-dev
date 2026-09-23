import { describe, test, expect, beforeEach, afterEach } from "bun:test"

import {
  clampSize,
  createSizeStore,
  getSharedSizeStore,
  readStoredSize,
} from "./use-resizable"

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }
})

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage)
  else Reflect.deleteProperty(globalThis, "localStorage")
})

const BOUNDS = { defaultSize: 288, minSize: 220, maxSize: 480 }

describe("clampSize", () => {
  test("passes through in-range values and clamps both bounds", () => {
    expect(clampSize(300, 220, 480)).toBe(300)
    expect(clampSize(100, 220, 480)).toBe(220)
    expect(clampSize(900, 220, 480)).toBe(480)
  })
})

describe("readStoredSize", () => {
  test("restores valid sizes and safely bounds missing, corrupt, or denied storage", () => {
    expect(readStoredSize(undefined, BOUNDS)).toBe(288)
    for (const [stored, expected] of [[undefined, 288], ["342", 342], ["not a number", 288], ["Infinity", 288], ["9999", 480], ["12", 220]] as const) {
      store.clear()
      if (stored !== undefined) store.set("sidebar-width", stored)
      expect(readStoredSize("sidebar-width", BOUNDS)).toBe(expected)
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: { getItem() { throw new Error("denied") } } })
    expect(readStoredSize("sidebar-width", BOUNDS)).toBe(288)
  })
})

describe("size store", () => {
  test("set updates the value and notifies subscribers once per change", () => {
    const store = createSizeStore(288)
    let notified = 0
    const unsubscribe = store.subscribe(() => notified++)

    store.set(300)
    expect(store.get()).toBe(300)
    expect(notified).toBe(1)

    store.set(300) // no-op write does not notify
    expect(notified).toBe(1)

    unsubscribe()
    store.set(320)
    expect(store.get()).toBe(320)
    expect(notified).toBe(1)
  })

  test("consumers of the same storage key observe each other’s size changes", () => {
    store.set("shared-pane", "342")
    const a = getSharedSizeStore("shared-pane", BOUNDS)
    const b = getSharedSizeStore("shared-pane", BOUNDS)
    expect(a.get()).toBe(342)

    a.set(400)
    expect(b.get()).toBe(400)
  })

})
