import { expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DocumentFilesystemCoordinator,
  type DispatchedFilesystemChangeEvent,
  type DocumentFilesystemChangeEvent,
} from "./document-filesystem-coordinator.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

it("coalesces duplicate filesystem identities before forwarding them", async () => {
  const forwarded: DocumentFilesystemChangeEvent[] = []
  const coordinator = new DocumentFilesystemCoordinator({
    debounceMs: 60_000,
    emit: (event) => forwarded.push(event),
  })
  coordinator.note({ type: "doc", spaceId: "alpha", docPath: "notes/brief" })
  coordinator.note({ type: "doc", spaceId: "alpha", docPath: "notes/brief" })
  // A Space's corpus events become one, still naming every file changed.
  coordinator.note({ type: "documentCorpus", spaceId: "alpha", paths: ["a.csv"] })
  coordinator.note({ type: "documentCorpus", spaceId: "alpha", paths: ["b.csv"] })
  coordinator.note({ type: "documentCorpus", spaceId: "alpha" })
  await coordinator.flush()
  expect(forwarded).toEqual([
    { type: "doc", spaceId: "alpha", docPath: "notes/brief" },
    { type: "documentCorpus", spaceId: "alpha", paths: ["a.csv", "b.csv"] },
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

it("dispatches a changed .json or .html as what it is, a plain file by its whole name", async () => {
  const root = await mkdtemp(join(tmpdir(), "worktable-json-events-"))
  setWorkspaceRootOverride(root)
  try {
    const docs = join(root, "spaces", "alpha", "docs")
    await mkdir(docs, { recursive: true })
    const blocks = '[{"type":"paragraph","content":"Hi"}]'
    await writeFile(join(docs, "plan.md"), "# Plan")
    await writeFile(join(docs, "plan.json"), '[{"id":1}]')
    await writeFile(join(docs, "notes.json"), blocks)
    // The inventory's file claim wins over Doc blocks written into it.
    await writeFile(join(docs, "kept.json"), blocks)
    // Once a Space records its HTML Docs, only a claimed .html is one.
    await writeFile(join(docs, "board.html"), "<h1>Board</h1>")
    await writeFile(join(docs, "outside.html"), "<h1>Outside</h1>")
    await writeFile(
      join(root, "spaces", "alpha", "documents.meta.json"),
      JSON.stringify({
        type: "worktable.document-inventory",
        version: 1,
        htmlDocs: "claimed",
        documents: {
          doc_kept: {
            path: "kept.json",
            format: { id: "worktable.file", sourceVersion: 1 },
            source: { kind: "file", relativePath: "docs/kept.json" },
          },
          doc_board: {
            path: "board",
            format: { id: "worktable.html", sourceVersion: 1 },
            source: { kind: "file", relativePath: "docs/board.html" },
          },
        },
      })
    )
    // Larger than any Doc can be: a file, without reading it.
    await writeFile(join(docs, "export.json"), "")
    await truncate(join(docs, "export.json"), 65 * 1024 * 1024)

    const forwarded: DispatchedFilesystemChangeEvent[] = []
    const coordinator = new DocumentFilesystemCoordinator({
      debounceMs: 60_000,
      emit: (event) => forwarded.push(event),
    })
    for (const file of [
      "plan.json",
      "notes.json",
      "kept.json",
      "export.json",
      "board.html",
      "outside.html",
    ]) {
      coordinator.note({ type: "docSource", spaceId: "alpha", file })
    }
    // A same-named Markdown Doc's change, later in the batch, absorbs nothing.
    coordinator.note({ type: "doc", spaceId: "alpha", docPath: "plan" })
    await coordinator.flush()
    expect(forwarded).toEqual([
      { type: "documentCorpus", spaceId: "alpha", paths: ["plan.json"] },
      { type: "doc", spaceId: "alpha", docPath: "notes" },
      { type: "documentCorpus", spaceId: "alpha", paths: ["kept.json"] },
      { type: "documentCorpus", spaceId: "alpha", paths: ["export.json"] },
      { type: "widget", spaceId: "alpha", widgetId: "board" },
      { type: "documentCorpus", spaceId: "alpha", paths: ["outside.html"] },
      { type: "doc", spaceId: "alpha", docPath: "plan" },
    ])

    await coordinator.stop()
  } finally {
    setWorkspaceRootOverride(null)
    await rm(root, { recursive: true, force: true })
  }
})
