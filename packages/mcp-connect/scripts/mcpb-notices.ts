import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import inventory from "../mcpb-notice-inventory.json" with { type: "json" }

export type ConnectorArtifact = keyof typeof inventory.artifacts

export function expectedConnectorThirdPartyNotices(
  kind: ConnectorArtifact
): string {
  return (
    "# Third-party notices for the Worktable agent connector\n\n" +
    [...inventory.artifacts[kind]]
      .sort((a, b) => `${a}@`.localeCompare(`${b}@`))
      .map((name) => {
        const reviewed = inventory.packages.find((entry) => entry.name === name)
        if (
          !reviewed ||
          createHash("sha256").update(reviewed.text).digest("hex") !==
            reviewed.sha256
        )
          throw new Error(`Invalid reviewed connector notice: ${name}`)
        return `## ${reviewed.name} ${reviewed.version}\n\n${reviewed.text}\n\n`
      })
      .join("")
  )
}

// The reviewed inventory binds the upstream notice bytes to exact versions.
// An added/upgraded bundled dependency needs a notice review before packaging.
export function connectorThirdPartyNotices(
  metafile: Bun.BuildMetafile,
  buildCwd: string,
  kind: ConnectorArtifact = "mcpb"
): string {
  const packages = new Map<string, { root: string; license: string }>()
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, contribution] of Object.entries(output.inputs)) {
      if (contribution.bytesInOutput === 0 || !input.includes("node_modules/"))
        continue
      let directory = dirname(resolve(buildCwd, input))
      let found = false
      while (dirname(directory) !== directory) {
        const manifest = join(directory, "package.json")
        if (existsSync(manifest)) {
          const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
            name?: string
            version?: string
            license?: string
          }
          // Nested package.json files may only set the module format.
          if (pkg.name && pkg.version) {
            packages.set(`${pkg.name}@${pkg.version}`, {
              root: directory,
              license: pkg.license ?? "",
            })
            found = true
            break
          }
        }
        directory = dirname(directory)
      }
      if (!found)
        throw new Error(`No package metadata for bundled input: ${input}`)
    }
  }
  if (packages.size === 0)
    throw new Error("No connector dependencies identified")

  let notices = "# Third-party notices for the Worktable agent connector\n\n"
  for (const [key, pkg] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const reviewed = inventory.packages.find(
      (entry) => `${entry.name}@${entry.version}` === key
    )
    if (!reviewed || reviewed.license !== pkg.license) {
      throw new Error(`Review the MCPB license and notice for ${key}`)
    }
    const bytes = readFileSync(join(pkg.root, reviewed.file))
    if (createHash("sha256").update(bytes).digest("hex") !== reviewed.sha256) {
      throw new Error(`The reviewed MCPB notice changed for ${key}`)
    }
    notices += `## ${reviewed.name} ${reviewed.version}\n\n${bytes.toString("utf8")}\n\n`
  }
  const expected = expectedConnectorThirdPartyNotices(kind)
  if (notices !== expected)
    throw new Error(
      `Review the changed ${kind} dependency inventory before distribution`
    )
  return notices
}

export function writeMcpbNotices(
  metafile: Bun.BuildMetafile,
  buildCwd: string,
  destination: string
): void {
  writeFileSync(
    join(destination, "THIRD_PARTY_NOTICES.md"),
    connectorThirdPartyNotices(metafile, buildCwd)
  )
}
