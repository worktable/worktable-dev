import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  verifyPublicArchiveWithCache,
  validatePublicDesktopUpdaterArchive,
  validatePublicDesktopUpdaterFeed,
  verifyTauriUpdaterSignature,
} from "./verify-public-desktop-updater"

const publicKeyDocument =
  "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"
const signatureDocument =
  "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA=="
const prehashedSignatureDocument =
  "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg=="
const encodedPublicKey = Buffer.from(publicKeyDocument).toString("base64")
const encodedSignature = Buffer.from(signatureDocument).toString("base64")
const encodedPrehashedSignature = Buffer.from(
  prehashedSignatureDocument
).toString("base64")

const validFeed = {
  version: "0.0.46",
  notes: "Native Worktable Cloud.",
  pub_date: "2026-07-29T12:34:56.000Z",
  platforms: {
    "darwin-aarch64": {
      signature: "signed",
      url: "https://worktable.dev/releases/v0.0.46/worktable-desktop-darwin-arm64.app.tar.gz",
    },
  },
}

describe("public Desktop updater feed verification", () => {
  test("accepts the exact immutable release and detached signature", () => {
    expect(() =>
      validatePublicDesktopUpdaterFeed(validFeed, "v0.0.46", "signed\n")
    ).not.toThrow()
  })

  test("rejects mutable, cross-version, unsigned, and cross-platform feeds", () => {
    expect(() =>
      validatePublicDesktopUpdaterFeed(null, "v0.0.46", "signed")
    ).toThrow("not a JSON object")
    expect(() =>
      validatePublicDesktopUpdaterFeed(
        { ...validFeed, pub_date: "tomorrow" },
        "v0.0.46",
        "signed"
      )
    ).toThrow("not RFC3339")
    expect(() =>
      validatePublicDesktopUpdaterFeed(
        {
          ...validFeed,
          platforms: {
            "darwin-aarch64": {
              ...validFeed.platforms["darwin-aarch64"],
              url: "https://worktable.dev/releases/latest/worktable-desktop-darwin-arm64.app.tar.gz",
            },
          },
        },
        "v0.0.46",
        "signed"
      )
    ).toThrow("immutable versioned asset")
    expect(() =>
      validatePublicDesktopUpdaterFeed(validFeed, "v0.0.45", "signed")
    ).toThrow("does not match")
    expect(() =>
      validatePublicDesktopUpdaterFeed(validFeed, "v0.0.46", "different")
    ).toThrow("does not match")
    expect(() =>
      validatePublicDesktopUpdaterFeed(
        {
          ...validFeed,
          platforms: {
            ...validFeed.platforms,
            "darwin-x86_64": {},
          },
        },
        "v0.0.46",
        "signed"
      )
    ).toThrow("only darwin-aarch64")
  })

  test("requires the publicly served archive bytes to match the release checksum", () => {
    const archive = new TextEncoder().encode("test")
    const checksums = [
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  worktable-desktop-darwin-arm64.app.tar.gz",
      "0".repeat(64) + "  another-asset",
    ].join("\n")
    expect(() =>
      validatePublicDesktopUpdaterArchive(
        archive,
        checksums,
        encodedSignature,
        encodedPublicKey
      )
    ).not.toThrow()
    expect(() =>
      validatePublicDesktopUpdaterArchive(
        new TextEncoder().encode("truncated"),
        checksums,
        encodedSignature,
        encodedPublicKey
      )
    ).toThrow("does not match release checksum")
    expect(() =>
      validatePublicDesktopUpdaterArchive(
        archive,
        "missing",
        encodedSignature,
        encodedPublicKey
      )
    ).toThrow("exactly one")
    expect(() =>
      validatePublicDesktopUpdaterArchive(
        archive,
        `${checksums}\n${checksums.split("\n")[0]}`,
        encodedSignature,
        encodedPublicKey
      )
    ).toThrow("exactly one")
    expect(() =>
      validatePublicDesktopUpdaterArchive(
        new Uint8Array(),
        checksums,
        encodedSignature,
        encodedPublicKey
      )
    ).toThrow("archive is empty")
  })

  test("cryptographically binds Tauri's encoded Minisign documents", () => {
    expect(() =>
      verifyTauriUpdaterSignature(
        new TextEncoder().encode("test"),
        encodedSignature,
        encodedPublicKey
      )
    ).not.toThrow()
    expect(() =>
      verifyTauriUpdaterSignature(
        new TextEncoder().encode("test"),
        encodedPrehashedSignature,
        encodedPublicKey
      )
    ).not.toThrow()
    expect(() =>
      verifyTauriUpdaterSignature(
        new TextEncoder().encode("tampered"),
        encodedSignature,
        encodedPublicKey
      )
    ).toThrow("does not match its detached signature")
    expect(() =>
      verifyTauriUpdaterSignature(
        new TextEncoder().encode("test"),
        Buffer.from(
          signatureDocument.replace("file:test", "file:other")
        ).toString("base64"),
        encodedPublicKey
      )
    ).toThrow("trusted comment signature is invalid")
  })
})

test("reuses only checksum-and-signature-verified immutable archive bytes and repairs corrupt cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktable-updater-proof-"))
  let downloads = 0
  const options = {
    checksums:
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  worktable-desktop-darwin-arm64.app.tar.gz",
    signature: encodedSignature,
    publicKey: encodedPublicKey,
    cacheDirectory: root,
    download: async () => {
      downloads++
      return new TextEncoder().encode("test")
    },
  }
  try {
    await verifyPublicArchiveWithCache(options)
    await verifyPublicArchiveWithCache(options)
    expect(downloads).toBe(1)
    writeFileSync(join(root, readdirSync(root)[0]!), "corrupted")
    await verifyPublicArchiveWithCache(options)
    expect(downloads).toBe(2)
    await expect(
      verifyPublicArchiveWithCache({ ...options, signature: "invalid" })
    ).rejects.toThrow()
    expect(downloads).toBe(3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
