import { expect, test } from "bun:test"
import fc from "fast-check"
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  verifyCompiledJsNotices,
  writeCompiledJsNotices,
} from "./compiled-js-notices"

test("compiled notice gate follows real bundle contributors and rejects source or archive drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktable-notice-gate-"))
  try {
    const dependency = join(root, "node_modules/fast-deep-equal")
    cpSync(
      join(import.meta.dir, "../node_modules/fast-deep-equal"),
      dependency,
      {
        recursive: true,
        dereference: true,
      }
    )
    const entry = join(root, "entry.ts")
    writeFileSync(
      entry,
      'import equal from "fast-deep-equal"; console.log(equal([1], [2]));'
    )
    const build = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      metafile: true,
    })
    expect(build.success).toBe(true)
    const manifestPath = join(dependency, "package.json")
    const licensePath = join(dependency, "LICENSE")
    // Package-manager caches may be read-only. Only the disposable copies mutate.
    chmodSync(manifestPath, 0o600)
    chmodSync(licensePath, 0o600)
    const manifest = readFileSync(manifestPath)
    const license = readFileSync(licensePath)
    const pkg = JSON.parse(manifest.toString())
    const secondDependency = join(root, "node_modules/nanoid")
    cpSync(join(import.meta.dir, "../node_modules/nanoid"), secondDependency, {
      recursive: true,
      dereference: true,
    })
    const secondEntry = join(root, "second.ts")
    writeFileSync(
      secondEntry,
      'import { nanoid } from "nanoid"; console.log(nanoid());'
    )
    const secondBuild = await Bun.build({
      entrypoints: [secondEntry],
      target: "bun",
      metafile: true,
    })
    expect(secondBuild.success).toBe(true)
    const secondPkg = JSON.parse(
      readFileSync(join(secondDependency, "package.json"), "utf8")
    )
    const destination = join(root, "release")
    const write = () =>
      writeCompiledJsNotices(
        [build.metafile!, secondBuild.metafile!],
        process.cwd(),
        destination
      )
    write()
    expect(verifyCompiledJsNotices(destination)).toBe(2)
    // Public metadata has only the schema and contributing package identities.
    // Neither the private build root nor raw Bun input paths belong in an archive.
    const recordPath = join(destination, "licenses/bundled-javascript.json")
    const noticePath = join(
      destination,
      "licenses/bundled-javascript-NOTICES.md"
    )
    expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual({
      schemaVersion: 1,
      packages: [
        `${pkg.name}@${pkg.version}`,
        `${secondPkg.name}@${secondPkg.version}`,
      ].sort(),
    })
    const record = readFileSync(recordPath)
    const notices = readFileSync(noticePath)
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (suffix) => {
        for (const change of [
          "version",
          "license",
          "source-notice",
          "archive-notice",
          "archive-inventory",
          "archive-metadata",
        ]) {
          try {
            if (change === "version" || change === "license") {
              writeFileSync(
                manifestPath,
                JSON.stringify({ ...pkg, [change]: `unreviewed-${suffix}` })
              )
              expect(write).toThrow()
            } else if (change === "source-notice") {
              writeFileSync(
                licensePath,
                Buffer.concat([license, Buffer.from(suffix)])
              )
              expect(write).toThrow()
            } else {
              if (change === "archive-notice")
                writeFileSync(
                  noticePath,
                  Buffer.concat([notices, Buffer.from(suffix)])
                )
              else if (change === "archive-metadata")
                writeFileSync(
                  recordPath,
                  JSON.stringify({
                    ...JSON.parse(record.toString()),
                    buildPath: root,
                  })
                )
              else
                writeFileSync(
                  recordPath,
                  JSON.stringify({
                    schemaVersion: 1,
                    packages: [`unreviewed-${suffix}`],
                  })
                )
              expect(() => verifyCompiledJsNotices(destination)).toThrow()
            }
          } finally {
            writeFileSync(manifestPath, manifest)
            writeFileSync(licensePath, license)
            writeFileSync(recordPath, record)
            writeFileSync(noticePath, notices)
          }
        }
      }),
      { numRuns: 10 }
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
