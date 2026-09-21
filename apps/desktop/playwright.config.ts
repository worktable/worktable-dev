import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  outputDir: process.env["WORKTABLE_PLAYWRIGHT_OUTPUT_DIR"] ?? "./test-results",
  testMatch: "**/*.browser.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:15321",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run scripts/serve-ui.ts",
    url: "http://127.0.0.1:15321",
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
