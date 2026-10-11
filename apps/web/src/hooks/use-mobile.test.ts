import { afterEach, expect, it } from "bun:test"
import { mediaQueryStore } from "./use-mobile"

const realWindow = globalThis.window

afterEach(() => {
  globalThis.window = realWindow
})

it("reads the viewport on the first render and follows changes", () => {
  let matches = true
  const listeners = new Set<() => void>()
  const queries: string[] = []
  globalThis.window = {
    matchMedia: (query: string) => {
      queries.push(query)
      return {
        get matches() {
          return matches
        },
        addEventListener: (_type: string, listener: () => void) =>
          listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) =>
          listeners.delete(listener),
      }
    },
  } as unknown as typeof globalThis.window

  const store = mediaQueryStore("(max-width: 767px)")
  // No effect has run: a phone gets the narrow layout from its first paint.
  expect(store.getSnapshot()).toBe(true)

  let changes = 0
  const unsubscribe = store.subscribe(() => changes++)
  matches = false
  for (const listener of listeners) listener()
  expect(changes).toBe(1)
  expect(store.getSnapshot()).toBe(false)

  unsubscribe()
  expect(listeners.size).toBe(0)
  expect(queries).toEqual(["(max-width: 767px)"])
})
