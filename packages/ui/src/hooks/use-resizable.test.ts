import { describe, test, expect, beforeEach } from "bun:test"

import {
  clampSize,
  createSizeStore,
  getSharedSizeStore,
  readStoredSize,
} from "./use-resizable"

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }
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
  test("falls back to the default without a storage key", () => {
    expect(readStoredSize(undefined, BOUNDS)).toBe(288)
  })

  test("falls back to the default when nothing is stored", () => {
    expect(readStoredSize("sidebar-width", BOUNDS)).toBe(288)
  })

  test("roundtrips a stored size", () => {
    store.set("sidebar-width", "342")
    expect(readStoredSize("sidebar-width", BOUNDS)).toBe(342)
  })

  test("falls back to the default on corrupt values", () => {
    store.set("sidebar-width", "not a number")
    expect(readStoredSize("sidebar-width", BOUNDS)).toBe(288)

    store.set("sidebar-width", "Infinity")
    expect(readStoredSize("sidebar-width", BOUNDS)).toBe(288)
  })

  test("clamps stored values that fall outside current bounds", () => {
    store.set("sidebar-width", "9999")
    expect(readStoredSize("sidebar-width", BOUNDS)).toBe(480)

    store.set("sidebar-width", "12")
    expect(readStoredSize("sidebar-width", BOUNDS)).toBe(220)
  })

  test("falls back to the default when localStorage throws", () => {
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: () => {
        throw new Error("denied")
      },
    }
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

  test("shared stores are one instance per storage key", () => {
    store.set("shared-pane", "342")
    const a = getSharedSizeStore("shared-pane", BOUNDS)
    const b = getSharedSizeStore("shared-pane", BOUNDS)
    expect(b).toBe(a)
    expect(a.get()).toBe(342)

    a.set(400)
    expect(b.get()).toBe(400)
  })

  test("shared store seeds from storage with clamping", () => {
    store.set("clamped-pane", "9999")
    expect(getSharedSizeStore("clamped-pane", BOUNDS).get()).toBe(480)
  })
})
