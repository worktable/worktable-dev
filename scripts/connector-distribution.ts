import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expectedConnectorThirdPartyNotices } from "../packages/mcp-connect/scripts/mcpb-notices.ts"
import {
  resolveSourceMetadata,
  verifyPublicSourceMetadata,
  type SourceMetadata,
} from "./release-source.ts"

// Detached downloads cannot rely on the surrounding application tarball for
// their license or source identity. Private builds remain private.
export function connectorLicenseFiles(
  root: string,
  source?: SourceMetadata
): Record<string, string> {
  const license = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8")
  ).license
  if (license !== "AGPL-3.0-only") {
    if (source?.sourceVisibility === "public")
      throw new Error("Public connector requires AGPL source")
    return {}
  }
  if (source) verifyPublicSourceMetadata(source)
  return {
    LICENSE: readFileSync(join(root, "LICENSE"), "utf8"),
    NOTICE: `Worktable agent connector\nCopyright (c) 2026 Reva Labs\n\nFirst-party code: AGPL-3.0-only. See LICENSE.\nThird-party code retains its own notices and terms.\n${source ? `Corresponding source, including build scripts and dependency lockfile:\n${source.sourceUrl}` : "Development build, without a captured release source identity.\nThe operator must provide the corresponding source for this build."}\n\nThis JavaScript download does not bundle a JavaScript runtime.\n`,
    ...(source
      ? { "SOURCE.json": `${JSON.stringify(source, null, 2)}\n` }
      : {}),
  }
}

// Ordinary source development may be dirty and must not claim a release SHA.
// Release builds supply explicit identity; partial overrides still fail closed.
export function connectorBuildSource(root: string): SourceMetadata | undefined {
  return [
    "WORKTABLE_PUBLIC_SOURCE_REPOSITORY",
    "WORKTABLE_PUBLIC_SOURCE_COMMIT",
    "WORKTABLE_PUBLIC_SOURCE_TAG",
  ].some((key) => process.env[key] !== undefined)
    ? resolveSourceMetadata(root)
    : undefined
}

export function connectorLicenseBanner(files: Record<string, string>): string {
  // Line comments preserve notice text without treating a license's */ as code.
  return Object.entries(files)
    .map(
      ([name, content]) =>
        `// Worktable distribution: ${name}\n${content
          .split("\n")
          .map((line) => `// ${line}`)
          .join("\n")}\n`
    )
    .join("")
}

export function writeConnectorLicenseFiles(
  root: string,
  destination: string,
  source?: SourceMetadata
): void {
  for (const [name, content] of Object.entries(
    connectorLicenseFiles(root, source)
  ))
    writeFileSync(join(destination, name), content)
}

export function verifyConnectorDistribution(
  root: string,
  artifact: string,
  source: SourceMetadata
): void {
  const files = {
    ...connectorLicenseFiles(root, source),
    "THIRD_PARTY_NOTICES.md": expectedConnectorThirdPartyNotices(
      artifact.endsWith(".mcpb") ? "mcpb" : "connector"
    ),
  }
  if (artifact.endsWith(".mcpb")) {
    for (const [name, expected] of Object.entries(files)) {
      const result = Bun.spawnSync(["unzip", "-p", artifact, name], {
        stdout: "pipe",
        stderr: "pipe",
      })
      if (!result.success || result.stdout.toString() !== expected)
        throw new Error(`Detached MCPB notice missing or changed: ${name}`)
    }
  } else if (
    !readFileSync(artifact, "utf8").startsWith(connectorLicenseBanner(files))
  ) {
    throw new Error(
      "Detached connector license or source identity missing or changed"
    )
  }
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..")
  verifyConnectorDistribution(
    root,
    process.argv[2]!,
    resolveSourceMetadata(root)
  )
}
