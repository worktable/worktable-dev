import { createHash } from "node:crypto"
import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"

function nativeFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return nativeFiles(path)
    if (!entry.isFile()) return []
    const fd = openSync(path, "r")
    const magic = Buffer.alloc(4)
    try {
      if (readSync(fd, magic, 0, 4, 0) !== 4) return []
    } finally {
      closeSync(fd)
    }
    return [
      0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
    ].includes(magic.readUInt32BE())
      ? [path]
      : []
  })
}

export function signPreviewRuntime(
  root: string,
  options: {
    identity?: string
    release: boolean
    run: (command: string[]) => void
  }
): void {
  const identity = options.identity?.trim() || "-"
  if (options.release && !identity.startsWith("Developer ID Application:"))
    throw new Error(
      "Desktop releases require APPLE_SIGNING_IDENTITY for nested preview browser signing; install that identity in the build keychain before bundling"
    )
  const manifestPath = join(root, "manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const executable = join(root, manifest.executable)
  const binaries = nativeFiles(join(root, "browser")).sort(
    (a, b) => Number(a === executable) - Number(b === executable)
  )
  if (!binaries.includes(executable))
    throw new Error("Desktop preview runtime has no native browser executable")
  for (const binary of binaries) {
    // Preserve Chromium's existing JIT entitlements; never invent broader ones.
    // Existing requirements name the upstream signing team, so do not preserve them.
    options.run([
      "codesign",
      "--force",
      "--sign",
      identity,
      "--options",
      "runtime",
      "--preserve-metadata=entitlements,flags",
      ...(identity === "-" ? [] : ["--timestamp"]),
      binary,
    ])
    options.run(["codesign", "--verify", "--strict", "--verbose=2", binary])
  }
  manifest.upstreamExecutableSha256 ??= manifest.executableSha256
  manifest.executableSha256 = createHash("sha256")
    .update(readFileSync(executable))
    .digest("hex")
  manifest.signingIdentity = identity
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
}

if (import.meta.main) {
  if (process.platform !== "darwin")
    throw new Error("Desktop browser signing requires macOS")
  signPreviewRuntime(
    resolve(
      import.meta.dir,
      "../src-tauri/generated/runtime/worktable/preview-runtime"
    ),
    {
      identity: process.env.APPLE_SIGNING_IDENTITY,
      release:
        process.argv.includes("--release") ||
        process.env.WORKTABLE_DESKTOP_REQUIRE_DEVELOPER_ID === "1",
      run(command) {
        const result = Bun.spawnSync(command, {
          stdout: "pipe",
          stderr: "pipe",
        })
        if (!result.success)
          throw new Error(
            `Nested preview browser signing failed: ${result.stderr.toString()}`
          )
      },
    }
  )
}
