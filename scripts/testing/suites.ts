import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { relative, resolve } from "node:path"
import { projectTestSuites, selectChangedSuiteIds } from "./project.ts"
import type { TestProfile, TestSuite } from "./public-suites.ts"
export type {
  TestProfile,
  TestSuite,
  TestClassification,
  SuiteRunner,
} from "./public-suites.ts"

export const repositoryRoot = resolve(import.meta.dir, "../..")

export const testSuites = projectTestSuites

export function listRepositoryFiles(): string[] {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: repositoryRoot, encoding: "utf8" }
  )
    .split("\n")
    .map((path) => path.trim())
    .filter(
      (path) => Boolean(path) && existsSync(resolve(repositoryRoot, path))
    )
    .sort()
}

export function isRecognizedTestFile(path: string): boolean {
  return /(?:\.(?:test|spec)\.[cm]?[jt]sx?|\.browser\.ts|\.vitest\.ts|_test\.go)$/.test(
    path
  )
}

export function ownedTestFiles(
  suite: TestSuite,
  files = listRepositoryFiles()
): string[] {
  return files.filter((path) => suite.owns(path))
}

export function suitesForProfile(
  profile: TestProfile,
  changedFiles: string[] = []
): TestSuite[] {
  const changedSuiteIds =
    profile === "changed"
      ? new Set(selectChangedSuiteIds(changedFiles))
      : undefined
  return testSuites.filter((suite) => {
    if (!suite.profiles.includes(profile)) return false
    if (profile !== "changed") return true
    return changedSuiteIds?.has(suite.id) ?? false
  })
}

export function pathFromSuiteCwd(suite: TestSuite, path: string): string {
  if (!suite.cwd) return path
  return relative(
    resolve(repositoryRoot, suite.cwd),
    resolve(repositoryRoot, path)
  )
}
