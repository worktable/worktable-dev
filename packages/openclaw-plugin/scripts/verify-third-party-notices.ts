import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, parse } from "node:path"

const root = join(import.meta.dir, "..")
const notices = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8")
const bundledPackages = new Set<string>()
const metafile = JSON.parse(
  await readFile(join(root, "artifacts/bundle-metafile.json"), "utf8")
) as { inputs?: Record<string, unknown> }

for (const path of Object.keys(metafile.inputs ?? {})) {
  for (const match of path.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)) {
    if (match[1]) bundledPackages.add(match[1])
  }
}

if (bundledPackages.size === 0)
  throw new Error("Could not identify bundled third-party packages")

function packageManifestPath(name: string): string {
  const resolved = Bun.resolveSync(`${name}/package.json`, root)
  let directory = dirname(resolved)
  const filesystemRoot = parse(directory).root
  while (directory !== filesystemRoot) {
    const candidate = join(directory, "package.json")
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: unknown
      }
      if (manifest.name === name) return candidate
    }
    directory = dirname(directory)
  }
  throw new Error(`Could not resolve package metadata for ${name}`)
}

for (const name of [...bundledPackages].sort()) {
  const pkg = (await Bun.file(packageManifestPath(name)).json()) as {
    version?: unknown
    license?: unknown
  }
  if (typeof pkg.version !== "string" || typeof pkg.license !== "string")
    throw new Error(`Bundled package ${name} has incomplete license metadata`)
  if (!notices.includes(`\`${name}\` ${pkg.version}`))
    throw new Error(
      `THIRD_PARTY_NOTICES.md is missing ${name} ${pkg.version} (${pkg.license})`
    )
}

console.log(
  `Verified notices for ${bundledPackages.size} bundled third-party packages`
)
