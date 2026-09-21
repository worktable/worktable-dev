import { expect, test } from "bun:test"
import {
  descendantProcessGroups,
  processGroupsContainLiveMember,
  processTreeIsAlive,
  signalProcessTree,
  waitForProcessTreeExit,
} from "./process-tree.ts"

test("timeout escalation terminates an isolated descendant process group", async () => {
  if (process.platform === "win32") return

  const script = `
    process.on("SIGTERM", () => {})
    const descendant = Bun.spawn([
      "sh",
      "-c",
      "trap '' TERM; while :; do sleep 1; done",
    ], { detached: true })
    console.log(descendant.pid)
    setInterval(() => {}, 1_000)
  `
  const processHandle = Bun.spawn(["bun", "-e", script], {
    detached: true,
    stdout: "pipe",
    stderr: "inherit",
  })
  const knownGroups = new Set<number>()

  try {
    const firstChunk = await processHandle.stdout.getReader().read()
    const descendantPid = Number(
      new TextDecoder().decode(firstChunk.value).trim()
    )
    expect(descendantPid).toBeGreaterThan(1)
    expect(processTreeIsAlive(processHandle.pid)).toBe(true)

    signalProcessTree(processHandle, "SIGTERM", knownGroups)
    expect(knownGroups.size).toBeGreaterThan(1)
    expect(processTreeIsAlive(processHandle.pid, knownGroups)).toBe(true)

    signalProcessTree(processHandle, "SIGKILL", knownGroups)
    await processHandle.exited
    expect(
      await waitForProcessTreeExit(processHandle.pid, 2_000, knownGroups)
    ).toBe(true)
  } finally {
    signalProcessTree(processHandle, "SIGKILL", knownGroups)
    await processHandle.exited
  }
})

test("zombie-only process groups are not considered alive", () => {
  const rows = [
    { pid: 10, parentPid: 1, groupId: 10, state: "Z" },
    { pid: 11, parentPid: 10, groupId: 11, state: "Z+" },
    { pid: 12, parentPid: 10, groupId: 12, state: "S" },
  ]
  expect(descendantProcessGroups(10, rows)).toEqual(new Set([10, 11, 12]))
  expect(processGroupsContainLiveMember(new Set([10, 11]), rows)).toBe(false)
  expect(processGroupsContainLiveMember(new Set([10, 12]), rows)).toBe(true)
})

test("a failed companion cancels the active lane and cleans its descendants", async () => {
  if (process.platform === "win32") return
  const { runCommand } = await import("./command.ts")
  const { runSuiteSchedule } = await import("./schedule.ts")
  const { mkdtemp, readFile, rm, watch } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = await mkdtemp(join(tmpdir(), "suite-cancellation-"))
  const ready = join(root, "ready.json")
  let outcome: Awaited<ReturnType<typeof runCommand>> | undefined
  const script = `
    const child = Bun.spawn(["sh", "-c", "while :; do sleep 1; done"], { detached: true });
    await Bun.write(${JSON.stringify(ready)}, JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);
  `
  try {
    const seen: string[] = []
    const failed = await runSuiteSchedule(
      ["bun-server", "bun-standard", "cli-boundary"].map((id) => ({ id })),
      async ({ id }, signal) => {
        seen.push(id)
        if (id === "bun-server") {
          outcome = await runCommand(
            { executable: "bun", args: ["-e", script], cwd: root },
            10_000,
            join(root, "rss.txt"),
            signal
          )
          return outcome.exitCode !== 0
        }
        const readiness = new AbortController()
        const events = watch(root, {
          signal: AbortSignal.any([
            readiness.signal,
            AbortSignal.timeout(8_000),
          ]),
        })
        try {
          if (!(await Bun.file(ready).exists())) {
            for await (const _event of events) {
              if (await Bun.file(ready).exists()) break
            }
          }
        } finally {
          readiness.abort()
        }
        return true
      }
    )
    expect(failed).toBe(true)
    expect(seen).not.toContain("cli-boundary")
    expect(outcome?.cancelled).toBe(true)
    expect(outcome?.timedOut).toBe(false)
    const pids: number[] = JSON.parse(await readFile(ready, "utf8"))
    for (const pid of pids) expect(processTreeIsAlive(pid)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)


test("a command timeout notifies its owner before completion and retains the cause after abort", async () => {
  const { runCommand } = await import("./command.ts")
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = await mkdtemp(join(tmpdir(), "suite-timeout-"))
  const cancellation = new AbortController()
  let notified = false
  let completed = false
  try {
    const outcome = await runCommand(
      { executable: "bun", args: ["-e", "setInterval(() => {}, 1000)"], cwd: root },
      10,
      join(root, "rss.txt"),
      cancellation.signal,
      () => {
        expect(completed).toBe(false)
        notified = true
        cancellation.abort()
      }
    )
    completed = true
    expect(notified).toBe(true)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.cancelled).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
