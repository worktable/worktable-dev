import { describe, expect, it } from "bun:test"
import {
  canResumeWorkspaceImport,
  uploadWorkspaceImport,
  workspaceImportResumeFingerprint,
  type WorkspaceImportCreated,
} from "./workspace-transfer-api.ts"

function uploadingJob(
  overrides: Partial<WorkspaceImportCreated> = {}
): WorkspaceImportCreated {
  return {
    version: 1,
    id: "wtx_123456789012345678901234",
    kind: "import",
    state: "uploading",
    fileName: "portable.wtb",
    expectedBytes: 1,
    receivedBytes: 0,
    chunkBytes: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  }
}

describe("workspace import chunk upload", () => {
  it("resumes only when a bounded content fingerprint matches", async () => {
    const selected = new File(["ab"], "portable.wtb")
    const different = new File(["cd"], "portable.wtb")
    const fingerprint = await workspaceImportResumeFingerprint(selected)
    const job = uploadingJob({
      expectedBytes: selected.size,
      resumeFingerprint: fingerprint,
    })

    expect(await workspaceImportResumeFingerprint(selected)).toBe(fingerprint)
    expect(await workspaceImportResumeFingerprint(different)).not.toBe(
      fingerprint
    )
    expect(canResumeWorkspaceImport(selected, job, fingerprint)).toBe(true)
    expect(
      canResumeWorkspaceImport(
        different,
        job,
        await workspaceImportResumeFingerprint(different)
      )
    ).toBe(false)

    const fallback = await workspaceImportResumeFingerprint(selected, null)
    expect(fallback).toHaveLength(64)
    expect(await workspaceImportResumeFingerprint(selected, null)).toBe(
      fallback
    )
    expect(await workspaceImportResumeFingerprint(different, null)).not.toBe(
      fallback
    )
  })

  it("bounds transient retries and leaves the durable import resumable", async () => {
    let attempts = 0
    const delays: number[] = []
    const progress: number[] = []
    const created = uploadingJob()

    await expect(
      uploadWorkspaceImport(
        new File(["x"], created.fileName),
        created,
        (uploaded) => progress.push(uploaded),
        {
          sleep: async (milliseconds) => {
            delays.push(milliseconds)
          },
          uploadChunk: async () => {
            attempts += 1
            throw new TypeError("gateway unavailable")
          },
        }
      )
    ).rejects.toThrow(/gateway unavailable/)

    expect(attempts).toBe(3)
    expect(delays).toEqual([1_000, 2_000])
    expect(progress).toEqual([0])
  })

  it("continues at the server-recorded byte offset", async () => {
    const created = uploadingJob({
      expectedBytes: 2,
      receivedBytes: 1,
    })
    const ranges: Array<[number, number]> = []
    const progress: number[] = []

    const result = await uploadWorkspaceImport(
      new File(["xy"], created.fileName),
      created,
      (uploaded) => progress.push(uploaded),
      {
        uploadChunk: async ({ start, endExclusive }) => {
          ranges.push([start, endExclusive])
          return {
            ...created,
            state: "verifying",
            receivedBytes: endExclusive,
          }
        },
      }
    )

    expect(result.state).toBe("verifying")
    expect(ranges).toEqual([[1, 2]])
    expect(progress).toEqual([1, 2])
  })

  it("rejects a reselected file with a different size before uploading", async () => {
    const created = uploadingJob({ expectedBytes: 2 })
    let attempted = false

    await expect(
      uploadWorkspaceImport(
        new File(["x"], created.fileName),
        created,
        () => {
          throw new Error("progress must not advance")
        },
        {
          uploadChunk: async () => {
            attempted = true
            return created
          },
        }
      )
    ).rejects.toThrow(/does not match/)

    expect(attempted).toBe(false)
  })

  it("rejects a reselected file with a different resume fingerprint", async () => {
    const created = uploadingJob({
      resumeFingerprint: "a".repeat(64),
    })
    let attempted = false

    await expect(
      uploadWorkspaceImport(
        new File(["x"], created.fileName),
        created,
        () => {
          throw new Error("progress must not advance")
        },
        {
          resumeFingerprint: "b".repeat(64),
          uploadChunk: async () => {
            attempted = true
            return created
          },
        }
      )
    ).rejects.toThrow(/does not match/)

    expect(attempted).toBe(false)
  })
})
