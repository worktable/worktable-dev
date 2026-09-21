import { copyFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { verifyCompiledJsNotices } from "./compiled-js-notices.ts"
import {
  assertReviewedBunRuntime,
  verifyBunRuntimeNotices,
} from "./bun-runtime-notices.ts"

// These are the existing notices for identified bundled Worktable components
// and Desktop fonts. Public AGPL builds also retain their root LICENSE/NOTICE;
// the private checkout is not relicensed by this packaging helper.
const appLicenses = ["packages/ui/LICENSE", "packages/hosted-contract/LICENSE"]
const skillLicense = "plugins/worktable/LICENSE"
export const releaseLicenses = {
  cli: [...appLicenses, skillLicense],
  server: appLicenses,
  skills: [skillLicense],
  desktop: [
    ...appLicenses,
    skillLicense,
    "apps/desktop/ui/fonts/Fraunces-OFL.txt",
    "apps/desktop/ui/fonts/JetBrainsMono-OFL.txt",
  ],
} as const
export type ReleaseLicenseKind = keyof typeof releaseLicenses

// This reviewed reference is supplied by the public cutover, not inferred from
// a private runner. Availability and archive bytes are checked before publishing.
function validateSourceMaterials(root: string): void {
  const materials = JSON.parse(
    readFileSync(join(root, "SOURCE-MATERIALS.json"), "utf8")
  )
  const exactKeys = (value: unknown, keys: string[]): boolean =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys.sort().join(",")
  if (
    !exactKeys(materials, ["schemaVersion", "runtime", "sourceArchive"]) ||
    materials.schemaVersion !== 1 ||
    !exactKeys(materials.runtime, ["name", "version", "sourceCommit"]) ||
    materials.runtime.name !== "Bun" ||
    !exactKeys(materials.sourceArchive, ["url", "sha256", "bytes"])
  )
    throw new Error("Invalid runtime source-material reference")
  assertReviewedBunRuntime({
    version: materials.runtime.version,
    revision: materials.runtime.sourceCommit,
  })
  const archive = materials.sourceArchive
  if (
    typeof archive.url !== "string" ||
    typeof archive.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(archive.sha256) ||
    !Number.isSafeInteger(archive.bytes) ||
    archive.bytes <= 0
  )
    throw new Error("Invalid runtime source archive identity")
  const url = new URL(archive.url)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== archive.url
  )
    throw new Error(
      "Runtime source archive requires a durable HTTPS URL without credentials"
    )
}

function sourceNotices(root: string, kind: ReleaseLicenseKind): string[] {
  const applicationLicense = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8")
  ).license
  const publicNotices =
    applicationLicense === "AGPL-3.0-only"
      ? ["LICENSE", "NOTICE", "SOURCE-MATERIALS.json"]
      : []
  if (publicNotices.length) validateSourceMaterials(root)
  return [...publicNotices, ...releaseLicenses[kind]]
}

// Preserve source-relative paths: the UI notice is scoped to named files in
// that package, and must never read as an MIT license for the whole application.
export function copyReleaseLicenses(
  root: string,
  destination: string,
  kind: ReleaseLicenseKind
): void {
  for (const source of sourceNotices(root, kind)) {
    const target = join(destination, "licenses", source)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(root, source), target)
  }
}

export function verifyReleaseLicenses(
  root: string,
  destination: string,
  kind: ReleaseLicenseKind
): number {
  const notices = sourceNotices(root, kind)
  for (const source of notices) {
    const target = join(destination, "licenses", source)
    if (!readFileSync(target).equals(readFileSync(join(root, source)))) {
      throw new Error(`Release notice differs from its source: ${source}`)
    }
  }
  return (
    notices.length +
    verifyCompiledJsNotices(destination) +
    verifyBunRuntimeNotices(destination)
  )
}

if (import.meta.main) {
  const [destination, kind] = process.argv.slice(2)
  if (!destination || !kind || !Object.hasOwn(releaseLicenses, kind)) {
    throw new Error(
      "Usage: release-licenses.ts <extracted-release> <cli|server|skills|desktop>"
    )
  }
  console.log(
    verifyReleaseLicenses(
      join(import.meta.dir, ".."),
      destination,
      kind as ReleaseLicenseKind
    )
  )
}
