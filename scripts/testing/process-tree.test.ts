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
