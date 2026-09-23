import { afterEach, expect, test, mock } from "bun:test"
import { submitCloudLogout } from "./cloud-logout"

const fetchBefore = globalThis.fetch
const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window")
afterEach(() => {
  globalThis.fetch = fetchBefore
  if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore)
  else Reflect.deleteProperty(globalThis, "window")
})

test("logout falls back to gateway confirmation when session proof cannot be acquired", async () => {
  const assign = mock(() => {})
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { assign } },
  })
  globalThis.fetch = (async () =>
    new Response("Unavailable", { status: 503 })) as typeof fetch
  await submitCloudLogout()
  expect(assign).toHaveBeenCalledWith("/logout")
})
