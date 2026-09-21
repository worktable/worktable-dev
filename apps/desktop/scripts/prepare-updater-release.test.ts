import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  prepareDesktopUpdaterRelease,
  renderDesktopUpdaterNotes,
} from "./prepare-updater-release"

const roots: string[] = []

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "worktable-updater-release-"))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

describe("Desktop updater release feed", () => {
  test("publishes immutable signed Apple silicon updater assets", () => {
    const root = temporaryDirectory()
    const sourceBundle = join(root, "Worktable.app.tar.gz")
    const sourceSignature = `${sourceBundle}.sig`
    const releaseDirectory = join(root, "release")
    writeFileSync(sourceBundle, "signed application archive")
    writeFileSync(sourceSignature, "detached-signature\n")

    const prepared = prepareDesktopUpdaterRelease({
      appVersion: "0.0.46",
      tag: "v0.0.46",
      pubDate: "2026-07-29T12:34:56+00:00",
      releaseNotes: "Native Worktable Cloud.",
      releaseDirectory,
      updaterBundlePath: sourceBundle,
      updaterSignaturePath: sourceSignature,
    })

    expect(readFileSync(prepared.bundlePath, "utf8")).toBe(
      "signed application archive"
    )
    expect(readFileSync(prepared.signaturePath, "utf8")).toBe(
      "detached-signature\n"
    )
    expect(prepared.feed).toEqual({
      version: "0.0.46",
      notes: "Native Worktable Cloud.",
      pub_date: "2026-07-29T12:34:56.000Z",
      platforms: {
        "darwin-aarch64": {
          signature: "detached-signature",
          url: "https://worktable.dev/releases/v0.0.46/worktable-desktop-darwin-arm64.app.tar.gz",
        },
      },
    })
    expect(JSON.parse(readFileSync(prepared.feedPath, "utf8"))).toEqual(
      prepared.feed
    )
  })

  test("fails closed on version, publication date, notes, and signature", () => {
    const root = temporaryDirectory()
    const sourceBundle = join(root, "Worktable.app.tar.gz")
    const sourceSignature = `${sourceBundle}.sig`
    writeFileSync(sourceBundle, "archive")
    writeFileSync(sourceSignature, "signature")
    const base = {
      appVersion: "0.0.45",
      tag: "v0.0.45",
      pubDate: "2026-07-29T12:34:56Z",
      releaseNotes: "Signed updates.",
      releaseDirectory: join(root, "release"),
      updaterBundlePath: sourceBundle,
      updaterSignaturePath: sourceSignature,
    }

    expect(() =>
      prepareDesktopUpdaterRelease({ ...base, appVersion: "0.0.45-beta.1" })
    ).toThrow("must be stable semver")
    expect(() =>
      prepareDesktopUpdaterRelease({ ...base, tag: "v0.0.46" })
    ).toThrow("does not match application version")
    expect(() =>
      prepareDesktopUpdaterRelease({ ...base, pubDate: "next Tuesday" })
    ).toThrow("is not RFC3339")
    expect(() =>
      prepareDesktopUpdaterRelease({ ...base, releaseNotes: " " })
    ).toThrow("release notes are empty")

    writeFileSync(sourceSignature, "\n")
    expect(() => prepareDesktopUpdaterRelease(base)).toThrow(
      "detached signature is empty"
    )
  })

  test("renders release Markdown as concise plain text", () => {
    expect(
      renderDesktopUpdaterNotes(`## Added

- **Signed Desktop updates:** review [what changed](https://docs.worktable.dev/) before installing \`v0.0.46\`.

---

**Desktop for Apple silicon:** [Download](https://example.com).

\`\`\`sh
curl https://example.com
\`\`\`
`)
    ).toBe(
      "Added\n\n• Signed Desktop updates: review what changed before installing v0.0.46."
    )
  })
})
