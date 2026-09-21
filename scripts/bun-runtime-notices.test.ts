import { expect, test } from "bun:test"
import fc from "fast-check"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertReviewedBunRuntime,
  verifyBunRuntimeNotices,
  writeBunRuntimeNotices,
} from "./bun-runtime-notices"

test("Bun notice gate rejects unreviewed runtimes and altered outgoing notices or metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "worktable-bun-notices-"))
  try {
    const runtime = {
      version: "1.3.14",
      revision: "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
    }
    writeBunRuntimeNotices(runtime, "bun-linux-x64-baseline", root)
    expect(verifyBunRuntimeNotices(root)).toBe(3)
    const metadataPath = join(root, "licenses/bun-runtime.json")
    const noticePath = join(root, "licenses/bun-runtime-NOTICES.md")
    const rustPath = join(
      root,
      "licenses/bun-rust-nightly-COPYRIGHT-library.html"
    )
    const recordBytes = readFileSync(metadataPath)
    const record = JSON.parse(recordBytes.toString())
    expect(record).toEqual({
      schemaVersion: 1,
      runtime: "Bun",
      version: runtime.version,
      sourceCommit: runtime.revision,
    })
    const notices = readFileSync(noticePath)
    const rust = readFileSync(rustPath)
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (suffix) => {
        expect(() =>
          assertReviewedBunRuntime({ ...runtime, version: `new-${suffix}` })
        ).toThrow()
        expect(() =>
          assertReviewedBunRuntime({ ...runtime, revision: `new-${suffix}` })
        ).toThrow()
        expect(() =>
          writeBunRuntimeNotices(runtime, `new-${suffix}`, root)
        ).toThrow()
        try {
          for (const mutation of [
            { ...record, version: `new-${suffix}` },
            { ...record, sourceCommit: `new-${suffix}` },
            { ...record, runtime: `new-${suffix}` },
            { ...record, buildPath: `${root}/${suffix}` },
            null,
          ]) {
            writeFileSync(metadataPath, JSON.stringify(mutation))
            expect(() => verifyBunRuntimeNotices(root)).toThrow()
          }
          writeFileSync(metadataPath, recordBytes)
          writeFileSync(
            noticePath,
            Buffer.concat([notices, Buffer.from(suffix)])
          )
          expect(() => verifyBunRuntimeNotices(root)).toThrow()
          writeFileSync(noticePath, notices)
          writeFileSync(rustPath, Buffer.concat([rust, Buffer.from(suffix)]))
          expect(() => verifyBunRuntimeNotices(root)).toThrow()
        } finally {
          writeFileSync(metadataPath, recordBytes)
          writeFileSync(noticePath, notices)
          writeFileSync(rustPath, rust)
        }
      }),
      { numRuns: 6 }
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
