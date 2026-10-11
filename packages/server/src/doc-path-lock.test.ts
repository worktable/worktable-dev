import { expect, it } from "bun:test"
import { withDocPathLock } from "./doc-path-lock.ts"

it("lets an abandoned waiter leave the Space queue without running", async () => {
  const order: string[] = []
  let release!: () => void
  const holder = withDocPathLock("space", async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    order.push("holder")
  })
  const controller = new AbortController()
  const abandoned = withDocPathLock(
    "space",
    async () => {
      order.push("abandoned")
    },
    controller.signal
  )

  controller.abort()
  // It gives up at once, while the holder still owns the Space.
  await expect(abandoned).rejects.toThrow()
  // A caller arriving after that still waits for the holder.
  const later = withDocPathLock("space", async () => {
    order.push("later")
  })
  await Promise.resolve()
  expect(order).toEqual([])

  release()
  await Promise.all([holder, later])
  expect(order).toEqual(["holder", "later"])
})
