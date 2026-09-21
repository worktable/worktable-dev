import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const stableVersionPattern = /^\d+\.\d+\.\d+$/
const rfc3339Pattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const updaterArchiveName = "worktable-desktop-darwin-arm64.app.tar.gz"
const minisignPublicKeyLength = 42
const minisignSignatureLength = 74
const ed25519SubjectPublicKeyPrefix = Buffer.from(
  "302a300506032b6570032100",
  "hex"
)

interface PublicDesktopUpdaterFeed {
  version?: unknown
  notes?: unknown
  pub_date?: unknown
  platforms?: unknown
}

export function validatePublicDesktopUpdaterFeed(
  value: unknown,
  expectedTag: string,
  detachedSignature: string
): void {
  if (!/^v\d+\.\d+\.\d+$/.test(expectedTag)) {
    throw new Error(`Expected release tag is invalid: ${expectedTag}`)
  }
  const expectedVersion = expectedTag.slice(1)
  if (!stableVersionPattern.test(expectedVersion)) {
    throw new Error(`Expected release version is invalid: ${expectedVersion}`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Desktop updater feed is not a JSON object")
  }
  const feed = value as PublicDesktopUpdaterFeed
  if (feed.version !== expectedVersion) {
    throw new Error(
      `Desktop updater feed version ${String(feed.version)} does not match ${expectedVersion}`
    )
  }
  if (typeof feed.notes !== "string" || !feed.notes.trim()) {
    throw new Error("Desktop updater feed release notes are empty")
  }
  if (
    typeof feed.pub_date !== "string" ||
    !rfc3339Pattern.test(feed.pub_date) ||
    Number.isNaN(Date.parse(feed.pub_date))
  ) {
    throw new Error("Desktop updater feed publication date is not RFC3339")
  }
  if (
    !feed.platforms ||
    typeof feed.platforms !== "object" ||
    Array.isArray(feed.platforms)
  ) {
    throw new Error("Desktop updater feed platforms are missing")
  }
  const platformMap = feed.platforms as Record<string, unknown>
  if (
    Object.keys(platformMap).length !== 1 ||
    !Object.hasOwn(platformMap, "darwin-aarch64")
  ) {
    throw new Error("Desktop updater feed must contain only darwin-aarch64")
  }
  const platform = platformMap["darwin-aarch64"]
  if (!platform || typeof platform !== "object" || Array.isArray(platform)) {
    throw new Error("Desktop updater feed darwin-aarch64 entry is invalid")
  }
  const record = platform as Record<string, unknown>
  if (record.signature !== detachedSignature.trim()) {
    throw new Error(
      "Desktop updater feed signature does not match the public detached signature"
    )
  }
  const expectedUrl = `https://worktable.dev/releases/${expectedTag}/${updaterArchiveName}`
  if (record.url !== expectedUrl) {
    throw new Error(
      `Desktop updater feed URL does not match the immutable versioned asset: ${String(record.url)}`
    )
  }
}

export function validatePublicDesktopUpdaterArchive(
  archive: Uint8Array,
  checksums: string,
  encodedSignature: string,
  encodedPublicKey: string
): void {
  if (archive.byteLength === 0) {
    throw new Error("Public Desktop updater archive is empty")
  }
  const checksumPattern = new RegExp(
    `^([a-fA-F0-9]{64})[\\t ]+\\*?${updaterArchiveName.replaceAll(".", "\\.")}$`
  )
  const matches = checksums
    .split(/\r?\n/)
    .map((line) => checksumPattern.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
  if (matches.length !== 1) {
    throw new Error(
      `Release checksums must contain exactly one ${updaterArchiveName} entry`
    )
  }
  const expected = matches[0][1].toLowerCase()
  const actual = createHash("sha256").update(archive).digest("hex")
  if (actual !== expected) {
    throw new Error(
      `Public Desktop updater archive SHA-256 ${actual} does not match release checksum ${expected}`
    )
  }
  verifyTauriUpdaterSignature(archive, encodedSignature, encodedPublicKey)
}

function decodeBase64(value: string, description: string): Buffer {
  const normalized = value.trim()
  if (
    !normalized ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) ||
    normalized.length % 4 !== 0
  ) {
    throw new Error(`${description} is not valid base64`)
  }
  const decoded = Buffer.from(normalized, "base64")
  if (
    decoded.toString("base64").replace(/=+$/, "") !==
    normalized.replace(/=+$/, "")
  ) {
    throw new Error(`${description} is not canonical base64`)
  }
  return decoded
}

function decodeDocument(
  encodedDocument: string,
  expectedLineCount: number,
  description: string
): string[] {
  const document = decodeBase64(encodedDocument, description).toString("utf8")
  const lines = document.replace(/\r?\n$/, "").split(/\r?\n/)
  if (lines.length !== expectedLineCount) {
    throw new Error(`${description} has an invalid Minisign document shape`)
  }
  return lines
}

export function verifyTauriUpdaterSignature(
  archive: Uint8Array,
  encodedSignature: string,
  encodedPublicKey: string
): void {
  const publicKeyLines = decodeDocument(
    encodedPublicKey,
    2,
    "Desktop updater public key"
  )
  const signatureLines = decodeDocument(
    encodedSignature,
    4,
    "Desktop updater signature"
  )
  const publicKeyRecord = decodeBase64(
    publicKeyLines[1],
    "Minisign public key record"
  )
  const signatureRecord = decodeBase64(
    signatureLines[1],
    "Minisign signature record"
  )
  const globalSignature = decodeBase64(
    signatureLines[3],
    "Minisign global signature"
  )
  if (publicKeyRecord.byteLength !== minisignPublicKeyLength) {
    throw new Error("Minisign public key record has an invalid length")
  }
  if (signatureRecord.byteLength !== minisignSignatureLength) {
    throw new Error("Minisign signature record has an invalid length")
  }
  if (globalSignature.byteLength !== 64) {
    throw new Error("Minisign global signature has an invalid length")
  }
  const publicAlgorithm = publicKeyRecord.subarray(0, 2).toString("ascii")
  const signatureAlgorithm = signatureRecord.subarray(0, 2).toString("ascii")
  if (
    !["Ed", "ED"].includes(publicAlgorithm) ||
    !["Ed", "ED"].includes(signatureAlgorithm)
  ) {
    throw new Error("Desktop updater signature uses an unsupported algorithm")
  }
  const publicKeyId = publicKeyRecord.subarray(2, 10)
  const signatureKeyId = signatureRecord.subarray(2, 10)
  if (!publicKeyId.equals(signatureKeyId)) {
    throw new Error("Desktop updater signature key ID does not match")
  }
  const trustedCommentPrefix = "trusted comment: "
  if (!signatureLines[2].startsWith(trustedCommentPrefix)) {
    throw new Error("Desktop updater signature has no trusted comment")
  }

  const rawPublicKey = publicKeyRecord.subarray(10)
  const publicKey = createPublicKey({
    key: Buffer.concat([ed25519SubjectPublicKeyPrefix, rawPublicKey]),
    format: "der",
    type: "spki",
  })
  const detachedSignature = signatureRecord.subarray(10)
  const archivePayload =
    signatureAlgorithm === "ED"
      ? createHash("blake2b512").update(archive).digest()
      : archive
  if (!verifySignature(null, archivePayload, publicKey, detachedSignature)) {
    throw new Error(
      "Public Desktop updater archive does not match its detached signature"
    )
  }

  const trustedComment = signatureLines[2].slice(trustedCommentPrefix.length)
  const globalPayload = Buffer.concat([
    detachedSignature,
    Buffer.from(trustedComment, "utf8"),
  ])
  if (!verifySignature(null, globalPayload, publicKey, globalSignature)) {
    throw new Error("Desktop updater trusted comment signature is invalid")
  }
}

function readCommittedUpdaterPublicKey(): string {
  const config = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../apps/desktop/src-tauri/tauri.conf.json"),
      "utf8"
    )
  ) as { plugins?: { updater?: { pubkey?: unknown } } }
  const publicKey = config.plugins?.updater?.pubkey
  if (typeof publicKey !== "string" || !publicKey.trim()) {
    throw new Error("Committed Desktop updater public key is missing")
  }
  return publicKey
}

