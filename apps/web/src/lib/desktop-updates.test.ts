import { afterEach, describe, expect, it } from "bun:test"
import { getDesktopUpdateStatus } from "./desktop-updates"

interface TestGlobal {
  __TAURI__?: {
    core: { invoke: (command: string, args?: unknown) => Promise<unknown> }
  }
}

const desktopGlobal = globalThis as typeof globalThis & TestGlobal

function respond(value: unknown) {
  desktopGlobal.__TAURI__ = { core: { invoke: async () => value } }
}

const readyStatus = {
  schemaVersion: 1,
  currentVersion: "0.1.21",
  state: "ready",
  availableVersion: "0.1.22",
  notes: "Added\n\n• Background updates.",
  downloadedBytes: 155_000_000,
  totalBytes: 155_000_000,
  canRestart: true,
  lastCheck: { checkedAt: 1_791_605_530, outcome: "available", message: null },
}

afterEach(() => {
  delete desktopGlobal.__TAURI__
})

describe("Desktop update bridge", () => {
  it("is absent outside Desktop and on pages Desktop refuses", async () => {
    expect(await getDesktopUpdateStatus()).toBeNull()
    for (const message of [
      "native update command requires the active local Desktop workspace and origin",
      "desktop_workspace_update_status not allowed. Permissions associated with this command do not allow this invocation.",
    ]) {
      desktopGlobal.__TAURI__ = {
        core: {
          invoke: async () => {
            throw new Error(message)
          },
        },
      }
      expect(await getDesktopUpdateStatus()).toBeNull()
    }
  })

  it("reads a ready update and the last check", async () => {
    respond(readyStatus)
    expect(await getDesktopUpdateStatus()).toEqual({
      currentVersion: "0.1.21",
      state: "ready",
      availableVersion: "0.1.22",
      notes: "Added\n\n• Background updates.",
      downloadedBytes: 155_000_000,
      totalBytes: 155_000_000,
      canRestart: true,
      lastCheck: {
        checkedAt: 1_791_605_530,
        outcome: "available",
        message: null,
      },
    })
  })

  it("rejects a status it does not understand instead of guessing", async () => {
    for (const status of [
      { ...readyStatus, schemaVersion: 2 },
      { ...readyStatus, state: "paused" },
      { ...readyStatus, canRestart: "yes" },
      {
        ...readyStatus,
        lastCheck: { checkedAt: 1, outcome: "maybe", message: null },
      },
    ]) {
      respond(status)
      await expect(getDesktopUpdateStatus()).rejects.toThrow("invalid update")
    }
  })
})
