import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import inventory from "./licenses/native-rust-inventory.json" with { type: "json" }

export interface CargoMetadata {
  packages: Array<{
    id: string
    name: string
    version: string
    source: string | null
    license: string | null
    manifest_path: string
  }>
  resolve: {
    root: string
    nodes: Array<{
      id: string
      deps: Array<{ pkg: string; dep_kinds: Array<{ kind: string | null }> }>
    }>
  }
}

const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin"]
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")
const noticeFile = "native-rust-NOTICES.md"
const inventoryFile = "native-rust.json"
const standardLibraryFile = "rust-standard-library-COPYRIGHT.html"

export interface RustNoticeToolchain {
  sysroot: string
  verboseVersion: string
}

function standardLibraryNotice(): Buffer {
  const bytes = readFileSync(
    join(import.meta.dir, "licenses", inventory.standardLibrary.file)
  )
  if (sha256(bytes) !== inventory.standardLibrary.sha256)
    throw new Error("The reviewed Rust standard-library notice changed")
  return bytes
}

function render(keys: string[], roots?: Map<string, string>): string {
  let text = "# Desktop Rust dependency notices\n\n"
  text +=
    "These notices cover the native host's normal dependency closure, including its procedural macros. "
  text +=
    "The application, bundled JavaScript, fonts and Bun runtime have separate license terms.\n\n"
  text += `Rust ${inventory.standardLibrary.version} standard-library notices are retained in [${standardLibraryFile}](${standardLibraryFile}).\n\n`
  for (const key of keys) {
    const reviewed = inventory.packages.find(
      (entry) => `${entry.name}@${entry.version}` === key
    )
    if (!reviewed)
      throw new Error(`Review the native dependency notice for ${key}`)
    text += `## ${reviewed.name} ${reviewed.version}\n\n`
    if ("selectedLicense" in reviewed)
      text += `License option used: ${reviewed.selectedLicense}.\n\n`
    for (const notice of reviewed.notices) {
      const bytes = Buffer.from(notice.text)
      if (sha256(bytes) !== notice.sha256)
        throw new Error(`The reviewed native notice changed for ${key}`)
      const root = roots?.get(key)
      if (
        root &&
        "file" in notice &&
        sha256(readFileSync(join(root, notice.file!))) !== notice.sha256
      )
        throw new Error(`The installed native notice changed for ${key}`)
      text += `${notice.text}\n\n`
    }
    if ("source" in reviewed) {
      text += `Source for this MPL-2.0 component is available under MPL-2.0 at ${reviewed.source!.url}.\n`
      text += `Source archive SHA256: ${reviewed.source!.sha256}\n\n`
    }
  }
  return text
}

export function writeNativeNotices(
  metadata: CargoMetadata,
  lockfile: string,
  target: string,
  destination: string,
  toolchain: RustNoticeToolchain
): void {
  if (!targets.includes(target))
    throw new Error(`Unreviewed native target: ${target}`)
  if (
    toolchain.verboseVersion.match(/^release: (.+)$/m)?.[1] !==
      inventory.standardLibrary.version ||
    toolchain.verboseVersion.match(/^commit-hash: (.+)$/m)?.[1] !==
      inventory.standardLibrary.commit
  )
    throw new Error("Review the Rust standard-library version")
  const standardNotice = standardLibraryNotice()
  if (
    sha256(
      readFileSync(
        join(toolchain.sysroot, "share/doc/rust/COPYRIGHT-library.html")
      )
    ) !== inventory.standardLibrary.sha256
  )
    throw new Error("The installed Rust standard-library notice changed")
  const lock = Bun.TOML.parse(lockfile) as {
    package: Array<{
      name: string
      version: string
      source?: string
      checksum?: string
    }>
  }
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  const pending = [metadata.resolve.root]
  const roots = new Map<string, string>()
  while (pending.length) {
    const id = pending.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = nodes.get(id)
    const pkg = metadata.packages.find((entry) => entry.id === id)
    if (!node || !pkg) throw new Error("Incomplete native dependency metadata")
    for (const dependency of node.deps) {
      if (dependency.dep_kinds.some((kind) => kind.kind === null))
        pending.push(dependency.pkg)
    }
    if (id === metadata.resolve.root) continue
    const key = `${pkg.name}@${pkg.version}`
    const reviewed = inventory.packages.find(
      (entry) => `${entry.name}@${entry.version}` === key
    )
    const locked = lock.package.find(
      (entry) =>
        entry.name === pkg.name &&
        entry.version === pkg.version &&
        entry.source === pkg.source
    )
    if (
      !pkg.source?.startsWith("registry+") ||
      !reviewed ||
      pkg.license !== reviewed.license ||
      locked?.checksum !== reviewed.crateSha256
    )
      throw new Error(`Review the native dependency source/license for ${key}`)
    const root = dirname(pkg.manifest_path)
    render([key], new Map([[key, root]]))
    roots.set(key, root)
  }
  const keys = [...roots.keys()].sort()
  if (!keys.length) throw new Error("No native dependencies identified")
  const notices = render(keys, roots)
  const directory = join(destination, "licenses")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, noticeFile), notices)
  writeFileSync(join(directory, standardLibraryFile), standardNotice)
  // Cargo metadata contains local source paths; publish identities only.
  writeFileSync(
    join(directory, inventoryFile),
    JSON.stringify(
      {
        schemaVersion: 1,
        target,
        rustVersion: inventory.standardLibrary.version,
        packages: keys,
      },
      null,
      2
    ) + "\n"
  )
}

export function verifyNativeNotices(destination: string, target: string): void {
  const directory = join(destination, "licenses")
  const record = JSON.parse(
    readFileSync(join(directory, inventoryFile), "utf8")
  )
  if (
    record.schemaVersion !== 1 ||
    !targets.includes(target) ||
    record.target !== target ||
    record.rustVersion !== inventory.standardLibrary.version ||
    Object.keys(record).some(
      (key) =>
        !["schemaVersion", "target", "rustVersion", "packages"].includes(key)
    ) ||
    !Array.isArray(record.packages) ||
    !record.packages.length ||
    record.packages.some((key: unknown) => typeof key !== "string") ||
    new Set(record.packages).size !== record.packages.length
  )
    throw new Error("Invalid native notice inventory")
  if (
    readFileSync(join(directory, noticeFile), "utf8") !==
    render(record.packages)
  )
    throw new Error("Native notices differ from reviewed sources")
  if (
    !readFileSync(join(directory, standardLibraryFile)).equals(
      standardLibraryNotice()
    )
  )
    throw new Error(
      "Rust standard-library notices differ from reviewed sources"
    )
}
