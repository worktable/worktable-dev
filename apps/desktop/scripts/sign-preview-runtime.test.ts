import { expect, test } from "bun:test"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { signPreviewRuntime } from "./sign-preview-runtime"

test("release signing requires an identity, signs only native code and preserves upstream entitlement scope", () => {
  const root = mkdtempSync(join(tmpdir(), "preview-signing-"))
  try {
    mkdirSync(join(root, "browser"))
    const executable = join(root, "browser", "chrome-headless-shell")
    const library = join(root, "browser", "libEGL.dylib")
    writeFileSync(executable, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1]))
    writeFileSync(library, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 2]))
    writeFileSync(join(root, "browser", "LICENSE"), "Copyright text")
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({
        executable: "browser/chrome-headless-shell",
        executableSha256: "upstream",
      })
    )
    const commands: string[][] = []
    expect(() =>
      signPreviewRuntime(root, {
        release: true,
        run: (cmd) => commands.push(cmd),
      })
    ).toThrow("APPLE_SIGNING_IDENTITY")
    expect(commands).toHaveLength(0)
    signPreviewRuntime(root, {
      release: true,
      identity: "Developer ID Application: Test (ABC)",
      run: (cmd) => commands.push(cmd),
    })
    const signs = commands.filter((cmd) => cmd.includes("--force"))
    expect(signs.map((cmd) => cmd.at(-1))).toEqual([library, executable])
    expect(
      signs.every((cmd) =>
        cmd.includes("--preserve-metadata=entitlements,flags")
      )
    ).toBe(true)
    expect(signs.every((cmd) => !cmd.includes("--entitlements"))).toBe(true)
    const manifest = JSON.parse(
      readFileSync(join(root, "manifest.json"), "utf8")
    )
    expect(manifest.upstreamExecutableSha256).toBe("upstream")
    expect(manifest.executableSha256).toMatch(/^[a-f0-9]{64}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