async function fetchRequired(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
  })
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`)
  }
  return response
}

if (import.meta.main) {
  const [feedUrl, expectedTag] = process.argv.slice(2)
  if (!feedUrl || !expectedTag) {
    throw new Error(
      "Usage: bun scripts/verify-public-desktop-updater.ts <feed-url> <vX.Y.Z>"
    )
  }
  const versionedBaseUrl = `https://worktable.dev/releases/${expectedTag}`
  const signatureUrl = `${versionedBaseUrl}/${updaterArchiveName}.sig`
  const archiveUrl = `${versionedBaseUrl}/${updaterArchiveName}`
  const checksumsUrl = `${versionedBaseUrl}/checksums.txt`
  const [feedResponse, signatureResponse, archiveResponse, checksumsResponse] =
    await Promise.all([
      fetchRequired(feedUrl),
      fetchRequired(signatureUrl),
      fetchRequired(archiveUrl),
      fetchRequired(checksumsUrl),
    ])
  const encodedSignature = await signatureResponse.text()
  validatePublicDesktopUpdaterFeed(
    await feedResponse.json(),
    expectedTag,
    encodedSignature
  )
  validatePublicDesktopUpdaterArchive(
    new Uint8Array(await archiveResponse.arrayBuffer()),
    await checksumsResponse.text(),
    encodedSignature,
    readCommittedUpdaterPublicKey()
  )
  console.log(
    `Verified public Desktop updater feed and immutable archive ${feedUrl} for ${expectedTag}`
  )
}
