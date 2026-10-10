import { expect, test } from "bun:test"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type CargoMetadata,
  writeNativeNotices,
} from "../../../scripts/native-notices.ts"
import inventory from "../../../scripts/licenses/native-rust-inventory.json" with { type: "json" }

const repoRoot = resolve(import.meta.dir, "../../..")
const manifest = join(repoRoot, "apps/desktop/src-tauri/Cargo.toml")

// Only the macOS release build writes these notices, so a dependency change
// without a reviewed notice would otherwise surface first on a Mac. Cargo can
// resolve the macOS dependency graph anywhere.
test.skipIf(!Bun.which("cargo"))(
  "every native dependency the macOS app ships has a reviewed notice",
  () => {
    const lockfile = readFileSync(
      join(repoRoot, "apps/desktop/src-tauri/Cargo.lock"),
      "utf8"
    )
    // The release build checks the real toolchain; this covers the crates.
    const sysroot = mkdtempSync(join(tmpdir(), "worktable-notice-sysroot-"))
    try {
      mkdirSync(join(sysroot, "share/doc/rust"), { recursive: true })
      copyFileSync(
        join(repoRoot, "scripts/licenses", inventory.standardLibrary.file),
        join(sysroot, "share/doc/rust/COPYRIGHT-library.html")
      )
      const toolchain = {
        sysroot,
        verboseVersion: `release: ${inventory.standardLibrary.version}\ncommit-hash: ${inventory.standardLibrary.commit}\n`,
      }
      for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
        const result = Bun.spawnSync(
          [
            "cargo",
            "metadata",
            "--locked",
            "--format-version",
            "1",
            "--filter-platform",
            target,
            "--manifest-path",
            manifest,
          ],
          { stdout: "pipe", stderr: "pipe" }
        )
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        const metadata = JSON.parse(result.stdout.toString()) as CargoMetadata
        const destination = join(sysroot, target)
        expect(() =>
          writeNativeNotices(metadata, lockfile, target, destination, toolchain)
        ).not.toThrow()
      }
    } finally {
      rmSync(sysroot, { recursive: true, force: true })
    }
  },
  120_000
)
