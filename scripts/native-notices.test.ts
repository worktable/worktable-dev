import { expect, test } from "bun:test"
import fc from "fast-check"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyNativeNotices, writeNativeNotices } from "./native-notices"
import type { CargoMetadata } from "./native-notices"
import inventory from "./licenses/native-rust-inventory.json" with { type: "json" }

test("native notices follow normal Cargo edges and reject source, notice and outgoing metadata drift", () => {
  const root = mkdtempSync(join(tmpdir(), "worktable-native-notice-gate-"))
  try {
    const packages = ["adler2", "cpufeatures"].map(
      (name) =>
        inventory.packages.find(
          (p) =>
            p.name === name && (name !== "cpufeatures" || p.version === "0.3.0")
        )!
    )
    const source = "registry+https://github.com/rust-lang/crates.io-index"
    const metadata: CargoMetadata = {
      packages: [
        {
          id: "app",
          name: "app",
          version: "1",
          license: null,
          source: null,
          manifest_path: join(root, "Cargo.toml"),
        },
      ],
      resolve: {
        root: "app",
        nodes: [
          {
            id: "app",
            deps: [
              { pkg: packages[0]!.name, dep_kinds: [{ kind: null }] },
              {
                pkg: "unreviewed-build-tool",
                dep_kinds: [{ kind: "build" }, { kind: "dev" }],
              },
            ],
          },
        ],
      },
    }
    for (const [index, pkg] of packages.entries()) {
      const directory = join(root, pkg.name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, "Cargo.toml"),
        `[package]\nname = "${pkg.name}"\nversion = "${pkg.version}"\nlicense = "${pkg.license}"\n`
      )
      for (const notice of pkg.notices) {
        if ("file" in notice)
          writeFileSync(join(directory, notice.file!), notice.text)
      }
      metadata.packages.push({
        id: pkg.name,
        name: pkg.name,
        version: pkg.version,
        source,
        license: pkg.license,
        manifest_path: join(directory, "Cargo.toml"),
      })
      metadata.resolve.nodes.push({
        id: pkg.name,
        deps:
          index === 0
            ? [{ pkg: packages[1]!.name, dep_kinds: [{ kind: null }] }]
            : [],
      })
    }
    metadata.packages.push({
      id: "unreviewed-build-tool",
      name: "unreviewed-build-tool",
      version: "1.0.0",
      source,
      license: "MIT",
      manifest_path: join(root, "build-tool", "Cargo.toml"),
    })
    metadata.resolve.nodes.push({ id: "unreviewed-build-tool", deps: [] })
    const lock = packages
      .map(
        (p) =>
          `[[package]]\nname = "${p.name}"\nversion = "${p.version}"\nsource = "${source}"\nchecksum = "${p.crateSha256}"\n`
      )
      .join("\n")
    const target = "x86_64-apple-darwin"
    const output = join(root, "release")
    const toolchain = {
      sysroot: join(root, "toolchain"),
      verboseVersion: `release: ${inventory.standardLibrary.version}\ncommit-hash: ${inventory.standardLibrary.commit}\n`,
    }
    const installedStandardNotice = join(
      toolchain.sysroot,
      "share/doc/rust/COPYRIGHT-library.html"
    )
    mkdirSync(join(toolchain.sysroot, "share/doc/rust"), { recursive: true })
    const standardNotice = readFileSync(
      join(import.meta.dir, "licenses", inventory.standardLibrary.file)
    )
    writeFileSync(installedStandardNotice, standardNotice)
    writeNativeNotices(metadata, lock, target, output, toolchain)
    verifyNativeNotices(output, target)
    const recordPath = join(output, "licenses/native-rust.json")
    const noticePath = join(output, "licenses/native-rust-NOTICES.md")
    const standardNoticePath = join(
      output,
      "licenses/rust-standard-library-COPYRIGHT.html"
    )
    const record = readFileSync(recordPath)
    const notices = readFileSync(noticePath)
    expect(JSON.parse(record.toString())).toEqual({
      schemaVersion: 1,
      target,
      rustVersion: inventory.standardLibrary.version,
      packages: packages.map((p) => `${p.name}@${p.version}`).sort(),
    })
    const installedNotice = join(
      root,
      packages[0]!.name,
      packages[0]!.notices.find((n) => "file" in n)!.file!
    )
    const originalNotice = readFileSync(installedNotice)
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (suffix) => {
        for (const mutation of [
          "version",
          "license",
          "checksum",
          "normal-edge",
          "source-notice",
          "archive-notice",
          "archive-metadata",
          "target",
          "rust-version",
          "rust-notice",
          "archive-stdlib",
        ]) {
          const changed = structuredClone(metadata)
          try {
            if (mutation === "version" || mutation === "license") {
              changed.packages[1]![mutation] = `unreviewed-${suffix}`
            } else if (mutation === "normal-edge") {
              changed.resolve.nodes[0]!.deps[1]!.dep_kinds.push({ kind: null })
            } else if (mutation === "source-notice") {
              writeFileSync(
                installedNotice,
                Buffer.concat([originalNotice, Buffer.from(suffix)])
              )
            } else if (mutation === "archive-notice") {
              writeFileSync(
                noticePath,
                Buffer.concat([notices, Buffer.from(suffix)])
              )
            } else if (mutation === "archive-metadata") {
              writeFileSync(
                recordPath,
                JSON.stringify({
                  ...JSON.parse(record.toString()),
                  buildPath: root,
                })
              )
            } else if (
              mutation === "rust-notice" ||
              mutation === "archive-stdlib"
            ) {
              writeFileSync(
                mutation === "rust-notice"
                  ? installedStandardNotice
                  : standardNoticePath,
                Buffer.concat([standardNotice, Buffer.from(suffix)])
              )
            }
            if (mutation.startsWith("archive-") || mutation === "target") {
              expect(() =>
                verifyNativeNotices(
                  output,
                  mutation === "target" ? "aarch64-apple-darwin" : target
                )
              ).toThrow()
            } else {
              expect(() =>
                writeNativeNotices(
                  changed,
                  mutation === "checksum"
                    ? lock.replace(packages[0]!.crateSha256, "0".repeat(64))
                    : lock,
                  target,
                  output,
                  mutation === "rust-version"
                    ? {
                        ...toolchain,
                        verboseVersion: `release: unreviewed-${suffix}\n`,
                      }
                    : toolchain
                )
              ).toThrow()
            }
          } finally {
            writeFileSync(installedNotice, originalNotice)
            writeFileSync(recordPath, record)
            writeFileSync(noticePath, notices)
            writeFileSync(installedStandardNotice, standardNotice)
            writeFileSync(standardNoticePath, standardNotice)
          }
        }
      }),
      { numRuns: 10 }
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
