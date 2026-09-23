import { createHash } from "node:crypto"
import { join } from "node:path"

export interface TestSelection {
  profile: string
  suites: string[]
  testFiles: string[]
  testPathPrefixes: string[]
}

export interface BunTestCommand {
  config: string
  files: string[]
  junit: string
  stabilityRepeat?: number
}

export interface VitestCommand {
  files: string[]
  junit: string
  config?: string
}

export function isTargetedSelection(selection: TestSelection): boolean {
  return (
    selection.suites.length > 0 ||
    selection.testFiles.length > 0 ||
    selection.testPathPrefixes.length > 0
  )
}

export function canonicalResultDirectory(
  canonicalRoot: string,
  selection: TestSelection
): string {
  if (!isTargetedSelection(selection)) {
    return join(canonicalRoot, selection.profile)
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        suites: [...selection.suites].sort(),
        testFiles: [...selection.testFiles].sort(),
        testPathPrefixes: [...selection.testPathPrefixes].sort(),
      })
    )
    .digest("hex")
    .slice(0, 12)
  return join(canonicalRoot, "targeted", selection.profile, fingerprint)
}

export function unmatchedTestFilters(
  ownedFiles: string[],
  testFiles: string[],
  testPathPrefixes: string[]
): string[] {
  return [
    ...testFiles
      .filter((requested) => !ownedFiles.includes(requested))
      .map((requested) => `test file ${requested}`),
    ...testPathPrefixes
      .filter(
        (requested) => !ownedFiles.some((path) => path.startsWith(requested))
      )
      .map((requested) => `test path prefix ${requested}`),
  ]
}

export function selectedTestFiles(
  ownedFiles: string[],
  testFiles: string[],
  testPathPrefixes: string[]
): string[] {
  if (testFiles.length === 0 && testPathPrefixes.length === 0) {
    return ownedFiles
  }
  return ownedFiles.filter(
    (path) =>
      testFiles.includes(path) ||
      testPathPrefixes.some((prefix) => path.startsWith(prefix))
  )
}

export function bunTestArguments(command: BunTestCommand): string[] {
  const args = [`--config=${command.config}`, "test", ...command.files]
  if (command.stabilityRepeat !== undefined) {
    args.push("--randomize", `--rerun-each=${command.stabilityRepeat}`)
  }
  args.push("--reporter=junit", `--reporter-outfile=${command.junit}`)
  return args
}

export function vitestArguments(command: VitestCommand): string[] {
  return [
    "run",
    "vitest",
    "run",
    ...(command.config === undefined ? [] : ["--config", command.config]),
    ...command.files,
    "--reporter=default",
    "--reporter=junit",
    `--outputFile.junit=${command.junit}`,
  ]
}

// Go exits successfully for an unmatched -run filter or a skipped live test.
export function hasExecutedGoTests(output: string): boolean {
  try {
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        const event = JSON.parse(line) as { Action?: string; Test?: string }
        return event.Action === "pass" && Boolean(event.Test)
      })
  } catch {
    return false
  }
}
