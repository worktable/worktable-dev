import { expect, test } from "bun:test"
import { announceUpdateWhenVisible } from "./update-notification"

class Visibility extends EventTarget {
  visibilityState: DocumentVisibilityState = "hidden"
  show() {
    this.visibilityState = "visible"
    this.dispatchEvent(new Event("visibilitychange"))
  }
}

test("a release is announced once, only when visible, unless another tab already announced it", () => {
  for (const seenInOtherTab of [false, true]) {
    const visibility = new Visibility()
    let seen: string | null = null
    let announcements = 0
    const stop = announceUpdateWhenVisible(
      "2.0.0",
      () => {
        announcements += 1
      },
      visibility,
      () => seen,
      (version) => {
        seen = version
      }
    )
    expect(announcements).toBe(0)
    if (seenInOtherTab) seen = "2.0.0"
    visibility.show()
    visibility.show()
    expect(announcements).toBe(seenInOtherTab ? 0 : 1)
    expect(seen).toBe("2.0.0")
    stop()
  }
  const visibility = new Visibility()
  let announcements = 0
  const stop = announceUpdateWhenVisible(
    "2.0.0",
    () => {
      announcements += 1
    },
    visibility,
    () => null,
    () => {}
  )
  stop()
  visibility.show()
  expect(announcements).toBe(0)
})
