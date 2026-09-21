import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import inventory from "./licenses/bun-runtime-inventory.json" with { type: "json" }

const noticeFile = "bun-runtime-NOTICES.md"
const metadataFile = "bun-runtime.json"
const standardLibraryFile = inventory.standardLibrary.file
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

export interface BunRuntimeIdentity {
  version: string
  revision: string
}

export function assertReviewedBunRuntime(runtime: BunRuntimeIdentity): void {
  if (
    runtime.version !== inventory.runtime.version ||
    runtime.revision !== inventory.runtime.sourceCommit
  )
    throw new Error("Review the bundled Bun runtime version and notices")
}

function noticeBytes(): Buffer {
  let text = "# Bundled Bun runtime notices\n\n"
  text += `Bun ${inventory.runtime.version}, source commit ${inventory.runtime.sourceCommit}.\n\n`
  text +=
    "Worktable and its application dependencies have separate license terms. " +
    "The upstream notices below retain their own scope; conservatively retained source notices may cover code absent from some targets. " +
    "These notices do not replace corresponding-source and rebuild materials.\n\n"
  text += `Bun's Rust standard-library notices are retained in [${standardLibraryFile}](${standardLibraryFile}).\n\n`
  const notices: Record<string, string> = inventory.noticeTexts
  for (const component of inventory.components) {
    text += `## ${component.key}\n\n${component.source}\n\n${component.basis}\n\n`
    for (const notice of component.notices) {
      const value = notices[notice.sha256]
      if (!value || sha256(Buffer.from(value)) !== notice.sha256)
        throw new Error(`Reviewed Bun notice changed: ${component.key}`)
      text += `### ${notice.path}\n\n\`\`\`text\n${value}\n\`\`\`\n\n`
    }
  }
  return Buffer.from(text)
}

function standardLibraryBytes(): Buffer {
  const bytes = readFileSync(
    join(import.meta.dir, "licenses", standardLibraryFile)
  )
  if (sha256(bytes) !== inventory.standardLibrary.sha256)
    throw new Error("Reviewed Bun Rust standard-library notice changed")
  return bytes
}

function metadata() {
  return {
    schemaVersion: 1,
    runtime: inventory.runtime.name,
    version: inventory.runtime.version,
    sourceCommit: inventory.runtime.sourceCommit,
  }
}

export function writeBunRuntimeNotices(
  runtime: BunRuntimeIdentity,
  target: string,
  destination: string
): void {
  assertReviewedBunRuntime(runtime)
  if (!inventory.targets.includes(target))
    throw new Error(`Unreviewed Bun runtime target: ${target}`)
  const record = metadata()
  const notices = noticeBytes()
  const standardLibrary = standardLibraryBytes()
  const directory = join(destination, "licenses")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, noticeFile), notices)
  writeFileSync(join(directory, standardLibraryFile), standardLibrary)
  // Publish identities only; local audit/build paths never enter the record.
  writeFileSync(
    join(directory, metadataFile),
    JSON.stringify(record, null, 2) + "\n"
  )
}

export function verifyBunRuntimeNotices(destination: string): number {
  const directory = join(destination, "licenses")
  const record = JSON.parse(readFileSync(join(directory, metadataFile), "utf8"))
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error("Invalid bundled Bun runtime metadata")
  const expected = metadata()
  if (
    Object.keys(record).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => record[key] !== value)
  )
    throw new Error(
      "Bundled Bun runtime metadata differs from reviewed identities"
    )
  if (!readFileSync(join(directory, noticeFile)).equals(noticeBytes()))
    throw new Error("Bundled Bun notices differ from reviewed sources")
  if (
    !readFileSync(join(directory, standardLibraryFile)).equals(
      standardLibraryBytes()
    )
  )
    throw new Error("Bundled Bun Rust notice differs from reviewed source")
  return 3
}
