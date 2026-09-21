import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import type { SkillPackageFile } from "./skill-package"

const ALLOWED_ROOT_FILES = new Set([
  "package/CHANGELOG.md",
  "package/LICENSE",
  "package/README.md",
  "package/THIRD_PARTY_NOTICES.md",
  "package/openclaw.plugin.json",
  "package/package.json",
])

function tar(args: string[]): string {
  return execFileSync("tar", args, { encoding: "utf8" })
}

function tarBytes(args: string[]): Buffer {
  return execFileSync("tar", args)
}

export function verifyPackedArtifact(
  path: string,
  skillFiles: SkillPackageFile[]
): void {
  const entries = tar(["-tzf", path]).split(/\r?\n/).filter(Boolean).sort()
  const expectedSkills = new Map(
    skillFiles.map((file) => [`package/skills/${file.path}`, file.sha256])
  )

  if (!entries.includes("package/dist/index.js"))
    throw new Error("Packed plugin is missing package/dist/index.js")
  if (!entries.includes("package/dist/setup-entry.js"))
    throw new Error("Packed plugin is missing package/dist/setup-entry.js")

  for (const entry of entries) {
    if (ALLOWED_ROOT_FILES.has(entry)) continue
    if (/^package\/dist\/[a-zA-Z0-9._-]+\.js$/.test(entry)) continue
    if (expectedSkills.has(entry)) continue
    throw new Error(`Unexpected file in packed plugin: ${entry}`)
  }

  for (const [entry, expected] of expectedSkills) {
    if (!entries.includes(entry)) {
      throw new Error(`Packed plugin is missing ${entry}`)
    }
    const actual = createHash("sha256")
      .update(tarBytes(["-xOzf", path, entry]))
      .digest("hex")
    if (actual !== expected) {
      throw new Error(`Packed plugin skill does not match its source: ${entry}`)
    }
  }

  const listing = tar(["-tvzf", path])
  for (const line of listing.split(/\r?\n/).filter(Boolean)) {
    if (!line.startsWith("-"))
      throw new Error(`Packed plugin contains a non-regular entry: ${line}`)
  }

  const bundledJavaScript = entries
    .filter((entry) => entry.startsWith("package/dist/"))
    .map((entry) => tar(["-xOzf", path, entry]))
    .join("\n")
  const forbidden = [
    "@worktable/hosted-contract",
    "workspace:*",
    "sourceMappingURL=",
    "/home/",
    "/Users/",
  ]
  for (const value of forbidden) {
    if (bundledJavaScript.includes(value))
      throw new Error(
        `Packed plugin contains forbidden build content: ${value}`
      )
  }
}
