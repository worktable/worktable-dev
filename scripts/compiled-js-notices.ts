import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  contributingPackages,
  renderDependencyNotices,
} from "./dependency-notices"

const noticeFile = "bundled-javascript-NOTICES.md"
const inventoryFile = "bundled-javascript.json"

export function writeCompiledJsNotices(
  metafile: Bun.BuildMetafile | readonly Bun.BuildMetafile[],
  buildCwd: string,
  destination: string
): void {
  const metafiles = "outputs" in metafile ? [metafile] : metafile
  const inputs = metafiles.flatMap((file) =>
    Object.values(file.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, contribution]) => contribution.bytesInOutput > 0)
        .map(([input]) => input)
    )
  )
  const packages = contributingPackages(inputs, buildCwd)
  const keys = packages.map((entry) => entry.key)
  const notices = renderDependencyNotices(keys, packages)
  const directory = join(destination, "licenses")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, noticeFile), notices)
  // Ship names/versions only. Build metadata contains local paths and stays private.
  writeFileSync(
    join(directory, inventoryFile),
    JSON.stringify({ schemaVersion: 1, packages: keys }, null, 2) + "\n"
  )
}

export function verifyCompiledJsNotices(destination: string): number {
  const directory = join(destination, "licenses")
  const record = JSON.parse(
    readFileSync(join(directory, inventoryFile), "utf8")
  )
  if (
    record.schemaVersion !== 1 ||
    Object.keys(record).some(
      (key) => key !== "schemaVersion" && key !== "packages"
    ) ||
    !Array.isArray(record.packages) ||
    !record.packages.length ||
    record.packages.some((key: unknown) => typeof key !== "string") ||
    new Set(record.packages).size !== record.packages.length
  )
    throw new Error("Invalid compiled JavaScript notice inventory")
  const expected = renderDependencyNotices(record.packages)
  if (readFileSync(join(directory, noticeFile), "utf8") !== expected)
    throw new Error("Compiled JavaScript notices differ from reviewed sources")
  return 2
}
