export type TestProfile = "required" | "changed" | "full" | "stability" | "host"

export type TestClassification = "standard" | "integration" | "boundary"

export type SuiteRunner =
  | "bun"
  | "vitest"
  | "playwright"
  | "go"
  | "desktop"
  | "host-go"

export interface TestSuite {
  id: string
  title: string
  runner: SuiteRunner
  classification: TestClassification
  profiles: TestProfile[]
  cwd?: string
  owns(path: string): boolean
}

const webBrowserTest = /^apps\/web\/e2e\/.+\.browser\.ts$/
const desktopBrowserTest = /^apps\/desktop\/e2e\/.+\.browser\.ts$/
const desktopTest = /^apps\/desktop\/scripts\/.+\.test\.ts$/
const cliBoundaryTest =
  /^apps\/cli\/src\/(?:(?:index|local-host)(?:\.journey)?|[a-z0-9-]+\.journey)\.test\.ts$/
const packagedBoundaryTest =
  /^packages\/server\/src\/(?:bridge|connector)-e2e\.test\.ts$/
const serverTest = /^packages\/server\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/
const bunTest = /\.(?:test|spec)\.[cm]?[jt]sx?$/

export const publicTestSuites: TestSuite[] = [
  {
    id: "bun-standard",
    title: "Standard Bun tests",
    runner: "bun",
    classification: "standard",
    profiles: ["required", "changed", "full"],
    owns: (path) =>
      bunTest.test(path) &&
      !serverTest.test(path) &&
      !desktopTest.test(path) &&
      !cliBoundaryTest.test(path),
  },
  {
    id: "bun-server",
    title: "Server integration tests",
    runner: "bun",
    classification: "integration",
    profiles: ["required", "changed", "full"],
    cwd: "packages/server",
    owns: (path) => serverTest.test(path) && !packagedBoundaryTest.test(path),
  },
  {
    id: "cli-boundary",
    title: "CLI command and subprocess journeys",
    runner: "bun",
    classification: "boundary",
    profiles: ["required", "changed", "full", "stability"],
    owns: (path) => cliBoundaryTest.test(path),
  },
  {
    id: "packaged-boundaries",
    title: "Packaged connector and bridge boundaries",
    runner: "bun",
    classification: "boundary",
    profiles: ["required", "changed", "full", "stability"],
    cwd: "packages/server",
    owns: (path) => packagedBoundaryTest.test(path),
  },
  {
    id: "desktop-contracts",
    title: "Desktop and Rust contracts",
    runner: "desktop",
    classification: "boundary",
    profiles: ["changed", "full"],
    owns: (path) => desktopTest.test(path),
  },
  {
    id: "web-browser",
    title: "Web browser behavior",
    runner: "playwright",
    classification: "boundary",
    profiles: ["changed", "full"],
    cwd: "apps/web",
    owns: (path) => webBrowserTest.test(path),
  },
  {
    id: "desktop-browser",
    title: "Desktop onboarding browser behavior",
    runner: "playwright",
    classification: "boundary",
    profiles: ["changed", "full"],
    cwd: "apps/desktop",
    owns: (path) => desktopBrowserTest.test(path),
  },
]
