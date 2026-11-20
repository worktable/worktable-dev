import { describe, expect, it } from "bun:test"
import { RecordFileSchema } from "./records"

const record = (createdAt: string) => ({
  version: 1,
  kind: "worktable.record",
  id: "launch-plan",
  collectionId: "tasks",
  createdAt,
  updatedAt: "2026-11-20T09:15:30.250Z",
  createdBy: "person",
})

describe("record files keep reading the timestamps they always did", () => {
  it("reads UTC times written by hand, with or without seconds", () => {
    for (const createdAt of [
      "2026-11-20T09:15Z",
      "2026-11-20T09:15:30Z",
      "2026-11-20T09:15:30.250Z",
    ])
      expect(RecordFileSchema.safeParse(record(createdAt)).success).toBe(true)
  })

  it("still refuses times that are not UTC timestamps", () => {
    for (const createdAt of [
      "2026-11-20",
      "2026-11-20T09:15",
      "2026-11-20T09:15:30+02:00",
      "2026-02-30T09:15:30Z",
    ])
      expect(RecordFileSchema.safeParse(record(createdAt)).success).toBe(false)
  })
})
