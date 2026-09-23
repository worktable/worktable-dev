import { publicTestSuites } from "./public-suites.ts"
import { selectPublicSuiteIds } from "./public-selection.ts"

export const projectTestSuites = publicTestSuites
export const selectChangedSuiteIds = selectPublicSuiteIds
