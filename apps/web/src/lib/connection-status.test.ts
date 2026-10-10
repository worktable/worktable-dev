import { afterEach, describe, expect, it, jest } from "bun:test"
import {
  CONNECTION_RECOVERY_CAP_MS,
  noteSocketStatus,
  waitForConnectionRecovery,
} from "./connection-status"

const SOCKET = "ws://worktable.test/ws?spaceId=notes"

afterEach(() => {
  noteSocketStatus(SOCKET, null)
  jest.useRealTimers()
})

describe("reconnecting after a discarded page reloads", () => {
  it("ends when the socket is live, and has nothing to wait for without one", () => {
    let recovered = 0
    noteSocketStatus(SOCKET, "connecting")
    waitForConnectionRecovery(() => recovered++)
    expect(recovered).toBe(0)
    noteSocketStatus(SOCKET, "connected")
    noteSocketStatus(SOCKET, "disconnected")
    expect(recovered).toBe(1)

    noteSocketStatus(SOCKET, null)
    let idle = 0
    waitForConnectionRecovery(() => idle++)
    expect(idle).toBe(1)
    // A socket the page opens later does not start a wait again.
    noteSocketStatus(SOCKET, "connecting")
    expect(idle).toBe(1)
  })

  it("stops covering the page when the handshake stalls", () => {
    jest.useFakeTimers()
    let recovered = 0
    noteSocketStatus(SOCKET, "connecting")
    waitForConnectionRecovery(() => recovered++)
    jest.advanceTimersByTime(CONNECTION_RECOVERY_CAP_MS - 1)
    expect(recovered).toBe(0)
    jest.advanceTimersByTime(1)
    expect(recovered).toBe(1)
    noteSocketStatus(SOCKET, "connected")
    expect(recovered).toBe(1)
  })
})
