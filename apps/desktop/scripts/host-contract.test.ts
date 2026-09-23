import { describe, expect, test } from "bun:test"
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { verifyDesktopFonts } from "./verify-fonts"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseRustHostTuple } from "./rust-toolchain"

interface TauriConfig {
  productName: string
  identifier: string
  version: string
  build: { beforeBuildCommand: string }
  app: {
    security: {
      capabilities: string[]
    }
    windows: unknown[]
  }
  bundle: {
    createUpdaterArtifacts?: boolean
    externalBin: string[]
    macOS: {
      minimumSystemVersion: string
      signingIdentity: string
    }
    resources: Record<string, string>
    targets: string[]
  }
  plugins: {
    updater: {
      endpoints: string[]
      pubkey: string
    }
  }
}

interface TauriStagingConfig {
  productName: string
  identifier: string
  version: string
  plugins: {
    updater: null
  }
}

interface Capability {
  identifier: string
  webviews: string[]
  permissions: string[]
  local?: boolean
  remote?: {
    urls: string[]
  }
}

interface ReleaseManifest {
  type: string
  platform: string
  arch: string
  version: string
}

interface DesktopPackage {
  version: string
  scripts: Record<string, string>
}

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(appRoot, "../..")
const nativeRoot = join(appRoot, "src-tauri")
const config = JSON.parse(
  readFileSync(join(nativeRoot, "tauri.conf.json"), "utf8")
) as TauriConfig
const releaseConfig = JSON.parse(
  readFileSync(join(nativeRoot, "tauri.release.conf.json"), "utf8")
) as { bundle: { createUpdaterArtifacts?: boolean } }
const stagingConfig = JSON.parse(
  readFileSync(join(nativeRoot, "tauri.staging.conf.json"), "utf8")
) as TauriStagingConfig
const trustedShellCapability = JSON.parse(
  readFileSync(join(nativeRoot, "capabilities", "trusted-shell.json"), "utf8")
) as Capability
const workspaceChromeCapability = JSON.parse(
  readFileSync(
    join(nativeRoot, "capabilities", "workspace-window-chrome.json"),
    "utf8"
  )
) as Capability
const workspaceAgentSkillsCapability = JSON.parse(
  readFileSync(
    join(nativeRoot, "capabilities", "workspace-agent-skills.json"),
    "utf8"
  )
) as Capability
const desktopPackage = JSON.parse(
  readFileSync(join(appRoot, "package.json"), "utf8")
) as DesktopPackage

function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`Invalid Desktop version: ${version}`)
  return `${match[1]}.${match[2]}.${Number.parseInt(match[3], 10) + 1}`
}

