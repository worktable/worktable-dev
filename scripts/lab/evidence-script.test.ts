import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { LAB_EVIDENCE_SCRIPT } from "./evidence-script.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe("lab evidence helper", () => {
  test("captures change-aware thread evidence without bodies, leases, or tokens", () => {
    const root = mkdtempSync(join(tmpdir(), "worktable-lab-evidence-"))
    roots.push(root)
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    const appDir = join(root, "app")
    const script = join(root, "lab-evidence")
    const openclawLog = join(root, "openclaw.log")
    mkdirSync(join(workspace, "spaces", "product", "threads"), {
      recursive: true,
    })
    mkdirSync(join(workspace, "threads"), { recursive: true })
    mkdirSync(join(appDir, "thread-deliveries"), { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(script, LAB_EVIDENCE_SCRIPT)
    chmodSync(script, 0o700)
    writeFileSync(
      openclawLog,
      `${JSON.stringify({
        "1": "Completed Worktable message msg_private in thr_example",
        message: "Completed Worktable message msg_private in thr_example",
      })}\n`
    )

    const env = {
      ...process.env,
      HOME: home,
      WORKTABLE_LAB_WORKSPACE: workspace,
      WORKTABLE_LAB_APP_DIR: appDir,
      WORKTABLE_LAB_OPENCLAW_LOG: openclawLog,
      PATH: "/usr/bin:/bin",
    }
    expect(
      spawnSync(process.execPath, [script, "baseline"], { env }).status
    ).toBe(0)

    writeFileSync(
      join(workspace, "spaces", "product", "threads", "thr_example.json"),
      JSON.stringify({
        type: "worktable.thread",
        version: 1,
        id: "thr_example",
        spaceId: "product",
        revision: 2,
        title: "Private title",
        participants: [
          { id: "ptc_a", kind: "agent", name: "Codex" },
          { id: "ptc_b", kind: "agent", name: "Tester" },
        ],
        messages: [
          {
            id: "msg_private",
            sequence: 1,
            authorId: "ptc_a",
            recipientIds: ["ptc_b"],
            body: "secret roadmap body",
            expectsReply: true,
            createdAt: "2026-07-24T00:00:00.000Z",
          },
        ],
      })
    )
    writeFileSync(
      join(workspace, "threads", "thr_worktable.json"),
      JSON.stringify({
        type: "worktable.thread",
        version: 2,
        id: "thr_worktable",
        location: {
          kind: "worktable",
          private: { note: "thread location secret" },
        },
        revision: 1,
        title: "General thread",
        participants: [],
        messages: [],
      })
    )
    writeFileSync(
      join(appDir, "thread-deliveries", "workspace.json"),
      JSON.stringify({
        deliveries: [
          {
            messageId: "msg_private",
            threadId: "thr_example",
            location: {
              kind: "space",
              spaceId: "product",
              private: { note: "delivery location secret" },
            },
            participantId: "ptc_b",
            state: "failed",
            revision: 4,
            attempts: 3,
            leaseId: "lease_do_not_report",
            error: {
              code: "MODEL_FAILED",
              message: "private provider detail",
              retryable: false,
            },
            createdAt: "2026-07-24T00:00:00.000Z",
            updatedAt: "2026-07-24T00:01:00.000Z",
          },
        ],
      })
    )

    const result = spawnSync(process.execPath, [script], {
      env,
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
    const reportPath = result.stdout.match(/• Report: (.+)/)?.[1]?.trim()
    expect(reportPath).toBeDefined()
    const raw = readFileSync(reportPath!, "utf8")
    const report = JSON.parse(raw)
    expect(report.workspace.changes.added).toEqual([
      "spaces/product/threads/thr_example.json",
      "threads/thr_worktable.json",
    ])
    expect(
      report.threads.find(
        (thread: { id: string }) => thread.id === "thr_example"
      ).messages[0]
    ).toMatchObject({
      id: "msg_private",
      bodyCharacters: 19,
    })
    expect(
      report.threads.find(
        (thread: { id: string }) => thread.id === "thr_worktable"
      ).location
    ).toEqual({ kind: "worktable" })
    expect(report.deliveries[0]).toMatchObject({
      location: { kind: "space", spaceId: "product" },
      state: "failed",
      attempts: 3,
      error: { code: "MODEL_FAILED", retryable: false },
    })
    expect(report.gateway.worktableCompleted).toBe(1)
    expect(raw).not.toContain("secret roadmap body")
    expect(raw).not.toContain("lease_do_not_report")
    expect(raw).not.toContain("private provider detail")
    expect(raw).not.toContain("thread location secret")
    expect(raw).not.toContain("delivery location secret")
  })
})
