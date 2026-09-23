#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { bunTestArguments } from "./run-policy.ts"
import { repositoryRoot } from "./suites.ts"

interface PhaseResult {
  phase: string
  command: string
  durationMs: number
  exitCode: number
}

const resultDirectory = resolve(
  repositoryRoot,
  process.argv[2] ?? "test-results/canonical/full"
)
const desktopRoot = resolve(repositoryRoot, "apps/desktop")
await mkdir(resultDirectory, { recursive: true })

const manifest = resolve(repositoryRoot, "apps/desktop/src-tauri/Cargo.toml")
// Linux can compile and run the Rust contracts, but the packaged sidecar and
// runtime resources are produced only by the macOS release build. Keep those
// real paths under the existing host-config contract while using the checked-in
// icon source that the macOS preparation step copies into the generated bundle.
const rustContractEnvironment =
  process.platform === "darwin"
    ? process.env
    : {
        ...process.env,
        TAURI_CONFIG: JSON.stringify({
          bundle: {
            externalBin: [],
            icon: [resolve(repositoryRoot, "apps/web/public/pwa-512x512.png")],
            resources: null,
          },
        }),
      }
const phases: Array<{
  phase: string
  executable: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}> = [
  {
    phase: "desktop-bun-contracts",
    executable: "bun",
    args: bunTestArguments({
      config: resolve(repositoryRoot, "scripts/testing/bunfig.standard.toml"),
      files: ["apps/desktop/scripts"],
      junit: join(resultDirectory, "desktop-contracts.junit.xml"),
    }),
  },
  {
    phase: "rustfmt",
    executable: "cargo",
    args: ["fmt", "--manifest-path", manifest, "--check"],
    cwd: desktopRoot,
  },
  {
    phase: "rust-test",
    executable: "cargo",
    args: ["test", "--manifest-path", manifest, "--bins", "--examples"],
    cwd: desktopRoot,
    env: rustContractEnvironment,
  },
  {
    phase: "rust-clippy",
    executable: "cargo",
    args: [
      "clippy",
      "--manifest-path",
      manifest,
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
    cwd: desktopRoot,
    env: rustContractEnvironment,
  },
]

const results: PhaseResult[] = []
for (const phase of phases) {
  const started = performance.now()
  let exitCode: number
  try {
    const child = Bun.spawn([phase.executable, ...phase.args], {
      cwd: phase.cwd ?? repositoryRoot,
      env: phase.env ?? process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    exitCode = await child.exited
  } catch (error) {
    console.error(
      `${phase.phase} could not start: ${error instanceof Error ? error.message : String(error)}`
    )
    exitCode = 127
  }
  results.push({
    phase: phase.phase,
    command: [phase.executable, ...phase.args].join(" "),
    durationMs: performance.now() - started,
    exitCode,
  })
  if (exitCode !== 0) break
}

await writeFile(
  join(resultDirectory, "desktop-contracts.rust.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      phases: results,
    },
    null,
    2
  )}\n`
)
if (
  results.length !== phases.length ||
  results.some((result) => result.exitCode !== 0)
) {
  process.exit(1)
}