describe("desktop package contracts", () => {
  test("uses one semantically parsed release identity", () => {
    const repoPackage = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8")
    ) as { version: string }
    const cargo = Bun.TOML.parse(
      readFileSync(join(nativeRoot, "Cargo.toml"), "utf8")
    ) as { package: { version: string } }

    expect(config.productName).toBe("Worktable")
    expect(config.identifier).toBe("dev.worktable.desktop")
    expect(config.version).toBe(repoPackage.version)
    expect(desktopPackage.version).toBe(repoPackage.version)
    expect(cargo.package.version).toBe(repoPackage.version)
  })

  test("binds generated native command permissions to their exact surfaces", () => {
    expect(config.app.windows).toEqual([])
    expect(config.app.security.capabilities).toEqual([
      "trusted-shell",
      "workspace-window-chrome",
      "workspace-agent-skills",
    ])
    expect(trustedShellCapability.identifier).toBe("trusted-shell")
    expect(trustedShellCapability.webviews).toEqual(["trusted-shell"])
    expect(new Set(trustedShellCapability.permissions)).toEqual(
      new Set([
        "allow-desktop-shell-identity",
        "allow-desktop-agent-skills-preview",
        "allow-desktop-agent-skills-apply",
        "allow-desktop-bootstrap-state",
        "allow-desktop-updater-state",
        "allow-desktop-mark-shell-ready",
        "allow-desktop-check-for-updates",
        "allow-desktop-install-update",
        "allow-desktop-dismiss-update",
        "allow-desktop-open-update-download",
        "allow-desktop-select-connection-provider",
        "allow-desktop-start-cloud-connection",
        "allow-desktop-cancel-cloud-connection",
        "allow-desktop-start-self-hosted-connection",
        "allow-desktop-start-saved-connection",
        "allow-desktop-choose-workspace-folder",
        "allow-desktop-inspect-workspace",
        "allow-desktop-start-local-connection",
        "allow-desktop-use-existing-installation",
        "allow-desktop-retry-connection",
        "allow-desktop-restart-local-host",
        "allow-desktop-repair-local-authority",
        "allow-desktop-open-local-logs",
        "allow-desktop-change-connection",
        "allow-desktop-cloud-sign-out",
        "allow-desktop-cloud-end-session",
        "allow-desktop-remove-connection",
        "core:window:allow-start-dragging",
      ])
    )
    expect(workspaceChromeCapability.identifier).toBe("workspace-window-chrome")
    expect(workspaceChromeCapability.webviews).toEqual(["workspace"])
    expect(workspaceChromeCapability.local).toBe(false)
    expect(workspaceChromeCapability.remote).toEqual({
      urls: ["http://*:*/*", "https://*:*/*"],
    })
    expect(workspaceChromeCapability.permissions).toEqual([
      "core:window:allow-start-dragging",
    ])
    expect(workspaceAgentSkillsCapability).toMatchObject({
      identifier: "workspace-agent-skills",
      local: false,
      remote: {
        urls: [
          "http://127.0.0.1:*/*",
          "http://localhost:*/*",
          "http://[\\:\\:1]:*/*",
        ],
      },
      webviews: ["workspace"],
      permissions: [
        "allow-desktop-agent-skills-status",
        "allow-desktop-agent-skills-preview",
        "allow-desktop-agent-skills-apply",
      ],
    })
    expect(trustedShellCapability.permissions).not.toContain(
      "allow-desktop-agent-skills-status"
    )
    expect(workspaceChromeCapability.permissions).not.toContain(
      "allow-desktop-agent-skills-status"
    )
  })

  test("keeps sidecar and runtime resources disjoint", () => {
    expect(config.bundle.createUpdaterArtifacts).toBeUndefined()
    expect(config.bundle.externalBin).toEqual(["generated/bin/worktable"])
    expect(config.bundle.resources).toEqual({
      "generated/runtime/worktable/": "worktable-runtime/",
    })
    expect(config.bundle.targets).toEqual(["app"])
    expect(config.bundle.macOS).toEqual({
      minimumSystemVersion: "13.0",
      signingIdentity: "-",
    })
  })

  test("creates signed updater artifacts only in protected release builds", () => {
    expect(releaseConfig).toEqual({
      bundle: { createUpdaterArtifacts: true },
      $schema: "https://schema.tauri.app/config/2",
    })
  })

  test("builds staging as a separate non-updating application", () => {
    expect(stagingConfig).toMatchObject({
      productName: "Worktable Staging",
      identifier: "dev.worktable.desktop.staging",
      plugins: { updater: null },
    })
    expect([config.version, nextPatchVersion(config.version)]).toContain(
      stagingConfig.version
    )
    expect(config.identifier).not.toContain("staging")
    expect(config.productName).toBe("Worktable")
  })

  test("requires signed updates from the stable immutable release surface", () => {
    expect(config.plugins.updater.endpoints).toEqual([
      "https://worktable.dev/releases/latest/desktop-updater.json",
    ])
    expect(config.plugins.updater.pubkey.trim()).not.toBe("")
    expect(config.plugins.updater.pubkey).not.toContain("REQUIRED")
  })

  test("packaging requires a separately supplied General Sans font", () => {
    const root = mkdtempSync(join(tmpdir(), "worktable-desktop-fonts-"))
    try {
      for (const name of [
        "fraunces-variable-latin.woff2",
        "jetbrains-mono-variable-latin.woff2",
      ]) {
        copyFileSync(join(appRoot, "ui/fonts", name), join(root, name))
      }
      expect(() => verifyDesktopFonts(root)).toThrow(
        "Missing Desktop font general-sans-variable.woff2"
      )
      const generalSans = join(root, "general-sans-variable.woff2")
      writeFileSync(generalSans, "")
      expect(() => verifyDesktopFonts(root)).toThrow("Invalid Desktop WOFF2")
      // A real open-licensed WOFF2 exercises the packaging format contract
      // without requiring the proprietary font in the public test checkout.
      copyFileSync(join(root, "fraunces-variable-latin.woff2"), generalSans)
      expect(() => verifyDesktopFonts(root)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("desktop Rust toolchain compatibility", () => {
  test("parses the host tuple from rustc verbose output", () => {
    expect(
      parseRustHostTuple(`rustc 1.77.2
binary: rustc
commit-hash: unknown
host: aarch64-apple-darwin
release: 1.77.2`)
    ).toBe("aarch64-apple-darwin")
    expect(parseRustHostTuple("rustc 1.77.2\nrelease: 1.77.2")).toBeNull()
  })
})

const generatedRoot = join(nativeRoot, "generated")
const runtimeRoot = join(generatedRoot, "runtime", "worktable")
const describePreparedRuntime =
  process.platform === "darwin" &&
  existsSync(join(runtimeRoot, "manifest.json"))
    ? describe
    : describe.skip

describePreparedRuntime("prepared packaged runtime", () => {
  const hostTuple =
    process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  const expectedArch = process.arch === "arm64" ? "arm64" : "x64"

  test("contains a target-suffixed executable sidecar", () => {
    const binary = join(generatedRoot, "bin", `worktable-${hostTuple}`)
    expect(existsSync(binary)).toBe(true)
    expect(statSync(binary).isFile()).toBe(true)
    expect(statSync(binary).mode & 0o111).not.toBe(0)
  })

  test("contains a matching release manifest and browser runtime", () => {
    const manifest = JSON.parse(
      readFileSync(join(runtimeRoot, "manifest.json"), "utf8")
    ) as ReleaseManifest
    const repoPackage = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8")
    ) as { version: string }
    expect(manifest).toMatchObject({
      type: "worktable.release",
      platform: "darwin",
      arch: expectedArch,
      version: repoPackage.version,
    })
    expect(existsSync(join(runtimeRoot, "web", "_shell.html"))).toBe(true)
    expect(existsSync(join(runtimeRoot, "connector", "connect.mjs"))).toBe(true)
  })
})
