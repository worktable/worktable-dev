import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  outputDir: process.env["WORKTABLE_PLAYWRIGHT_OUTPUT_DIR"] ?? "./test-results",
  testMatch: "**/*.browser.ts",
  fullyParallel: false,
  workers: 2,
  timeout: 60_000,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
})
