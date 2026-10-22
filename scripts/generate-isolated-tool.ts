import { buildIsolatedToolAssets } from "./isolated-tool-assets.ts"

const built = await buildIsolatedToolAssets()
const directory = new URL(
  "../packages/ui/src/tool-runtime/generated/",
  import.meta.url
)
const files = [
  ["tool.bundle.js", Buffer.from(built.source)],
  ["tool.bundle.js.gz", built.gzip],
  [
    "manifest.json",
    Buffer.from(JSON.stringify(built.manifest, null, 2) + "\n"),
  ],
] as const
for (const [name, bytes] of files) {
  const destination = new URL(name, directory)
  if (process.argv.includes("--check")) {
    if (!Buffer.from(await Bun.file(destination).arrayBuffer()).equals(bytes))
      throw new Error(
        "Tool assets are stale; run bun scripts/generate-isolated-tool.ts"
      )
  } else await Bun.write(destination, bytes)
}
