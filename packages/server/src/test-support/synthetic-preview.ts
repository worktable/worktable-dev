import { expect, test } from "bun:test"
import * as driver from "playwright-core"
import { createRequire } from "node:module"
import { dirname } from "node:path"
import {
  launchPreviewBrowserProcess,
  resolveHeadlessPreviewExecutable,
} from "../document-preview-process.ts"
import {
  PreviewBrowserPool,
  runWithPreviewBrowserPool,
} from "../document-preview-browser.ts"

/** Controlled, repository-authored fixtures only. Production always requires
 * Chromium sandboxing; this explicit injected launcher lets renderer semantics
 * run on CI/container hosts which forbid namespaces. It cannot be enabled by
 * document content, tool options, or a production runtime environment flag. */
export async function withSyntheticPreview<T>(
  task: () => Promise<T>
): Promise<T> {
  const pool = new PreviewBrowserPool({
    launch: () =>
      launchPreviewBrowserProcess(
        driver,
        resolveHeadlessPreviewExecutable(
          driver,
          dirname(
            createRequire(import.meta.url).resolve(
              "playwright-core/package.json"
            )
          )
        ),
        (command, env) =>
          Bun.spawn([...command, "--no-sandbox"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
            detached: true,
            env,
          })
      ),
  })
  try {
    return await runWithPreviewBrowserPool(pool, task)
  } finally {
    await pool.close()
  }
}

export function previewTest(
  name: string,
  task: () => Promise<void>,
  timeout = 60_000
) {
  test(name, () => withSyntheticPreview(task), timeout)
}

/** Bun 1.3.14's async rejection matcher can lose browser I/O poll events during
 * nested event-loop processing (oven-sh/bun#33261). Await normally, then make
 * synchronous assertions without weakening the expected preview failure. */
export async function expectPreviewError(
  pending: Promise<unknown>,
  message: string
): Promise<void> {
  let received: unknown
  try {
    await pending
  } catch (error) {
    received = error
  }
  expect(received).toBeInstanceOf(Error)
  expect((received as Error).message).toContain(message)
}
