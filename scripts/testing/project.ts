import { publicTestSuites } from "./public-suites.ts"

export const projectTestSuites = publicTestSuites

// Until a public change planner has its own evidence owner, changes run every
// public lane. No private planner or operator infrastructure is required.
export function selectChangedSuiteIds(_files: string[]): string[] {
  return publicTestSuites.filter((suite) => suite.profiles.includes("changed")).map((suite) => suite.id)
}
