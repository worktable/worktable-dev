import { test, expect } from "bun:test"
import { withSyntheticPreview } from "./test-support/synthetic-preview.ts"
import { withPreviewPage } from "./document-preview-browser.ts"

test("managed browser transport survives collection of exited launchers and keeps contexts isolated", async () => {
  // Bun's child_process extra-FD finalizer used to close a later browser's
  // pipes. Exercise real process restarts and collection at that boundary.
  for (let restart = 0; restart < 3; restart++) {
    await withSyntheticPreview(async () => {
      for (let job = 0; job < 2; job++) {
        await withPreviewPage("drawing", async (page) => {
          Bun.gc(true)
          await page.route("https://worktable-preview.invalid/", (route) =>
            route.fulfill({ contentType: "text/html", body: "<p>Preview</p>" })
          )
          await page.goto("https://worktable-preview.invalid/")
          expect(await page.evaluate(() => window.name)).toBe("")
          await page.evaluate(() => {
            window.name = "previous job"
          })
          expect((await page.screenshot()).byteLength).toBeGreaterThan(1000)
        })
      }
    })
  }
}, 30_000)
