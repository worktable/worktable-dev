import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import inventory from "./licenses/compiled-js-inventory.json" with { type: "json" }

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")
type PackageLocation = { key: string; root: string; license: string }
type Notice = {
  component?: string
  file?: string
  sourceFile?: string
  sourceSha256?: string
  sha256: string
  text?: string
  separate?: boolean
}

/** The file a separate notice ships as, beside the notices that name it. */
export function separateNoticeName(notice: { file?: string }): string {
  return notice.file!.split("/").pop()!
}

const separateNoticeLine = (notice: Notice) =>
  `See ${separateNoticeName(notice)} in this folder (SHA256 ${notice.sha256}).`

/**
 * The notices of these packages that ship as their own files, by file name,
 * each read from the installed package and checked against its review.
 */
export function separateNotices(
  locations: PackageLocation[]
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  for (const location of locations) {
    const reviewed = inventory.packages.find(
      (entry) => `${entry.name}@${entry.version}` === location.key
    )
    for (const notice of (reviewed?.notices ?? []) as Notice[]) {
      if (!notice.separate) continue
      const bytes = readFileSync(join(location.root, notice.file!))
      if (sha256(bytes) !== notice.sha256)
        throw new Error(
          `The installed bundled dependency notice changed for ${location.key}`
        )
      files.set(separateNoticeName(notice), bytes)
    }
  }
  return files
}

export function contributingPackages(inputs: Iterable<string>, cwd: string) {
  const packages = new Map<string, PackageLocation>()
  const validated = new Set<string>()
  for (const raw of inputs) {
    const input = raw.replace(/^\0/, "").split("?")[0]!
    if (!input.includes("node_modules/")) continue
    let directory = dirname(resolve(cwd, input))
    let found = false
    while (dirname(directory) !== directory) {
      const manifest = join(directory, "package.json")
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"))
        if (pkg.name && pkg.version) {
          const key = `${pkg.name}@${pkg.version}`
          const reviewed = inventory.packages.find(
            (entry) => `${entry.name}@${entry.version}` === key
          )
          if (reviewed && "reviewedInputPrefixes" in reviewed) {
            const subpath = relative(directory, resolve(cwd, input)).replaceAll(
              "\\",
              "/"
            )
            if (
              !(reviewed.reviewedInputPrefixes as string[]).some((prefix) =>
                subpath.startsWith(prefix)
              )
            )
              throw new Error(
                `Review the embedded component notice for ${key}: ${subpath}`
              )
          }
          const location = { key, root: directory, license: pkg.license ?? "" }
          // Validate every installed copy, including duplicate versions in nested dependencies.
          if (!validated.has(directory)) {
            renderDependencyNotices([key], [location])
            validated.add(directory)
          }
          packages.set(key, location)
          found = true
          break
        }
      }
      directory = dirname(directory)
    }
    if (!found)
      throw new Error(`No package metadata for bundled input: ${input}`)
  }
  if (!packages.size) throw new Error("No bundled dependencies identified")
  return [...packages.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export function renderDependencyNotices(
  keys: string[],
  locations?: PackageLocation[]
) {
  let text = "# Bundled JavaScript dependency notices\n\n"
  text +=
    "These notices cover JavaScript and CSS dependencies included in this distribution. "
  text +=
    "The application, fonts, native libraries and runtime have separate license terms.\n\n"
  for (const key of keys) {
    const reviewed = inventory.packages.find(
      (entry) => `${entry.name}@${entry.version}` === key
    )
    if (!reviewed)
      throw new Error(`Review the bundled dependency notice for ${key}`)
    const location = locations?.find((entry) => entry.key === key)
    if (location && location.license !== reviewed.license)
      throw new Error(`The bundled dependency license changed for ${key}`)
    text += `## ${reviewed.name} ${reviewed.version}\n\n`
    for (const notice of reviewed.notices as Notice[]) {
      // A notice too long to keep here ships as its own file beside these;
      // its installed copy is checked against the reviewed hash below.
      const bytes = Buffer.from(
        notice.separate ? separateNoticeLine(notice) : notice.text!
      )
      if (!notice.separate && sha256(bytes) !== notice.sha256)
        throw new Error(
          `The reviewed bundled dependency notice changed for ${key}`
        )
      if (
        location &&
        "file" in notice &&
        sha256(readFileSync(join(location.root, notice.file!))) !==
          notice.sha256
      )
        throw new Error(
          `The installed bundled dependency notice changed for ${key}`
        )
      if (
        location &&
        "sourceFile" in notice &&
        sha256(readFileSync(join(location.root, notice.sourceFile!))) !==
          notice.sourceSha256
      )
        throw new Error(`The installed notice source changed for ${key}`)
      if ("component" in notice) text += `### ${notice.component}\n\n`
      text += `${bytes.toString("utf8")}\n\n`
    }
    if (reviewed.source) {
      text += `Source for this MPL-2.0 component is available under MPL-2.0 at ${reviewed.source.url}.\n`
      text += `Source archive SHA256: ${reviewed.source.sha256}\n\n`
    }
  }
  return text
}
