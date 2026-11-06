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
  /^packages\/server\/src\/(?:bridge|connector|drawing-render)-e2e\.test\.ts$/
const serverTest = /^packages\/server\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/
const bunTest = /\.(?:test|spec)\.[cm]?[jt]sx?$/

// Web browser journeys run as three suites on separate CI runners, each with
// one worker as before. The shards are balanced by measured duration (about
// five minutes each on a GitHub runner); the last one also owns every file not
// listed here. `--suite web-browser` still selects all of them.
const webBrowserShards: string[][] = [
  [
    "visitor-comments.browser.ts",
    "onboarding.browser.ts",
    "doc-links.browser.ts",
    "version-history.browser.ts",
    "account.browser.ts",
    "document-layout.browser.ts",
    "sidebar-organization.browser.ts",
  ],
  [
    "drawing.browser.ts",
    "agents.browser.ts",
    "threads.browser.ts",
    "annotations.browser.ts",
    "update-notifications.browser.ts",
    "worktable-menu.browser.ts",
    "public-share-comments.browser.ts",
    "share-runtime.browser.ts",
    "share-broker.browser.ts",
  ],
  [],
]
export const webBrowserSuiteIds = webBrowserShards.map(
  (_, index) => `web-${index + 1}-browser`
)

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
  ...webBrowserShards.map(
    (files, index): TestSuite => ({
      id: webBrowserSuiteIds[index]!,
      title: `Web browser behavior (${index + 1} of ${webBrowserShards.length})`,
      runner: "playwright",
      classification: "boundary",
      profiles: ["changed", "full"],
      cwd: "apps/web",
      owns: (path) => {
        if (!webBrowserTest.test(path)) return false
        const name = path.slice("apps/web/e2e/".length)
        const listed = webBrowserShards.findIndex((shard) =>
          shard.includes(name)
        )
        // Unlisted files, including new ones, belong to the last shard.
        return listed === -1
          ? index === webBrowserShards.length - 1
          : listed === index
      },
    })
  ),
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
