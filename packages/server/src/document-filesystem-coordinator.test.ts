import { expect, it } from "bun:test"
import {
  DocumentFilesystemCoordinator,
  type DocumentFilesystemChangeEvent,
} from "./document-filesystem-coordinator.ts"

it("coalesces duplicate filesystem identities before forwarding them", async () => {
  const forwarded: DocumentFilesystemChangeEvent[] = []
  const coordinator = new DocumentFilesystemCoordinator({
    debounceMs: 60_000,
    emit: (event) => forwarded.push(event),
  })
  coordinator.note({ type: "doc", spaceId: "alpha", docPath: "notes/brief" })
  coordinator.note({ type: "doc", spaceId: "alpha", docPath: "notes/brief" })
  await coordinator.flush()
  expect(forwarded).toEqual([
    { type: "doc", spaceId: "alpha", docPath: "notes/brief" },
  ])
  await coordinator.stop()
})

it("caps overflow reconciliation and reports additional affected Spaces once", async () => {
  const bounded: DocumentFilesystemChangeEvent[] = []
  const overflowErrors: unknown[] = []
  const overflow = new DocumentFilesystemCoordinator({
    debounceMs: 60_000,
    maxPendingEvents: 2,
    emit: (event) => bounded.push(event),
    onError: (error) => overflowErrors.push(error),
  })
  overflow.note({ type: "doc", spaceId: "alpha", docPath: "one" })
  overflow.note({ type: "widget", spaceId: "alpha", widgetId: "two" })
  overflow.note({ type: "doc", spaceId: "beta", docPath: "three" })
  overflow.note({ type: "doc", spaceId: "gamma", docPath: "four" })
  overflow.note({ type: "doc", spaceId: "delta", docPath: "five" })
  await overflow.flush()
  expect(bounded).toHaveLength(2)
  expect(bounded).toEqual(
    expect.arrayContaining([
      { type: "documentCorpus", spaceId: "alpha" },
      { type: "documentCorpus", spaceId: "beta" },
    ])
  )
  expect(overflowErrors).toHaveLength(1)
  expect(String(overflowErrors[0])).toContain("additional Space events were dropped")
  await overflow.stop()
})

it("discards queued filesystem activity after failed startup", async () => {
  const discarded: DocumentFilesystemChangeEvent[] = []
  const failedStartup = new DocumentFilesystemCoordinator({
    debounceMs: 60_000,
    emit: (event) => discarded.push(event),
  })
  failedStartup.note({ type: "doc", spaceId: "startup", docPath: "pending" })
  await failedStartup.stop({ flushPending: false })
  expect(discarded).toEqual([])
})

it("flushes within the maximum batch delay during continuous activity", async () => {
  let markMaximumWaitForwarded: (() => void) | undefined
  const maximumWaitEvents: DocumentFilesystemChangeEvent[] = []
  const maximumWaitForwarded = new Promise<void>((resolve) => {
    markMaximumWaitForwarded = resolve
  })
  const maximumWait = new DocumentFilesystemCoordinator({
    debounceMs: 60_000,
    maxBatchDelayMs: 20,
    emit: (event) => {
      maximumWaitEvents.push(event)
      markMaximumWaitForwarded?.()
    },
  })
  maximumWait.note({
    type: "doc",
    spaceId: "continuous",
    docPath: "activity",
  })
  const continuousActivity = setInterval(() => {
    maximumWait.note({
      type: "doc",
      spaceId: "continuous",
      docPath: "activity",
    })
  }, 1)
  let rejectMaximumWait: ((error: Error) => void) | undefined
  const maximumWaitTimeout = new Promise<never>((_resolve, reject) => {
    rejectMaximumWait = reject
  })
  const timeout = setTimeout(
    () => rejectMaximumWait?.(new Error("maximum batch delay was not honored")),
    1_000
  )
  try {
    await Promise.race([maximumWaitForwarded, maximumWaitTimeout])
  } finally {
    clearInterval(continuousActivity)
    clearTimeout(timeout)
    await maximumWait.stop()
  }
  expect(maximumWaitEvents).toContainEqual({
    type: "doc",
    spaceId: "continuous",
    docPath: "activity",
  })
})

it("drains queued filesystem activity during graceful shutdown", async () => {
  const forwarded: DocumentFilesystemChangeEvent[] = []
  const coordinator = new DocumentFilesystemCoordinator({
    debounceMs: 60_000,
    emit: (event) => forwarded.push(event),
  })
  coordinator.note({ type: "widget", spaceId: "alpha", widgetId: "saved" })
  await coordinator.stop()
  expect(forwarded).toContainEqual({
    type: "widget",
    spaceId: "alpha",
    widgetId: "saved",
  })
})
