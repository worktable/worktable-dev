import { resolve } from "node:path"

export async function finalizeDesktopRelease(
  run: (script: string) => Promise<void>
): Promise<void> {
  // Tauri has already notarized the app and produced the updater archive.
  // Each distributable still owns its checks; neither can publish alone.
  const branches = await Promise.allSettled([
    (async () => {
      await run("finalize-release-dmg.ts")
      await run("verify-release-dmg.ts")
    })(),
    (async () => {
      await run("prepare-updater-release.ts")
      await run("verify-release-updater.ts")
    })(),
  ])
  const failures = branches.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  )
  if (failures.length)
    throw new AggregateError(failures, "Desktop release finalization failed")
}

if (import.meta.main) {
  if (process.platform !== "darwin")
    throw new Error("Desktop finalization requires macOS")
  await finalizeDesktopRelease(async (script) => {
    const started = performance.now()
    const child = Bun.spawn([process.execPath, "run", `scripts/${script}`], {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = await child.exited
    console.log(
      `[release-phase] ${script}: ${((performance.now() - started) / 1000).toFixed(3)}s; exit=${exitCode}`
    )
    if (exitCode !== 0)
      throw new Error(`${script} failed with exit code ${exitCode}`)
  })
}
